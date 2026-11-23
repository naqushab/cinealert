// CineAlert runner. One run = (Telegram commands) → check every watch → (optionally keep listening).
//   node apps/runner/main.ts [--dry-run] [--only <watchId>]
// Env: FETCHER=cffi, STATE_DIR, BOT_LISTEN_SECONDS, TELEGRAM_*, NTFY_TOPIC, RESEND_API_KEY, EMAIL_*.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  buildNotification, diffWatch, dispatch, emptyState, expandDates, findBestSeats, healthUpdate, parseWatchUrl,
  prettyDate, rankShows, seatSummary, unavailableProvider,
} from "../../packages/core/src/index.ts";
import type { Change, Command, SeatLayoutProvider, ShowWatch, State, Watch } from "../../packages/core/src/index.ts";
import { buildNotifiers, loadConfig } from "./config.ts";
import { pickFetcher } from "./fetchers.ts";
import { groupKey, makeClients, snapshotFor } from "./sources.ts";
import { HELP, describeWatch, loadBot, pull, reply, saveBot } from "./bot.ts";
import type { Incoming, Tg } from "./bot.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : process.env.ONLY_WATCH || "";
const STATE_DIR = process.env.STATE_DIR || "state";
const STATE_FILE = `${STATE_DIR}/state.json`;
const LISTEN = Number(process.env.BOT_LISTEN_SECONDS || 0);
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
  const notifiers = buildNotifiers(cfg, dryRun);
  const clients = makeClients(pickFetcher(), log);
  const tgToken = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const tg: Tg | null = tgToken && !dryRun ? { token: tgToken, allowed: new Set((process.env.TELEGRAM_CHAT_ID || "").split(",").map((s) => s.trim()).filter(Boolean)) } : null;
  const watches = (): Watch[] => [...cfg.watches, ...bot.watches].map((w) => (bot.paused.includes(w.id) ? { ...w, enabled: false } : w));
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
      const snap = await snapshotFor(clients, t, dates, formats, ws[0].language);
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
        const n = buildNotification(w, snap.movieName, changes, t.source === "district" ? "District" : "BMS");
        const sent = await dispatch(n, pick(w), log);
        state.watches[w.id] = sent ? next : { ...(state.watches[w.id] || { dates: [], cats: {} }), lastCheckedAt: now.toISOString(), lastResult: "alert delivery failed, will retry" };
        log(`  ${w.id}: ${changes.length} change(s) → ${sent ? "sent" : "NOT sent"}`);
      }
    }
    return { ok, fail };
  }

  // ---------------- telegram commands ----------------
  async function handle(inc: Incoming): Promise<{ text: string; added?: Watch }> {
    const c: Command = inc.command;
    const all = watches();
    switch (c.cmd) {
      case "help": return { text: HELP };
      case "error": return { text: `⚠️ ${esc(c.message)}` };
      case "list": {
        if (!all.length) return { text: "Nothing watched yet. Paste a BookMyShow or District link." };
        return { text: all.map((w) => `<b>${w.id}</b> ${w.enabled === false ? "⏸" : "▶️"} ${esc(w.label || parseWatchUrl(w.url, w.city).movieSlug)} [${parseWatchUrl(w.url, w.city).source}]\n   ${esc(describeWatch(w))}\n   <i>${esc(state.watches[w.id]?.lastResult || "not checked yet")}</i>`).join("\n") };
      }
      case "pause": case "resume": {
        if (!all.some((w) => w.id === c.id)) return { text: `No watch "${esc(c.id)}". See /list` };
        bot.paused = bot.paused.filter((x) => x !== c.id);
        if (c.cmd === "pause") bot.paused.push(c.id); else delete state.watches[c.id];  // resume = fresh start
        return { text: `${c.cmd === "pause" ? "⏸ Paused" : "▶️ Resumed"} ${esc(c.id)}` };
      }
      case "remove": {
        if (cfg.watches.some((w) => w.id === c.id)) return { text: `${esc(c.id)} is defined in watches.json. Use /pause ${esc(c.id)}, or delete it from the file.` };
        const before = bot.watches.length;
        bot.watches = bot.watches.filter((w) => w.id !== c.id);
        delete state.watches[c.id];
        return { text: before === bot.watches.length ? `No watch "${esc(c.id)}"` : `🗑 Removed ${esc(c.id)}` };
      }
      case "add": {
        const t = parseWatchUrl(c.watch.url);
        const w = { ...c.watch, id: `b${bot.nextId}`, label: c.watch.label || t.movieSlug.replace(/-/g, " ").replace(/\b\w/g, (x) => x.toUpperCase()) } as Watch;
        try { groupKey(w); } catch (e) { return { text: `⚠️ ${esc((e as Error).message)}` }; }
        bot.nextId++;
        bot.watches.push(w);
        return { text: `✅ Watching <b>${w.id}</b>: ${esc(w.label!)} [${t.source}]\n${esc(describeWatch(w))}\nChecking now; you'll get alerts on changes.`, added: w };
      }
      case "inspect": case "best": {
        const t = parseWatchUrl(c.url);
        const dates = c.cmd === "best" ? expandDates(c.dates) : [];
        const snap = await snapshotFor(clients, t, dates, c.cmd === "best" ? c.formats || [] : [], c.cmd === "best" ? c.language : undefined);
        if (!snap.complete && !snap.shows.length) return { text: `⚠️ Couldn't read ${t.source}: ${esc(snap.failures[0] || "no data")}` };
        if (c.cmd === "inspect") {
          const venues = new Map<string, Set<string>>();
          for (const s of snap.shows) venues.set(`<code>${s.venueCode}</code> ${esc(s.venueName)}`, (venues.get(`<code>${s.venueCode}</code> ${esc(s.venueName)}`) || new Set()).add(esc([s.format, s.screenAttr].filter(Boolean).join(" "))));
          return { text: `<b>${esc(snap.movieName || t.movieSlug)}</b> · ${t.source} · ${esc(t.citySlug)}\n<b>Formats:</b> ${esc(snap.formats.map((f) => f.title || "(default)").join(", "))}\n<b>Open dates:</b> ${snap.dates.filter((d) => d.status !== "NOT_OPEN").map((d) => prettyDate(d.dateCode)).join(", ") || "none yet"}\n<b>Cinemas (${venues.size}):</b>\n${[...venues].slice(0, 45).map(([v, f]) => `${v} — ${[...f].slice(0, 3).join(", ")}`).join("\n")}` };
        }
        const wanted = new Set(dates);
        const pool = snap.shows.filter((s) => !wanted.size || wanted.has(s.dateCode));
        const ranked = rankShows(pool, { seats: c.seats, categories: c.categories, formats: c.formats, times: c.times, preferTime: c.time, maxPrice: c.maxPrice }, 6);
        if (!ranked.length) return { text: "No show matches right now." };
        const link = snap.showLink || (() => t.url);
        return { text: `<b>Best shows now</b> · ${esc(snap.movieName || t.movieSlug)}\n` + ranked.map((r, i) =>
          `${i + 1}. ${prettyDate(r.show.dateCode)} ${esc(r.show.time)} · ${esc(r.show.venueName)} · <i>${esc([r.show.format, r.show.screenAttr].filter(Boolean).join(" "))}</i>\n    ${esc(r.category.name)} ₹${r.category.price} · ${esc(r.why.join(", "))} — <a href="${link(r.show)}">book</a>`).join("\n") };
      }
    }
  }

  async function processCommands(waitSeconds: number): Promise<Watch[]> {
    if (!tg) return [];
    const added: Watch[] = [];
    let incoming: Incoming[] = [];
    try { incoming = await pull(tg, bot, waitSeconds, log); } catch (e) { log(`  telegram getUpdates failed: ${(e as Error).message}`); return []; }
    for (const inc of incoming) {
      log(`  ⌨ ${inc.text.slice(0, 80)}`);
      try { const r = await handle(inc); if (r.added) added.push(r.added); await reply(tg, inc.chat, r.text); }
      catch (e) { log(`  command failed: ${(e as Error).message}`); await reply(tg, inc.chat, `⚠️ ${esc((e as Error).message)}`).catch(() => {}); }
    }
    return added;
  }

  // ---------------- run ----------------
  log(`[${new Date().toISOString()}] CineAlert${dryRun ? " (dry run)" : ""}`);
  await processCommands(0);
  const active = watches().filter((w) => w.enabled !== false && (!only || w.id === only));
  log(`${active.length} active watch(es)`);
  const r = await check(active);

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
  while (tg && Date.now() < until - 5000) {
    const added = await processCommands(Math.min(50, Math.floor((until - Date.now()) / 1000) - 5));
    if (added.length) await check(added);
  }

  if (!dryRun) {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
    await saveBot(STATE_DIR, bot);
  }
  log(`done: ${clients.requests()} request(s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
