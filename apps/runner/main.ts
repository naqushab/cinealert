// CineAlert runner. One run = (Telegram commands) → check every watch → (optionally keep listening).
//   node apps/runner/main.ts [--dry-run] [--only <watchId>]
// Env: FETCHER=cffi, STATE_DIR, BOT_LISTEN_SECONDS, TELEGRAM_*, NTFY_TOPIC, RESEND_API_KEY, EMAIL_*.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  buildNotification, diffWatch, dispatch, emptyState, expandDates, findBestSeats, healthUpdate, parseWatchUrl,
  prettyDate, rankShows, seatSummary, unavailableProvider, emptyCatalog, learn, validateWatch, validationText,
  newDraft, render, onCallback, onText, draftToWatch, isSupportedLink, parseCommand, showMatches, seatLayoutUrl,
} from "../../packages/core/src/index.ts";
import type { Catalog, Change, Command, Draft, SeatLayoutProvider, ShowWatch, Snapshot, State, Watch, WatchTarget } from "../../packages/core/src/index.ts";
import { buildNotifiers, loadConfig } from "./config.ts";
import { pickFetcher } from "./fetchers.ts";
import { runSeatWatch } from "./seatwatch.ts";
import { groupKey, makeClients, snapshotFor } from "./sources.ts";
import { HELP, ack, card, describeWatch, loadBot, pull, reply, saveBot } from "./bot.ts";
import type { Incoming, Tg } from "./bot.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : process.env.ONLY_WATCH || "";
const STATE_DIR = process.env.STATE_DIR || "state";
const STATE_FILE = `${STATE_DIR}/state.json`;
const CATALOG_FILE = `${STATE_DIR}/catalog.json`;
const LISTEN = Number(process.env.BOT_LISTEN_SECONDS || 0);
const RECHECK_MS = Number(process.env.RECHECK_MINUTES || 0) * 60_000;   // re-run checks while listening
const SEAT_MS = Number(process.env.SEAT_RECHECK_MINUTES || 20) * 60_000;  // seat-map reads are heavier: own timer
const log = (s: string) => console.log(s);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function loadState(): Promise<State & { meta?: Record<string, string> }> {
  try { return { ...emptyState(), ...JSON.parse(await readFile(STATE_FILE, "utf8")) }; } catch { return emptyState(); }
}

async function seatChanges(w: ShowWatch, changes: Change[], provider: SeatLayoutProvider): Promise<{ changes: Change[]; note: string }> {
  if (!w.seats) return { changes, note: "" };
  const out: Change[] = [];
  let unavailable = 0;
  const seen = new Set<string>();
  for (const c of changes) {
    if (!c.show) { out.push(c); continue; }
    const k = `${c.show.venueCode}|${c.show.sessionId}|${c.category?.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const map = await provider.get(c.show.venueCode, c.show.sessionId, c.show.eventCode, c.show.dateCode);
    if (!map) {
      unavailable++;
      // Seat-count fallback (District gives exact numbers): require enough seats in the class.
      if (c.category?.seatsAvail === undefined || c.category.seatsAvail >= w.seats.count) out.push(c);
      continue;
    }
    const best = findBestSeats(map, w.seats, 3).filter((p) => p.score >= (w.seats!.minScore ?? 0.6));
    if (best.length) out.push({ ...c, kind: "SEATS_FOUND", detail: best.map(seatSummary).join(" | ") });
  }
  return { changes: out, note: unavailable ? ` (no seat map: matched on seat class/count for ${unavailable})` : "" };
}

async function main() {
  const cfg = await loadConfig();
  const state = await loadState();
  const bot = await loadBot(STATE_DIR);
  let catalog: Catalog = emptyCatalog();
  try { catalog = { ...emptyCatalog(), ...JSON.parse(await readFile(CATALOG_FILE, "utf8")) }; } catch {}
  const notifiers = buildNotifiers(cfg, dryRun);
  const clients = makeClients(pickFetcher(), log);
  const tgToken = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const tg: Tg | null = tgToken && !dryRun ? { token: tgToken, allowed: new Set((process.env.TELEGRAM_CHAT_ID || "").split(",").map((s) => s.trim()).filter(Boolean)) } : null;
  const seatAsWatch = (cfg.seatWatches || []).map((sw) => ({ id: sw.id, type: "movie", label: `💺 ${sw.label || sw.id}`, url: sw.bms, dates: sw.dates, formats: sw.formats,
    cinemas: sw.cinemas.map((c) => c.name || c.bms), enabled: sw.enabled }) as Watch);
  const seatIds = new Set(seatAsWatch.map((w) => w.id));
  const watches = (): Watch[] => [...cfg.watches, ...seatAsWatch, ...bot.watches].map((w) => (bot.paused.includes(w.id) ? { ...w, enabled: false } : w));
  // Every snapshot also teaches the cinema catalogue (cinemas + formats they screen).
  const snapshot = async (t: WatchTarget, dates: string[], formats: string[], lang?: string): Promise<Snapshot> => {
    const snap = await snapshotFor(clients, t, dates, formats, lang);
    if (snap.shows.length) learn(catalog, snap);
    return snap;
  };
  async function validateFor(w: Watch) {
    const t = parseWatchUrl(w.url, w.city);
    let snap: Snapshot | null = null;
    try { snap = await snapshot(t, expandDates(w.dates || []), w.formats || [], w.language); } catch (e) { log(`  validate: ${(e as Error).message}`); }
    return validateWatch(w, snap && (snap.complete || snap.shows.length) ? snap : null, catalog);
  }
  const pick = (w: Watch) => (w.channels?.length ? w.channels.map((n) => notifiers[n]).filter(Boolean) : Object.values(notifiers));

  // ---------------- check cycle ----------------
  async function check(list: Watch[]): Promise<{ ok: boolean; fail: boolean }> {
    const now = new Date();
    const groups = new Map<string, Watch[]>();
    for (const w of list) {
      try { const k = groupKey(w); groups.set(k, [...(groups.get(k) || []), w]); }
      catch (e) { log(`  ${w.id}: skipped (${(e as Error).message})`); }
    }
    let ok = false, fail = false;
    for (const [key, ws] of groups) {
      const t = parseWatchUrl(ws[0].url, ws[0].city);
      const dates = [...new Set(ws.flatMap((w) => expandDates(w.dates || [])))].sort();
      const formats = ws.some((w) => !w.formats?.length) ? [] : [...new Set(ws.flatMap((w) => w.formats!))];
      const snap = await snapshot(t, dates, formats, ws[0].language);
      log(`• ${key}: ${snap.movieName || t.movieSlug} · ${snap.shows.length} shows · ${snap.requests} req${snap.complete ? "" : ` · INCOMPLETE: ${snap.failures.join("; ")}`}`);
      if (!snap.complete) {
        fail = true;
        for (const w of ws) (state.watches[w.id] ||= { dates: [], cats: {} }).lastResult = `partial check, nothing compared (${snap.failures[0] || "no data"})`;
        continue;
      }
      ok = true;
      for (const w of ws) {
        let { changes, next } = diffWatch(w, snap, state.watches[w.id], now);
        let note = "";
        if (w.type === "show") ({ changes, note } = await seatChanges(w, changes, unavailableProvider));
        next.lastResult += note;
        if (!changes.length) { state.watches[w.id] = next; log(`  ${w.id}: ${next.lastResult}`); continue; }
        if (bot.muted[w.id] && Date.parse(bot.muted[w.id]) > Date.now()) { state.watches[w.id] = { ...next, lastResult: next.lastResult + " (snoozed)" }; log(`  ${w.id}: ${changes.length} change(s) skipped (snoozed)`); continue; }
        const n = buildNotification(w, snap.movieName, changes, t.source === "district" ? "District" : "BMS");
        const sent = await dispatch(n, pick(w), log);
        state.watches[w.id] = sent ? next : { ...(state.watches[w.id] || { dates: [], cats: {} }), lastCheckedAt: now.toISOString(), lastResult: "alert delivery failed, will retry" };
        log(`  ${w.id}: ${changes.length} change(s) → ${sent ? "sent" : "NOT sent"}`);
      }
    }
    return { ok, fail };
  }

  // ---------------- telegram commands ----------------
  type Btn = { text: string; data?: string; url?: string };
  type Reply = { text: string; added?: Watch; kb?: Btn[][] };
  const watchName = (w: Watch) => w.label || parseWatchUrl(w.url, w.city).movieSlug;
  const MENU: Btn[] = [{ text: "📋 My watches", data: "a|list" }, { text: "❓ Help", data: "a|help" }];
  const watchButtons = (w: Watch): Btn[] => [
    { text: "🏆 Best now", data: `a|best|${w.id}` },
    w.enabled === false ? { text: "▶️ Resume", data: `a|resume|${w.id}` } : { text: "⏸ Pause", data: `a|pause|${w.id}` },
    ...(bot.watches.some((x) => x.id === w.id) ? [{ text: "🗑 Remove", data: `a|rm|${w.id}` }] : []),
  ];

  /** Ranked shows for an existing watch, using its own preferences. */
  async function bestFor(w: Watch): Promise<Reply> {
    const t = parseWatchUrl(w.url, w.city);
    const dates = expandDates(w.dates || []);
    const snap = await snapshot(t, dates, w.formats || [], w.language);
    const pool = snap.shows.filter((s) => (!dates.length || dates.includes(s.dateCode)) && showMatches(w, s, new Set(dates)));
    return bestReply(snap, t, pool, { seats: w.minSeats, categories: w.categories, formats: w.formats, times: w.times, preferTime: w.type === "show" ? w.time : undefined, maxPrice: w.maxPrice }, w);
  }

  function bestReply(snap: Snapshot, t: WatchTarget, pool: Snapshot["shows"], prefs: Parameters<typeof rankShows>[1], w?: Watch): Reply {
    if (!snap.complete && !snap.shows.length) return { text: `⚠️ Couldn't read ${t.source}: ${esc(snap.failures[0] || "no data")}` };
    const ranked = rankShows(pool, prefs, 5);
    const head = `🏆 <b>Best shows now</b> · ${esc(w ? watchName(w) : snap.movieName || t.movieSlug)}`;
    if (!ranked.length) return { text: `${head}\n\nNothing bookable matches right now. I'll alert you when it does.`, kb: w ? [watchButtons(w)] : [MENU] };
    const link = snap.showLink || ((s: Snapshot["shows"][number]) => seatLayoutUrl(snap.region.slug, s.eventCode, s.venueCode, s.sessionId, s.dateCode));
    const lines = ranked.map((r, i) => `${["🥇", "🥈", "🥉", "4️⃣", "5️⃣"][i]} <b>${prettyDate(r.show.dateCode)} · ${esc(r.show.time.replace(/^0/, ""))}</b>\n      ${esc(r.show.venueName)}\n      <i>${esc([r.show.format, r.show.screenAttr].filter(Boolean).join(" · ").replace(/\bMS[- ]+/gi, ""))}</i>\n      ${["🔴", "🟡", "🟠", "🟢"][r.category.status] || ""} ${esc(r.category.name)} ₹${r.category.price} · ${esc(r.why.join(", "))}`);
    return {
      text: `${head}\n\n${lines.join("\n\n")}`,
      kb: [...ranked.map((r, i) => [{ text: `${i + 1}. Book ${prettyDate(r.show.dateCode).replace(/^\w+, /, "")} ${r.show.time.replace(/^0/, "")} · ${r.show.venueName.split(",")[0].slice(0, 24)}`, url: link(r.show) }]), w ? watchButtons(w) : MENU],
    };
  }

  function listReply(): Reply {
    const all = watches();
    if (!all.length) return { text: "📋 <b>Nothing watched yet.</b>\nPaste a BookMyShow or District link and I'll guide you.", kb: [[{ text: "❓ Help", data: "a|help" }]] };
    const blocks = all.map((w) => {
      const muted = bot.muted[w.id] && Date.parse(bot.muted[w.id]) > Date.now() ? ` · 🔕 until ${new Date(Date.parse(bot.muted[w.id]) + 330 * 60_000).toISOString().slice(11, 16)} IST` : "";
      return `${w.enabled === false ? "⏸" : "▶️"} <b>${esc(w.id)}</b> · ${esc(watchName(w))} <i>(${parseWatchUrl(w.url, w.city).source})</i>${muted}\n      ${esc(describeWatch(w))}\n      <i>${esc(state.watches[w.id]?.lastResult || "not checked yet")}</i>`;
    });
    return { text: `📋 <b>Your watches</b> (${all.length})\n\n${blocks.join("\n\n")}`, kb: all.slice(0, 12).map((w) => [{ text: `🏆 ${w.id}: best now`, data: `a|best|${w.id}` }, ...watchButtons(w).slice(1)]) };
  }

  async function handle(inc: Incoming): Promise<Reply> {
    const c: Command = inc.command;
    const all = watches();
    switch (c.cmd) {
      case "help": return { text: HELP, kb: [MENU.slice(0, 1)] };
      case "wizard": case "cancel": return { text: "" };
      case "error": return { text: `⚠️ ${esc(c.message)}`, kb: [MENU] };
      case "list": return listReply();
      case "pause": case "resume": {
        const w = all.find((x) => x.id === c.id);
        if (!w) return { text: `No watch "${esc(c.id)}".`, kb: [MENU] };
        bot.paused = bot.paused.filter((x) => x !== c.id);
        if (c.cmd === "pause") bot.paused.push(c.id); else delete state.watches[c.id];  // resume = fresh start
        const now = watches().find((x) => x.id === c.id)!;
        return { text: `${c.cmd === "pause" ? "⏸ Paused" : "▶️ Resumed"} <b>${esc(c.id)}</b> · ${esc(watchName(w))}`, kb: [watchButtons(now), MENU.slice(0, 1)] };
      }
      case "remove": {
        if (cfg.watches.some((w) => w.id === c.id)) return { text: `<b>${esc(c.id)}</b> is defined in watches.json, so it can only be paused here.`, kb: [[{ text: "⏸ Pause it", data: `a|pause|${c.id}` }]] };
        const w = bot.watches.find((x) => x.id === c.id);
        if (!w) return { text: `No watch "${esc(c.id)}".`, kb: [MENU] };
        bot.watches = bot.watches.filter((x) => x.id !== c.id);
        delete state.watches[c.id];
        bot.removed = [...(bot.removed || []).slice(-9), w];
        return { text: `🗑 Removed <b>${esc(c.id)}</b> · ${esc(watchName(w))}`, kb: [[{ text: "↩️ Undo", data: `a|undo|${c.id}` }], MENU.slice(0, 1)] };
      }
      case "add": {
        const t = parseWatchUrl(c.watch.url);
        const w = { ...c.watch, id: "_", label: c.watch.label || t.movieSlug.replace(/-/g, " ").replace(/\b\w/g, (x) => x.toUpperCase()) } as Watch;
        return saveWatch(w);
      }
      case "inspect": case "best": {
        const t = parseWatchUrl(c.url);
        bot.lastUrl[inc.chat] = c.url;
        const dates = c.cmd === "best" ? expandDates(c.dates) : [];
        const snap = await snapshot(t, dates, c.cmd === "best" ? c.formats || [] : [], c.cmd === "best" ? c.language : undefined);
        if (!snap.complete && !snap.shows.length) return { text: `⚠️ Couldn't read ${t.source}: ${esc(snap.failures[0] || "no data")}` };
        if (c.cmd === "best") {
          const pool = snap.shows.filter((s) => !dates.length || dates.includes(s.dateCode));
          const r = bestReply(snap, t, pool, { seats: c.seats, categories: c.categories, formats: c.formats, times: c.times, preferTime: c.time, maxPrice: c.maxPrice });
          r.kb = [...(r.kb || []).filter((row) => row[0]?.url), [{ text: "➕ Watch this movie", data: "a|wiz" }]];
          return r;
        }
        const venues = new Map<string, Set<string>>();
        for (const s of snap.shows) {
          const k = `<code>${esc(s.venueCode)}</code> ${esc(s.venueName)}`;
          venues.set(k, (venues.get(k) || new Set()).add(esc([s.format, s.screenAttr.split(" · ")[0]].filter(Boolean).join(" ").replace(/\bMS[- ]+/gi, ""))));
        }
        const open = snap.dates.filter((d) => d.status !== "NOT_OPEN").map((d) => prettyDate(d.dateCode));
        return {
          text: `🔎 <b>${esc(snap.movieName || t.movieSlug)}</b> · ${t.source === "district" ? "District" : "BookMyShow"} · ${esc(t.citySlug)}\n\n` +
            `🎞 <b>Formats</b>\n${snap.formats.map((f) => `• ${esc((f.title || "(default)").replace(/\bMS[- ]+/gi, ""))}`).join("\n")}\n\n` +
            `📅 <b>Open dates</b>\n${open.length ? open.join(" · ") : "none yet"}\n\n` +
            `🏢 <b>Cinemas</b> (${venues.size})\n${[...venues].slice(0, 40).map(([v, f]) => `${v}\n      <i>${[...f].slice(0, 3).join(", ")}</i>`).join("\n")}${venues.size > 40 ? `\n<i>...and ${venues.size - 40} more</i>` : ""}`,
          kb: [[{ text: "➕ Watch this movie", data: "a|wiz" }, { text: "🏆 Best now", data: "a|bestlast" }]],
        };
      }
    }
  }

  /** Taps on action buttons (from alerts, /list, /best ...): "a|<op>|<watchId>|<arg>". */
  async function onAction(inc: Incoming): Promise<Reply | null> {
    const [, op, id, arg] = inc.callback!.data.split("|");
    const w = watches().find((x) => x.id === id);
    const ackText = (t: string) => ack(tg!, inc.callback!.id, t);
    switch (op) {
      case "list": await ackText(""); return listReply();
      case "help": await ackText(""); return { text: HELP, kb: [MENU.slice(0, 1)] };
      case "wiz": case "bestlast": {
        const url = bot.lastUrl[inc.chat];
        if (!url) { await ackText("Paste the link again"); return null; }
        await ackText("");
        if (op === "wiz") { await startWizard(inc.chat, url); return null; }
        return handle({ ...inc, command: parseCommand(`/best ${url}`) });
      }
      case "undo": {
        const r = (bot.removed || []).find((x) => x.id === id);
        if (!r) { await ackText("Nothing to undo"); return null; }
        bot.removed = bot.removed!.filter((x) => x !== r);
        bot.watches.push(r);
        await ackText("Restored");
        return { text: `↩️ Restored <b>${esc(r.id)}</b> · ${esc(watchName(r))}`, kb: [watchButtons(r)] };
      }
    }
    if (!w) { await ackText("That watch no longer exists"); return null; }
    switch (op) {
      case "best": await ackText("Checking..."); return bestFor(w);
      case "pause": case "resume": await ackText(op === "pause" ? "Paused" : "Resumed"); return handle({ ...inc, command: { cmd: op, id } });
      case "rm": await ackText(""); return { text: `Remove <b>${esc(id)}</b> · ${esc(watchName(w))}?`, kb: [[{ text: "🗑 Yes, remove", data: `a|rmyes|${id}` }, { text: "Keep it", data: `a|list` }]] };
      case "rmyes": await ackText("Removed"); return handle({ ...inc, command: { cmd: "remove", id } });
      case "snooze": {
        const hours = Number(arg || 6);
        bot.muted[id] = new Date(Date.now() + hours * 3600e3).toISOString();
        await ackText(`Snoozed ${hours}h`);
        return { text: `🔕 <b>${esc(id)}</b> snoozed for ${hours}h. Changes during that time are skipped.`, kb: [[{ text: "🔔 Unsnooze", data: `a|unsnooze|${id}` }, { text: "🔕 24h", data: `a|snooze|${id}|24` }]] };
      }
      case "unsnooze": delete bot.muted[id]; await ackText("Alerts on"); return { text: `🔔 Alerts back on for <b>${esc(id)}</b>.`, kb: [watchButtons(w)] };
    }
    await ackText("Unknown action");
    return null;
  }

  async function saveWatch(w: Watch): Promise<Reply> {
    try { groupKey(w); } catch (e) { return { text: `⛔ ${esc((e as Error).message)}` }; }
    const v = await validateFor(w);
    if (v.errors.length) return { text: `Not saved:\n${validationText(v, esc)}` };
    w.id = `b${bot.nextId++}`;
    bot.watches.push(w);
    return { text: `✅ <b>Watching ${w.id}</b> · ${esc(w.label || "")} <i>(${parseWatchUrl(w.url).source})</i>\n      ${esc(describeWatch(w))}\n\n${validationText(v, esc)}\n\n<i>Checking now. You'll get an alert on any change.</i>`, added: w,
      kb: [[{ text: "🏆 Best now", data: `a|best|${w.id}` }, { text: "⏸ Pause", data: `a|pause|${w.id}` }], MENU] };
  }

  // ---------------- guided add ----------------
  async function startWizard(chat: string, url: string): Promise<void> {
    const t = parseWatchUrl(url);
    const snap = await snapshot(t, [], [], undefined);
    if (!snap.shows.length && !snap.complete) { await reply(tg!, chat, `⚠️ Couldn't read ${t.source} right now (${esc(snap.failures[0] || "no data")}). You can still add it in one line: /add ${esc(url)} dates=... formats=...`); return; }
    const d = newDraft(`k${Date.now().toString(36).slice(-5)}`, chat, url, snap);
    if (t.language && t.source === "bms") d.movie += ` (${t.language})`;
    const r = render(d);
    d.msgId = await card(tg!, chat, r.text, r.keyboard);
    bot.drafts[chat] = d;
  }

  async function showDraft(d: Draft, note = ""): Promise<void> {
    let notes = "";
    if (d.step === "review") {
      const w = { ...draftToWatch(d), id: "_" } as Watch;
      notes = validationText(await validateFor(w), esc);
    }
    const r = render(d, notes);
    d.msgId = await card(tg!, d.chat, (note ? `<i>${esc(note)}</i>\n` : "") + r.text, r.keyboard, d.msgId);
  }

  async function onTap(inc: Incoming): Promise<Watch | null> {
    const [id, op, arg] = inc.callback!.data.split("|");
    const d = bot.drafts[inc.chat];
    if (!d || d.id !== id) { await ack(tg!, inc.callback!.id, "This setup has expired. Paste the link again."); return null; }
    await ack(tg!, inc.callback!.id);
    const res = onCallback(d, op, arg);
    if (res === "cancel") { delete bot.drafts[inc.chat]; await card(tg!, d.chat, `✖ Cancelled: ${esc(d.movie)}`, [], d.msgId); return null; }
    if (res === "save") {
      const r = await saveWatch({ ...draftToWatch(d), id: "_" } as Watch);
      if (!r.added) { await showDraft(d, "Fix the errors below, then Save."); return null; }
      delete bot.drafts[inc.chat];
      await card(tg!, d.chat, r.text, (r.kb || []) as any, d.msgId);
      return r.added;
    }
    await showDraft(d);
    return null;
  }

  async function processCommands(waitSeconds: number): Promise<Watch[]> {
    if (!tg) return [];
    const added: Watch[] = [];
    let incoming: Incoming[] = [];
    try { incoming = await pull(tg, bot, waitSeconds, log); } catch (e) { log(`  telegram getUpdates failed: ${(e as Error).message}`); return []; }
    for (const d of Object.values(bot.drafts)) if (Date.now() - Date.parse(d.createdAt) > 2 * 86400e3) delete bot.drafts[d.chat];
    for (const inc of incoming) {
      log(`  ⌨ ${inc.callback ? `[tap ${inc.callback.data}]` : inc.text.slice(0, 80)}`);
      try {
        if (inc.callback?.data.startsWith("a|")) { const r = await onAction(inc); if (r?.text) await card(tg, inc.chat, r.text, (r.kb || []) as any); continue; }
        if (inc.callback) { const w = await onTap(inc); if (w) added.push(w); continue; }
        const draft = bot.drafts[inc.chat];
        if (draft && !inc.text.startsWith("/") && !isSupportedLink(inc.text)) { const note = onText(draft, inc.text); await showDraft(draft, note); continue; }
        if (inc.command.cmd === "cancel") { if (draft) { delete bot.drafts[inc.chat]; await card(tg, inc.chat, "✖ Cancelled", [], draft.msgId); } else await reply(tg, inc.chat, "Nothing to cancel."); continue; }
        if (inc.command.cmd === "wizard") { bot.lastUrl[inc.chat] = inc.command.url; await startWizard(inc.chat, inc.command.url); continue; }
        if (isSupportedLink(inc.text)) bot.lastUrl[inc.chat] = (inc.text.match(/https?:\/\/\S+/) || [""])[0];
        const r = await handle(inc); if (r.added) added.push(r.added); if (r.text) await card(tg, inc.chat, r.text, (r.kb || []) as any);
      }
      catch (e) { log(`  command failed: ${(e as Error).message}`); await reply(tg, inc.chat, `⚠️ ${esc((e as Error).message)}`).catch(() => {}); }
    }
    return added;
  }

  // ---------------- seat-level watches ----------------
  async function seatPass(): Promise<void> {
    const list = (cfg.seatWatches || []).filter((w) => w.enabled !== false && !bot.paused.includes(w.id) && (!only || w.id === only));
    if (!list.length) return;
    const mem: Record<string, string> = ((state as any).seats ||= {});
    for (const sw of list) {
      try {
        const chans = sw.channels?.length ? sw.channels.map((n) => notifiers[n]).filter(Boolean) : Object.values(notifiers);
        const muted = bot.muted[sw.id] && Date.parse(bot.muted[sw.id]) > Date.now();
        const r = await runSeatWatch(sw, snapshot, mem, (n) => (muted ? Promise.resolve(true) : dispatch({ ...n, actions: [{ text: "🔕 Snooze 6h", data: `a|snooze|${sw.id}|6` }, { text: "⏸ Pause", data: `a|pause|${sw.id}` }] }, chans, log)), log);
        (state.watches[sw.id] ||= { dates: [], cats: {} }).lastResult = `seats: ${r}${muted ? " (snoozed)" : ""}`;
        state.watches[sw.id].lastCheckedAt = new Date().toISOString();
        log(`  💺 ${sw.id}: ${r}`);
      } catch (e) { log(`  💺 ${sw.id}: failed ${(e as Error).message}`); }
    }
  }

  // ---------------- run ----------------
  log(`[${new Date().toISOString()}] CineAlert${dryRun ? " (dry run)" : ""}`);
  await processCommands(0);
  const active = watches().filter((w) => w.enabled !== false && !seatIds.has(w.id) && (!only || w.id === only));
  log(`${active.length} active watch(es)`);
  const r = await check(active);
  await seatPass();
  let lastSeat = Date.now();

  const h = healthUpdate(state, r.ok || !r.fail);
  if (h === "warn") await dispatch({ title: "⚠️ CineAlert can't read the ticket sites", text: "3 checks in a row got no data (probably refusing GitHub's servers). Check the apps manually; I'll tell you when it works again.", html: "3 checks in a row got no data.", link: "https://in.bookmyshow.com", priority: "high" }, Object.values(notifiers), log);
  if (h === "recovered") await dispatch({ title: "✅ CineAlert is reading the ticket sites again", text: "Alerts resumed.", html: "Alerts resumed.", link: "https://in.bookmyshow.com", priority: "default" }, Object.values(notifiers), log);

  const ist = new Date(Date.now() + 330 * 60_000);
  const today = ist.toISOString().slice(0, 10);
  state.meta ||= {};
  if (cfg.dailySummaryHourIST !== undefined && ist.getUTCHours() === cfg.dailySummaryHourIST && state.meta.lastSummary !== today && !dryRun) {
    const lines = active.map((w) => `• ${w.id} ${w.label || ""}: ${state.watches[w.id]?.lastResult || "not checked yet"}`);
    if (await dispatch({ title: `🫡 CineAlert: watching ${active.length} item(s)`, text: lines.join("\n"), html: lines.map(esc).join("<br>"), link: "https://in.bookmyshow.com", priority: "default" }, Object.values(notifiers), log)) state.meta.lastSummary = today;
  }

  // Optional listening window: near-instant replies; new watches are checked right away.
  const until = Date.now() + LISTEN * 1000;
  let lastCheck = Date.now();
  while (Date.now() < until - 5000) {
    const wait = Math.min(50, Math.floor((until - Date.now()) / 1000) - 5);
    const added = tg ? await processCommands(wait) : (await new Promise((r) => setTimeout(r, wait * 1000)), []);
    if (added.length) await check(added);
    if (RECHECK_MS && Date.now() - lastCheck >= RECHECK_MS) {
      lastCheck = Date.now();
      const again = watches().filter((w) => w.enabled !== false && !seatIds.has(w.id) && (!only || w.id === only));
      log(`↻ re-check ${new Date().toISOString()}`);
      await check(again);
    }
    if (Date.now() - lastSeat >= SEAT_MS) { lastSeat = Date.now(); await seatPass(); }
  }

  if (!dryRun) {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
    await saveBot(STATE_DIR, bot);
    await writeFile(CATALOG_FILE, JSON.stringify(catalog) + "\n");
  }
  log(`done: ${clients.requests()} request(s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
