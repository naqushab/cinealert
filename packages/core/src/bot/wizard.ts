// Guided "add a watch" flow: paste a link → tap through steps with toggle buttons → review with
// validation → Save. Pure state machine; the Telegram runner (and later the Android app) renders it.
import type { MovieWatch, ShowWatch, Snapshot } from "../types.ts";
import { formatKeys } from "../catalog.ts";
import { showFormatLabel } from "../formats.ts";
import { prettyDate } from "../notify/format.ts";
import { parseDateSpec } from "./commands.ts";
import { expandDates } from "../match.ts";

export type Step = "lang" | "dates" | "formats" | "cinemas" | "showtime" | "times" | "classes" | "seats" | "review";
export interface KB { text: string; data: string }

export interface Draft {
  id: string; chat: string; msgId?: number; url: string; source: string; city: string; movie: string;
  step: Step; page: number; filter?: string; createdAt: string;
  sel: { lang?: string; dates: string[]; formats: string[]; cinemas: string[]; time?: string; times: string[]; classes: string[]; seats: number };
  opts: {
    langs: string[]; dates: string[];
    formats: [string, number][];                 // canonical key, shows
    cinemas: [string, string, string[]][];       // code, name, format keys
    showtimes: Record<string, number[]>;         // code → time codes
    classes: string[];
  };
}

const TIME_OPTS = ["morning", "afternoon", "evening", "night", "late"];
const CLASS_WORDS = ["recliner", "prime", "classic", "premium", "executive", "club", "royal", "gold", "insignia", "sofa", "luxe", "normal"];
const PAGE = 10;
const uniq = <T>(a: T[]) => [...new Set(a)];
const hhmm = (tc: number) => `${String(Math.floor(tc / 100)).padStart(2, "0")}:${String(tc % 100).padStart(2, "0")}`;
const clock = (tc: number) => { const h = Math.floor(tc / 100), m = tc % 100; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };

export function newDraft(id: string, chat: string, url: string, snap: Snapshot, now = new Date()): Draft {
  const counts = new Map<string, number>();
  const cinemas = new Map<string, [string, string, Set<string>]>();
  const times: Record<string, Set<number>> = {};
  const classes = new Set<string>();
  for (const s of snap.shows) {
    const keys = formatKeys(showFormatLabel(s.format, s.screenAttr));
    for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1);
    const c = cinemas.get(s.venueCode) || [s.venueCode, s.venueName, new Set<string>()];
    keys.forEach((k) => c[2].add(k));
    cinemas.set(s.venueCode, c);
    (times[s.venueCode] ||= new Set()).add(s.timeCode);
    for (const cat of s.categories) for (const w of CLASS_WORDS) if (cat.name.toLowerCase().includes(w)) classes.add(w);
  }
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10).replace(/-/g, "");
  const dates = uniq([...snap.dates.filter((d) => d.status !== "NOT_OPEN").map((d) => d.dateCode), ...snap.shows.map((s) => s.dateCode)]).filter((d) => d >= today).sort();
  const langs = snap.source === "district" ? snap.formats.map((f) => f.title).filter(Boolean) : [];
  return {
    id, chat, url, source: snap.source || "bms", city: snap.region.slug, movie: snap.movieName || "Movie",
    step: langs.length > 1 ? "lang" : "dates", page: 0, createdAt: now.toISOString(),
    sel: { dates: [], formats: [], cinemas: [], times: [], classes: [], seats: 0 },
    opts: {
      langs, dates,
      formats: [...counts].sort((a, b) => b[1] - a[1]),
      cinemas: [...cinemas.values()].map(([c, n, k]) => [c, n, [...k]] as [string, string, string[]]).sort((a, b) => a[1].localeCompare(b[1])),
      showtimes: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, [...v].sort((a, b) => a - b)])),
      classes: CLASS_WORDS.filter((w) => classes.has(w)),
    },
  };
}

export function steps(d: Draft): Step[] {
  const s: Step[] = [];
  if (d.opts.langs.length > 1) s.push("lang");
  s.push("dates", "formats", "cinemas");
  if (d.sel.cinemas.length === 1 && d.opts.showtimes[d.sel.cinemas[0]]?.length) s.push("showtime");
  if (!d.sel.time) s.push("times");
  s.push("classes", "seats", "review");
  return s;
}

function cinemaList(d: Draft): [string, string, string[]][] {
  const f = (d.filter || "").toLowerCase();
  return d.opts.cinemas.filter(([code, name, keys]) =>
    (!d.sel.formats.length || d.sel.formats.some((k) => keys.includes(k)) || d.sel.cinemas.includes(code)) &&
    (!f || name.toLowerCase().includes(f) || code.toLowerCase() === f));
}

function options(d: Draft): [string, string][] {   // [value, label]
  switch (d.step) {
    case "lang": return d.opts.langs.map((l) => [l, l]);
    case "dates": return uniq([...d.opts.dates, ...d.sel.dates.flatMap((x) => expandDates([x]))]).sort().map((c) => [c, prettyDate(c)]);
    case "formats": return [...d.opts.formats.map(([k, n]) => [k, `${k.replace(/_/g, " ")} (${n})`] as [string, string]), ...d.sel.formats.filter((f) => !d.opts.formats.some(([k]) => k === f)).map((f) => [f, `${f} (not listed yet)`] as [string, string])];
    case "cinemas": return cinemaList(d).map(([c, n]) => [c, n.length > 30 ? n.slice(0, 29) + "..." : n]);
    case "showtime": return (d.opts.showtimes[d.sel.cinemas[0]] || []).map((t) => [hhmm(t), clock(t)]);
    case "times": return TIME_OPTS.map((t) => [t, t]);
    case "classes": return d.opts.classes.map((c) => [c, c]);
    case "seats": return ["1", "2", "3", "4", "5", "6"].map((n) => [n, n]);
    default: return [];
  }
}

function selected(d: Draft, v: string): boolean {
  const s = d.sel;
  switch (d.step) {
    case "lang": return s.lang === v;
    case "dates": return s.dates.flatMap((x) => expandDates([x])).includes(v);
    case "formats": return s.formats.includes(v);
    case "cinemas": return s.cinemas.includes(v);
    case "showtime": return s.time === v;
    case "times": return s.times.includes(v);
    case "classes": return s.classes.includes(v);
    case "seats": return String(s.seats) === v;
    default: return false;
  }
}

const TITLES: Record<Step, string> = {
  lang: "Language", dates: "Dates", formats: "Formats", cinemas: "Cinemas", showtime: "Show time (optional)",
  times: "Time of day", classes: "Seat class", seats: "Seats together", review: "Review",
};
const HINTS: Partial<Record<Step, string>> = {
  dates: "Tap dates, or type e.g. <code>17-12..25-12</code> for dates not open yet.",
  formats: "Counts = shows listed now. Type a format (e.g. <code>IMAX</code>) to watch one that isn't listed yet.",
  cinemas: "Showing cinemas that screen your formats. Type part of a name to search (e.g. <code>logix</code>). None = any cinema.",
  showtime: "Pick a show to watch just that one, or Skip.",
  seats: "District alerts only when this many seats are left in your class.",
};

const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function summary(d: Draft): string {
  const s = d.sel;
  const cin = s.cinemas.map((c) => d.opts.cinemas.find(([x]) => x === c)?.[1] || c);
  return [
    s.lang && `🗣 <b>Language</b>  ${esc(s.lang)}`,
    `📅 <b>Dates</b>  ${s.dates.length ? s.dates.map((x) => x.includes("..") ? x : prettyDate(x.replace(/-/g, ""))).join(", ") : "any"}`,
    `🎞 <b>Formats</b>  ${esc(s.formats.join(", ").replace(/_/g, " ")) || "any"}`,
    `🏢 <b>Cinemas</b>  ${esc(cin.join("; ")) || "any"}`,
    s.time ? `🕖 <b>Show</b>  ${s.time}` : `🕖 <b>Times</b>  ${s.times.join(", ") || "any"}`,
    `💺 <b>Seat class</b>  ${esc(s.classes.join(", ")) || "any"}`,
    s.seats ? `👥 <b>Seats</b>  ${s.seats}+` : "",
  ].filter(Boolean).join("\n");
}

export function render(d: Draft, reviewNotes = ""): { text: string; keyboard: KB[][] } {
  const st = steps(d);
  const n = st.indexOf(d.step) + 1;
  const head = `🎬 <b>${esc(d.movie)}</b> · ${d.source === "district" ? "District" : "BookMyShow"} · ${esc(d.city)}\n<b>Step ${n}/${st.length} · ${TITLES[d.step]}</b>`;
  const cb = (op: string, arg = "") => `${d.id}|${op}|${arg}`;
  const kb: KB[][] = [];
  if (d.step === "review") {
    kb.push([{ text: "✅ Save watch", data: cb("save") }]);
    kb.push([{ text: "◀ Back", data: cb("back") }, { text: "✖ Cancel", data: cb("cancel") }]);
    return { text: `${head}\n\n${summary(d)}\n\n${reviewNotes || "Checking..."}`, keyboard: kb };
  }
  const opts = options(d);
  const pageOpts = opts.slice(d.page * PAGE, d.page * PAGE + PAGE);
  const perRow = d.step === "cinemas" ? 1 : d.step === "seats" ? 6 : 3;
  for (let i = 0; i < pageOpts.length; i += perRow)
    kb.push(pageOpts.slice(i, i + perRow).map(([v, label]) => ({ text: `${selected(d, v) ? "✅ " : ""}${label}`, data: cb("t", String(opts.findIndex(([x]) => x === v))) })));
  const nav: KB[] = [];
  if (d.page > 0) nav.push({ text: "⬅︎ More", data: cb("pg", "-1") });
  if ((d.page + 1) * PAGE < opts.length) nav.push({ text: `More (${opts.length - (d.page + 1) * PAGE}) ➡︎`, data: cb("pg", "1") });
  if (nav.length) kb.push(nav);
  kb.push([
    ...(n > 1 ? [{ text: "◀ Back", data: cb("back") }] : []),
    { text: d.step === "showtime" ? "Skip" : "Any / clear", data: cb("any") },
    { text: "Next ▶", data: cb("next") },
  ]);
  kb.push([{ text: "✖ Cancel", data: cb("cancel") }]);
  const empty = !opts.length ? (d.step === "dates" ? "\n<i>No dates are open yet. Type the dates you want.</i>" : d.step === "cinemas" ? "\n<i>No cinemas listed for this yet. Type a name to watch one anyway, or Next for any cinema.</i>" : "\n<i>Nothing listed yet. Next = any.</i>") : "";
  return { text: `${head}\n${HINTS[d.step] || ""}${empty}\n\n${summary(d)}`, keyboard: kb };
}

export type WizardResult = "continue" | "save" | "cancel";

export function onCallback(d: Draft, op: string, arg: string): WizardResult {
  const st = steps(d);
  const move = (k: number) => { const i = Math.max(0, Math.min(st.length - 1, st.indexOf(d.step) + k)); d.step = st[i]; d.page = 0; d.filter = undefined; };
  if (op === "cancel") return "cancel";
  if (op === "save") return "save";
  if (op === "next") { move(1); return "continue"; }
  if (op === "back") { move(-1); return "continue"; }
  if (op === "pg") { d.page = Math.max(0, d.page + Number(arg)); return "continue"; }
  const s = d.sel;
  if (op === "any") {
    if (d.step === "lang") s.lang = undefined; if (d.step === "dates") s.dates = []; if (d.step === "formats") s.formats = [];
    if (d.step === "cinemas") { s.cinemas = []; s.time = undefined; } if (d.step === "times") s.times = []; if (d.step === "classes") s.classes = [];
    if (d.step === "seats") s.seats = 0;
    if (d.step === "showtime") s.time = undefined;
    move(1);
    return "continue";
  }
  if (op === "t") {
    const opt = options(d)[Number(arg)];
    if (!opt) return "continue";
    const v = opt[0];
    const toggle = (a: string[]) => (a.includes(v) ? a.filter((x) => x !== v) : [...a, v]);
    switch (d.step) {
      case "lang": s.lang = s.lang === v ? undefined : v; break;
      case "dates": { const flat = uniq(s.dates.flatMap((x) => expandDates([x]))); s.dates = (flat.includes(v) ? flat.filter((x) => x !== v) : [...flat, v]).sort(); break; }
      case "formats": s.formats = toggle(s.formats); break;
      case "cinemas": s.cinemas = toggle(s.cinemas); if (s.cinemas.length !== 1) s.time = undefined; break;
      case "showtime": s.time = s.time === v ? undefined : v; break;
      case "times": s.times = toggle(s.times); break;
      case "classes": s.classes = toggle(s.classes); break;
      case "seats": s.seats = s.seats === Number(v) ? 0 : Number(v); break;
    }
  }
  return "continue";
}

/** Typed text during the wizard. Returns a short note to show, if any. */
export function onText(d: Draft, text: string, today = new Date()): string {
  const t = text.trim();
  if (d.step === "dates") {
    try {
      const specs = parseDateSpec(t, today, d.opts.dates[0] ? +d.opts.dates[0].slice(4, 6) : undefined);
      d.sel.dates = uniq([...d.sel.dates.flatMap((x) => expandDates([x])), ...expandDates(specs)]).sort();
      return "";
    } catch (e) { return (e as Error).message; }
  }
  if (d.step === "formats") { const f = t.toUpperCase().replace(/[\s-]+/g, "_"); if (!d.sel.formats.includes(f)) d.sel.formats.push(f); return ""; }
  if (d.step === "cinemas") {
    d.filter = t; d.page = 0;
    if (!cinemaList(d).length) { d.sel.cinemas = uniq([...d.sel.cinemas, t]); d.filter = undefined; return `No listed cinema matches "${t}", added it as a name to watch for.`; }
    return "";
  }
  return "Use the buttons for this step.";
}

export function draftToWatch(d: Draft): Omit<MovieWatch, "id"> | Omit<ShowWatch, "id"> {
  const s = d.sel;
  const label = `${d.movie}${s.lang ? ` (${s.lang})` : ""} · ${d.city}`;
  const dates = s.dates.length ? s.dates.map((x) => x.includes("-") ? x : `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}`) : undefined;
  const common = {
    url: d.url, label, dates, formats: s.formats.length ? s.formats : undefined, categories: s.classes.length ? s.classes : undefined,
    minSeats: s.seats || undefined, language: s.lang?.toLowerCase(),
  };
  if (s.time && s.cinemas.length === 1)
    return clean({ ...common, type: "show", cinema: s.cinemas[0], time: s.time, toleranceMinutes: 20, seats: s.seats ? { count: s.seats, areas: common.categories } : undefined });
  return clean({ ...common, type: "movie", cinemas: s.cinemas.length ? s.cinemas : undefined, times: s.times.length ? s.times : undefined });
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
