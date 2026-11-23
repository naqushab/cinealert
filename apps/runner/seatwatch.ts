// Seat-level watches: pick shows on BookMyShow (format labels like PXL live there), map them to
// District by the shared PVR session id, read District's seat map, alert when a seat block matching
// the preferences (e.g. 2 together, middle, row G+) becomes free.
import { districtSeatUrl, expandDates, findBestSeats, formatMatches, parseWatchUrl, prettyDate, seatSummary, showFormatLabel } from "../../packages/core/src/index.ts";
import type { Notification, SeatPrefs, Show, Snapshot, WatchTarget } from "../../packages/core/src/index.ts";
import { readSeatMaps } from "./seatreader.ts";
import type { SeatJob } from "./seatreader.ts";

export interface SeatWatch {
  id: string; enabled?: boolean; label?: string; bms: string; district: string; language?: string;
  cinemas: { bms: string; district: string; name?: string }[]; formats?: string[]; dates: string[];
  seats: SeatPrefs; maxPerRun?: number; channels?: string[];
}
type Snap = (t: WatchTarget, dates: string[], formats: string[], lang?: string) => Promise<Snapshot>;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function runSeatWatch(sw: SeatWatch, snapshot: Snap, mem: Record<string, string>, send: (n: Notification) => Promise<boolean>, log: (s: string) => void, now = new Date()): Promise<string> {
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10).replace(/-/g, "");
  const dates = expandDates(sw.dates).filter((d) => d >= today);
  const bt = parseWatchUrl(sw.bms), dt = parseWatchUrl(sw.district);
  const b = await snapshot(bt, dates, sw.formats || []);
  const picks = b.shows.filter((s) => dates.includes(s.dateCode) && sw.cinemas.some((c) => c.bms === s.venueCode)
    && (!sw.formats?.length || sw.formats.some((f) => formatMatches(showFormatLabel(s.format, s.screenAttr), f))));
  if (!picks.length) return b.complete ? "no matching shows listed yet" : `BookMyShow unreadable (${b.failures[0] || "no data"})`;

  const d = await snapshot(dt, [...new Set(picks.map((p) => p.dateCode))], [], sw.language);
  if (!d.shows.length && !d.complete)
    return `${picks.length} matching show(s) on BookMyShow, but District is unreadable from this network (${d.failures[0]?.replace(/^https?:\/\/\S+: /, "") || "no data"}), so seat maps can't be checked`;
  const dIdx = new Map(d.shows.map((s) => [`${s.venueCode}|${s.sessionId}`, s]));
  const jobs: (SeatJob & { show: Show; key: string })[] = [];
  let soldOut = 0, unmapped = 0;
  for (const p of picks) {
    const c = sw.cinemas.find((x) => x.bms === p.venueCode)!;
    const ds = dIdx.get(`D${c.district}|${p.sessionId}`);
    const key = `${sw.id}|${p.venueCode}|${p.sessionId}|${p.dateCode}`;
    if (!ds?.bookingRef) { unmapped++; continue; }
    if (ds.categories.reduce((n, k) => n + (k.seatsAvail ?? 99), 0) < sw.seats.count) { soldOut++; mem[key] = "-"; continue; }
    jobs.push({ url: districtSeatUrl(ds.eventCode, ds.bookingRef, p.dateCode, dt.eventCode), venueCode: p.venueCode, sessionId: p.sessionId, show: p, key });
  }
  const todo = jobs.slice(0, sw.maxPerRun ?? 24);
  const maps = await readSeatMaps(todo, log);
  const hits: { job: (typeof todo)[number]; text: string }[] = [];
  let unread = 0;
  for (const j of todo) {
    const map = maps.get(j.url);
    if (!map) { unread++; continue; }
    const best = findBestSeats(map, sw.seats, 3);
    const cur = best.map((x) => x.seats.join("+")).join(",") || "-";
    if (cur !== "-" && (mem[j.key] === undefined || mem[j.key] === "-")) hits.push({ job: j, text: best.map(seatSummary).join("\n      ") });
    mem[j.key] = cur;
  }
  const summary = `${picks.length} show(s), ${todo.length} seat map(s) read${unread ? `, ${unread} unreadable` : ""}${soldOut ? `, ${soldOut} sold out` : ""}${unmapped ? `, ${unmapped} not on District` : ""}, ${hits.length} new hit(s)`;
  if (!hits.length) return summary;

  const name = sw.label || b.movieName;
  const lines = hits.map((h) => {
    const s = h.job.show, cin = sw.cinemas.find((c) => c.bms === s.venueCode)?.name || s.venueName;
    return `💺 <b>${prettyDate(s.dateCode)} · ${esc(s.time.replace(/^0/, ""))}</b> · ${esc(cin)}\n      <i>${esc(showFormatLabel(s.format, s.screenAttr).replace(/\bMS[- ]+/gi, ""))}</i>\n      ${esc(h.text)}\n      <a href="${h.job.url}">Open seat map →</a>`;
  });
  const n: Notification = {
    title: `💺 ${name}: ${hits.length} show(s) with your seats free`,
    tg: `💺 <b>${esc(name)}</b>\n<i>${sw.seats.count} together${sw.seats.fromRow ? `, row ${sw.seats.fromRow}+` : ""}${sw.seats.centre !== undefined ? ", middle" : ""}</i>\n\n${lines.join("\n\n")}`,
    text: hits.map((h) => `${prettyDate(h.job.show.dateCode)} ${h.job.show.time} ${h.job.show.venueName}: ${h.text}`).join("\n"),
    html: lines.map((l) => `<p>${l.replace(/\n/g, "<br>")}</p>`).join(""),
    link: hits[0].job.url, priority: "urgent",
    buttons: hits.slice(0, 5).map((h) => ({ text: `💺 ${prettyDate(h.job.show.dateCode).replace(/^\w+, /, "")} ${h.job.show.time.replace(/^0/, "")} · ${(sw.cinemas.find((c) => c.bms === h.job.show.venueCode)?.name || "").replace(/^PVR (Superplex )?/, "")} · ${h.text.split(" · ")[0].replace(/^Row /, "")}`.slice(0, 60), url: h.job.url })),
  };
  if (!(await send(n))) for (const h of hits) delete mem[h.job.key];   // retry next time
  return summary;
}
