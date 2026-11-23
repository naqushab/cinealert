import type { Category, Show, TimeWindow, Watch } from "./types.ts";
import { formatMatches, showFormatLabel } from "./formats.ts";

const PERIODS: Record<string, [number, number]> = {
  morning: [600, 1200], afternoon: [1200, 1600], evening: [1600, 1900], night: [1900, 2400], late: [0, 600],
};

/** Expands "2026-12-17..2026-12-25", "2026-12-17" or "20261217" into YYYYMMDD codes. */
export function expandDates(specs: string[] = []): string[] {
  const out = new Set<string>();
  const code = (s: string) => s.replace(/-/g, "");
  for (const spec of specs) {
    const [a, b] = spec.split("..").map((x) => x.trim());
    if (!b) { out.add(code(a)); continue; }
    const d = new Date(`${a.slice(0, 4)}-${code(a).slice(4, 6)}-${code(a).slice(6, 8)}T00:00:00Z`);
    const end = code(b);
    for (let i = 0; i < 400; i++) {
      const c = d.toISOString().slice(0, 10).replace(/-/g, "");
      if (c > end) break;
      out.add(c);
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  return [...out].sort();
}

export function timeInWindow(timeCode: number, w: TimeWindow): boolean {
  const p = PERIODS[w.toLowerCase()];
  if (p) return timeCode >= p[0] && timeCode < p[1];
  const m = w.match(/^(\d{1,2}):?(\d{2})\s*-\s*(\d{1,2}):?(\d{2})$/);
  if (!m) return true;
  const lo = +m[1] * 100 + +m[2], hi = +m[3] * 100 + +m[4];
  return lo <= hi ? timeCode >= lo && timeCode <= hi : timeCode >= lo || timeCode <= hi;
}

const minutes = (hhmm: number) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

export function cinemaMatches(show: Show, spec: string): boolean {
  const s = spec.trim();
  if (/^[A-Z0-9]{3,6}$/.test(s) && show.venueCode === s) return true;
  return show.venueName.toLowerCase().includes(s.toLowerCase());
}

export function showMatches(w: Watch, show: Show, dates: Set<string>): boolean {
  if (dates.size && !dates.has(show.dateCode)) return false;
  const label = showFormatLabel(show.format, show.screenAttr);
  if (w.formats?.length && !w.formats.some((f) => formatMatches(label, f))) return false;
  if (w.excludeFormats?.some((f) => formatMatches(label, f))) return false;
  if (w.times?.length && !w.times.some((t) => timeInWindow(show.timeCode, t))) return false;
  if (w.type === "movie") {
    if (w.cinemas?.length && !w.cinemas.some((c) => cinemaMatches(show, c))) return false;
    if (w.excludeCinemas?.some((c) => cinemaMatches(show, c))) return false;
  } else {
    if (!cinemaMatches(show, w.cinema)) return false;
    if (w.time) {
      const t = +w.time.replace(":", "");
      if (Math.abs(minutes(show.timeCode) - minutes(t)) > (w.toleranceMinutes ?? 45)) return false;
    }
  }
  return true;
}

export function categoryMatches(w: Watch, c: Category): boolean {
  if (w.categories?.length && !w.categories.some((x) => c.name.toLowerCase().includes(x.toLowerCase()))) return false;
  if (w.maxPrice && c.price > w.maxPrice) return false;
  return true;
}
