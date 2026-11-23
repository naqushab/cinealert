// Telegram command grammar (pure; reused by the Android app later).
//   /add <link> [dates=17-12..25-12] [formats=pxl,4dx] [cinemas="logix,mall of india"] [exclude=inox]
//               [times=evening,night] [class=recliner] [max=1500] [seats=2] [lang=english] [label="..."]
//   /show <link> cinema=PVLE time=19:30 [seats=2] [class=recliner] [dates=18-12] [formats=imax]
//   /best <link> [date=18-12] [seats=2] [class=recliner] [formats=pxl] [time=19:30]     rank shows now
//   /inspect <link>                                                                     formats, dates, cinema codes
//   /list   /pause <id>   /resume <id>   /remove <id>   /help
//   A bare link is treated as /add <link>.
import type { MovieWatch, ShowWatch } from "../types.ts";
import { isSupportedLink, parseWatchUrl } from "../source.ts";

export type Command =
  | { cmd: "help" } | { cmd: "list" }
  | { cmd: "pause" | "resume" | "remove"; id: string }
  | { cmd: "add"; watch: Omit<MovieWatch, "id"> | Omit<ShowWatch, "id"> }
  | { cmd: "inspect"; url: string }
  | { cmd: "wizard"; url: string }
  | { cmd: "cancel" }
  | { cmd: "best"; url: string; dates: string[]; language?: string; seats?: number; categories?: string[]; formats?: string[]; times?: string[]; time?: string; maxPrice?: number }
  | { cmd: "error"; message: string };

export function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /(\S+?=)?"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ? m[1] + m[2] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "17-12", "17/12", "2026-12-17", "17-12..25-12", "17..25" → "YYYY-MM-DD"[ ..] specs. */
export function parseDateSpec(spec: string, today: Date, hintMonth?: number): string[] {
  const one = (t: string, fallbackMonth?: number): string | null => {
    t = t.trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = t.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/);
    let d: number, mo: number, y: number | undefined;
    if (m) { d = +m[1]; mo = +m[2]; y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined; }
    else if (/^\d{1,2}$/.test(t) && fallbackMonth) { d = +t; mo = fallbackMonth; }
    else return null;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (!y) { y = today.getUTCFullYear(); if (mo < today.getUTCMonth() + 1) y++; }
    return `${y}-${pad(mo)}-${pad(d)}`;
  };
  const out: string[] = [];
  for (const part of spec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [a, b] = part.split(/\.\.|–|(?<=\d)\s*to\s*(?=\d)/);
    if (b !== undefined) {
      const end = one(b, hintMonth);
      const start = one(a, end ? +end.slice(5, 7) : hintMonth);
      if (!start || !end) throw new Error(`can't read dates "${part}" (try 17-12..25-12)`);
      out.push(`${start}..${end}`);
    } else {
      const d = one(a, hintMonth);
      if (!d) throw new Error(`can't read date "${part}" (try 17-12 or 2026-12-17)`);
      out.push(d);
    }
  }
  return out;
}

const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

export function parseCommand(text: string, today = new Date()): Command {
  const raw = (text || "").trim();
  let [head, ...rest] = tokenize(raw);
  if (!head) return { cmd: "help" };
  if (!head.startsWith("/") && isSupportedLink(raw)) { rest = [head, ...rest]; head = "/add"; }
  const cmd = head.toLowerCase().replace(/@\w+$/, "").slice(1);
  if (cmd === "start" || cmd === "help") return { cmd: "help" };
  if (cmd === "list") return { cmd: "list" };
  if (cmd === "cancel") return { cmd: "cancel" };
  if (cmd === "pause" || cmd === "resume" || cmd === "remove" || cmd === "delete") {
    if (!rest[0]) return { cmd: "error", message: `usage: /${cmd} <id>  (ids are in /list)` };
    return { cmd: cmd === "delete" ? "remove" : cmd, id: rest[0] };
  }
  if (!["add", "show", "best", "inspect", "watch"].includes(cmd)) return { cmd: "error", message: `unknown command /${cmd}. Try /help` };

  const url = rest.find((t) => /^https?:\/\//.test(t));
  if (!url) return { cmd: "error", message: `/${cmd} needs a BookMyShow or District link` };
  let target;
  try { target = parseWatchUrl(url); } catch (e) { return { cmd: "error", message: (e as Error).message }; }
  if (cmd === "inspect") return { cmd: "inspect", url };
  // No options given → guided setup with buttons.
  if ((cmd === "add" || cmd === "watch") && !rest.some((t) => /^[a-zA-Z]+=/.test(t))) return { cmd: "wizard", url };

  const hintMonth = target.dateCode ? +target.dateCode.slice(4, 6) : undefined;
  const o: Record<string, string> = {};
  for (const t of rest) {
    const m = t.match(/^([a-zA-Z]+)=(.*)$/);
    if (m) o[m[1].toLowerCase()] = m[2];
  }
  try {
    const dates = o.dates || o.date ? parseDateSpec(o.dates || o.date, today, hintMonth) : [];
    const common = {
      url, label: o.label || o.name || undefined,
      dates: dates.length ? dates : undefined,
      formats: o.formats || o.format ? list(o.formats || o.format).map((f) => f.toUpperCase()) : undefined,
      categories: o.class || o.classes ? list(o.class || o.classes) : undefined,
      maxPrice: o.max || o.maxprice ? Number(o.max || o.maxprice) : undefined,
      minSeats: o.seats ? Number(o.seats) : undefined,
      language: o.lang || o.language || target.language || undefined,
    };
    if (cmd === "best") {
      return { cmd: "best", url, language: common.language, dates: dates.length ? dates : target.dateCode ? [target.dateCode] : [], seats: common.minSeats, categories: common.categories,
        formats: common.formats, maxPrice: common.maxPrice, time: o.time && /\d:\d/.test(o.time) ? o.time : undefined,
        times: o.times ? list(o.times) : undefined };
    }
    if (cmd === "show") {
      const cinema = o.cinema || o.at;
      if (!cinema) return { cmd: "error", message: "/show needs cinema=<code or name>, e.g. cinema=PVLE time=19:30" };
      const w: Omit<ShowWatch, "id"> = { ...strip(common), type: "show", cinema, time: o.time, toleranceMinutes: o.tolerance ? Number(o.tolerance) : undefined,
        seats: o.seats ? { count: Number(o.seats), areas: common.categories } : undefined };
      return { cmd: "add", watch: strip(w) };
    }
    const w: Omit<MovieWatch, "id"> = { ...strip(common), type: "movie", cinemas: o.cinemas || o.cinema ? list(o.cinemas || o.cinema) : undefined,
      excludeCinemas: o.exclude ? list(o.exclude) : undefined, times: o.times || o.time ? list(o.times || o.time) : undefined };
    return { cmd: "add", watch: strip(w) };
  } catch (e) {
    return { cmd: "error", message: (e as Error).message };
  }
}

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as T;
}

export const HELP = `<b>CineAlert</b>
<b>Easiest:</b> paste a BookMyShow or District link and tap through the guided setup (dates → formats → cinemas → time → seat class → seats → review).
Power users can do it in one line:
/add &lt;link&gt; dates=17-12..25-12 formats=pxl,4dx cinemas="logix,mall of india" times=evening,night class=recliner seats=2 max=1500
/show &lt;link&gt; cinema=PVLE time=19:30 seats=2 class=recliner dates=18-12
/best &lt;link&gt; date=18-12 seats=2 class=recliner time=19:30 lang=english   (best shows right now)
/inspect &lt;link&gt;   (formats, open dates, cinema codes)
/list · /pause &lt;id&gt; · /resume &lt;id&gt; · /remove &lt;id&gt; · /cancel (stop a setup)
Formats: IMAX PXL INFINITY_VISION 4DX SCREENX ICE EPIQ DOLBY INSIGNIA 3D 2D`;
