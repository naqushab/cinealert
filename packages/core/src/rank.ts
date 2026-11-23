// "Best show" ranking: which show should you book right now? Uses whatever the source
// gives: exact seats left (District) or BMS availability status, plus your preferences.
import type { Show, Category, Watch } from "./types.ts";
import { categoryMatches, timeInWindow } from "./match.ts";
import { formatMatches, showFormatLabel } from "./formats.ts";

export interface RankedShow { show: Show; category: Category; score: number; why: string[] }

export interface RankPrefs { seats?: number; categories?: string[]; formats?: string[]; times?: string[]; preferTime?: string; maxPrice?: number }

const mins = (hhmm: number) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

export function rankShows(shows: Show[], p: RankPrefs, top = 5): RankedShow[] {
  const want = p.seats || 1;
  const out: RankedShow[] = [];
  const pseudo = { id: "_", type: "movie", url: "", categories: p.categories, maxPrice: p.maxPrice, minSeats: want } as Watch;
  for (const s of shows) {
    if (p.times?.length && !p.times.some((t) => timeInWindow(s.timeCode, t))) continue;
    const label = showFormatLabel(s.format, s.screenAttr);
    if (p.formats?.length && !p.formats.some((f) => formatMatches(label, f))) continue;
    for (const c of s.categories) {
      if (c.status <= 0 || !categoryMatches(pseudo, c)) continue;
      const why: string[] = [];
      // availability: exact ratio when known, else BMS status 1..3
      const avail = c.seatsAvail !== undefined && c.seatsTotal ? c.seatsAvail / c.seatsTotal : (c.status as number) / 3;
      let score = 0.4 * avail;
      why.push(c.seatsAvail !== undefined ? `${c.seatsAvail}/${c.seatsTotal} left` : ["", "almost full", "filling fast", "available"][c.status]);
      if (p.categories?.length) { score += 0.15; why.push("preferred class"); }
      if (p.formats?.length) { score += 0.1; }
      if (p.preferTime) {
        const d = Math.abs(mins(s.timeCode) - mins(+p.preferTime.replace(":", "")));
        score += 0.45 * Math.max(0, 1 - d / 150);
        if (d <= 45) why.push(d === 0 ? "at your time" : `${d} min from your time`);
      } else score += 0.1;
      out.push({ show: s, category: c, score: +score.toFixed(3), why });
    }
  }
  out.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return out.filter((r) => { const k = `${r.show.venueCode}|${r.show.sessionId}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, top);
}
