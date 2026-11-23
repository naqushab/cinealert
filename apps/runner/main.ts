// CineAlert runner: one check cycle. Scheduled by GitHub Actions (free), or run by hand.
//   node apps/runner/main.ts [--dry-run] [--only <watchId>]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  BmsClient, buildNotification, diffWatch, dispatch, emptyState, expandDates, findBestSeats, healthUpdate,
  resolveRegion, seatSummary, unavailableProvider, watchTarget,
} from "../../packages/core/src/index.ts";
import type { Change, Snapshot, State, Watch, ShowWatch, SeatLayoutProvider } from "../../packages/core/src/index.ts";
import { buildNotifiers, loadConfig } from "./config.ts";
import { pickFetcher } from "./fetchers.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : process.env.ONLY_WATCH || "";
const STATE_DIR = process.env.STATE_DIR || "state";
const STATE_FILE = `${STATE_DIR}/state.json`;
const log = (s: string) => console.log(s);

async function loadState(): Promise<State & { meta?: Record<string, string> }> {
  try { return { ...emptyState(), ...JSON.parse(await readFile(STATE_FILE, "utf8")) }; } catch { return emptyState(); }
}

async function seatChanges(w: ShowWatch, changes: Change[], provider: SeatLayoutProvider): Promise<{ changes: Change[]; note: string }> {
  if (!w.seats) return { changes, note: "" };
  const out: Change[] = [];
  let checked = 0, unavailable = 0;
  const seen = new Set<string>();
  for (const c of changes) {
    if (!c.show) { out.push(c); continue; }
    const k = `${c.show.venueCode}|${c.show.sessionId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const map = await provider.get(c.show.venueCode, c.show.sessionId, c.show.eventCode, c.show.dateCode);
    if (!map) { unavailable++; out.push(c); continue; }   // fall back to seat-class alert
    checked++;
    const best = findBestSeats(map, w.seats, 3).filter((p) => p.score >= (w.seats!.minScore ?? 0.6));
    if (best.length) out.push({ ...c, kind: "SEATS_FOUND", detail: best.map(seatSummary).join(" | ") });
  }
  const note = unavailable ? ` (seat map unavailable for ${unavailable} show(s): alerted on seat class instead)` : checked ? ` (seat maps checked: ${checked})` : "";
  return { changes: out, note };
}

async function main() {
  const cfg = await loadConfig();
  const state = await loadState();
  const notifiers = buildNotifiers(cfg, dryRun);
  const pick = (w: Watch) => (w.channels?.length ? w.channels.map((n) => notifiers[n]).filter(Boolean) : Object.values(notifiers));
  const client = new BmsClient({ fetcher: pickFetcher(), log, minGapMs: Number(process.env.MIN_GAP_MS || 1500) });
  const now = new Date();
  const active = cfg.watches.filter((w) => w.enabled !== false && (!only || w.id === only));
  log(`[${now.toISOString()}] CineAlert: ${active.length} watch(es)${dryRun ? " (dry run)" : ""}`);

  // One snapshot per (city, movie); union of every watch's dates. Format chips: all, if any watch wants all.
  const groups = new Map<string, Watch[]>();
  for (const w of active) {
    const t = watchTarget(w);
    const key = `${resolveRegion(t.citySlug).code}|${t.eventCode}`;
    groups.set(key, [...(groups.get(key) || []), w]);
  }

  let anyOk = false, anyFail = false;
  for (const [key, watches] of groups) {
    const t = watchTarget(watches[0]);
    const region = resolveRegion(t.citySlug);
    const dates = [...new Set(watches.flatMap((w) => expandDates(w.dates || [])))].sort();
    const formats = watches.some((w) => !w.formats?.length) ? [] : [...new Set(watches.flatMap((w) => w.formats!))];
    log(`• ${key}: dates ${dates.length ? `${dates[0]}...${dates.at(-1)}` : "any"}, formats ${formats.join("/") || "any"}`);
    const snap: Snapshot = await client.snapshot(region, t.eventCode, dates, formats);
    log(`  ${snap.movieName || t.movieSlug}: ${snap.shows.length} shows, ${snap.formats.length} format(s), ${snap.requests} request(s)${snap.complete ? "" : `, INCOMPLETE: ${snap.failures.join("; ")}`}`);
    if (!snap.complete) {
      anyFail = true;
      for (const w of watches) (state.watches[w.id] ||= { dates: [], cats: {} }).lastResult = `partial check, nothing compared (${snap.failures[0] || "no data"})`;
      continue;
    }
    anyOk = true;
    for (const w of watches) {
      let { changes, next } = diffWatch(w, snap, state.watches[w.id], now);
      let note = "";
      if (w.type === "show") ({ changes, note } = await seatChanges(w, changes, unavailableProvider));
      next.lastResult += note;
      if (!changes.length) { state.watches[w.id] = next; log(`  ${w.id}: ${next.lastResult}`); continue; }
      const n = buildNotification(w, snap.movieName, changes);
      const sent = await dispatch(n, pick(w), log);
      if (sent) state.watches[w.id] = next;  // at-least-once: only remember what we delivered
      else state.watches[w.id] = { ...(state.watches[w.id] || { dates: [], cats: {} }), lastCheckedAt: now.toISOString(), lastResult: "alert delivery failed, will retry" };
      log(`  ${w.id}: ${changes.length} change(s) → ${sent ? "sent" : "NOT sent"}`);
    }
  }

  const h = healthUpdate(state, anyOk || !anyFail);
  if (h === "warn") await dispatch({ title: "⚠️ CineAlert can't read BookMyShow", text: "3 checks in a row got no data (BookMyShow is probably refusing GitHub's servers). Check the app manually; I'll tell you when it works again.", html: "3 checks in a row got no data. Check the app manually.", link: "https://in.bookmyshow.com", priority: "high" }, Object.values(notifiers), log);
  if (h === "recovered") await dispatch({ title: "✅ CineAlert is reading BookMyShow again", text: "Alerts resumed.", html: "Alerts resumed.", link: "https://in.bookmyshow.com", priority: "default" }, Object.values(notifiers), log);

  // Optional daily "still watching" note
  const ist = new Date(now.getTime() + 330 * 60_000);
  const today = ist.toISOString().slice(0, 10);
  state.meta ||= {};
  if (cfg.dailySummaryHourIST !== undefined && ist.getUTCHours() === cfg.dailySummaryHourIST && state.meta.lastSummary !== today && !dryRun) {
    const lines = active.map((w) => `• ${w.label || w.id}: ${state.watches[w.id]?.lastResult || "not checked yet"}`);
    if (await dispatch({ title: `🫡 CineAlert: watching ${active.length} item(s)`, text: lines.join("\n"), html: lines.join("<br>"), link: "https://in.bookmyshow.com", priority: "default" }, Object.values(notifiers), log)) state.meta.lastSummary = today;
  }

  if (!dryRun) { await mkdir(STATE_DIR, { recursive: true }); await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n"); }
  log(`done: ${client.requests} BMS request(s)`);
  if (!anyOk && anyFail) process.exitCode = 0; // a blocked run is not a crash; health alert covers it
}

main().catch((e) => { console.error(e); process.exit(1); });
