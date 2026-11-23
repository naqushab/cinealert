import type { Fetcher, Region, Show, Snapshot } from "../types.ts";
import { districtLanguages, districtMovieName, districtSessionDates, districtShows, districtState } from "./parse.ts";

const UA_HEADERS = { Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-IN,en;q=0.9" };

export interface DistrictOptions { fetcher: Fetcher; sleep?: (ms: number) => Promise<void>; minGapMs?: number; log?: (s: string) => void }

export const districtMovieUrl = (movieSlug: string, citySlug: string, mv: string) =>
  `https://www.district.in/movies/${movieSlug}-movie-tickets-in-${citySlug}-${mv}`;
export const districtDateUrl = (base: string, fmtGrpId: string, dateCode: string) =>
  `${base}?frmtid=${fmtGrpId.toLowerCase()}&fromdate=${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}`;

export class DistrictClient {
  requests = 0;
  failures: string[] = [];
  private blocked = false;
  private cache = new Map<string, any | null>();
  private o: Required<DistrictOptions>;
  constructor(o: DistrictOptions) {
    this.o = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), minGapMs: 1500, log: () => {}, ...o };
  }

  async page(url: string): Promise<any | null> {
    if (this.cache.has(url)) return this.cache.get(url);
    if (this.blocked) { this.failures.push(`${url}: skipped (blocked earlier)`); return null; }
    let state: any | null = null;
    for (let attempt = 0; attempt < 2 && !state; attempt++) {
      if (this.requests > 0) await this.o.sleep(this.o.minGapMs * (0.7 + Math.random() * 0.6) + attempt * 3000);
      this.requests++;
      try {
        const r = await this.o.fetcher(url, UA_HEADERS);
        if (r.status === 200) {
          state = districtState(r.body);
          if (!state) this.failures.push(`${url}: no page data`);
          break;
        }
        this.o.log(`  District HTTP ${r.status} ${url}`);
        if (attempt === 1 || r.status === 404) { this.failures.push(`${url}: HTTP ${r.status}`); break; }
      } catch (e) {
        if (attempt === 1) this.failures.push(`${url}: ${(e as Error).message}`);
      }
    }
    if (!state) this.blocked = true;
    this.cache.set(url, state);
    return state;
  }

  async snapshot(region: Region, movieSlug: string, mv: string, wantedDates: string[], language?: string): Promise<Snapshot> {
    const before = { r: this.requests, f: this.failures.length };
    const base = districtMovieUrl(movieSlug, region.slug, mv);
    const shows = new Map<string, Show>();
    let movieName = "";
    let open: string[] = [];
    let langs: { language: string; fmtGrpId: string }[] = [];
    const first = await this.page(base);
    if (first) {
      movieName = districtMovieName(first);
      langs = districtLanguages(first);
      const wanted = language ? langs.filter((l) => l.language.toLowerCase() === language.toLowerCase()) : langs;
      if (language && !wanted.length) this.failures.push(`language "${language}" not offered (has: ${langs.map((l) => l.language).join(", ")})`);
      for (const g of wanted) {
        const st = await this.page(`${base}?frmtid=${g.fmtGrpId.toLowerCase()}`);
        if (!st) continue;
        const dates = districtSessionDates(st);
        open = [...new Set([...open, ...dates])];
        const ask = wantedDates.length ? dates.filter((d) => wantedDates.includes(d)) : dates.slice(0, 7);
        for (const dc of ask) {
          const ds = await this.page(districtDateUrl(base, g.fmtGrpId, dc));
          if (!ds) continue;
          for (const s of districtShows(ds, g.fmtGrpId)) {
            s.format = g.language;
            shows.set(`${s.venueCode}|${s.sessionId}|${s.dateCode}`, s);
          }
        }
      }
    }
    const failures = this.failures.slice(before.f);
    const fmtOf = new Map(langs.map((l) => [l.fmtGrpId, l.fmtGrpId]));
    return {
      source: "district", eventCode: mv, region, movieName,
      formats: langs.map((l) => ({ eventCode: l.fmtGrpId, title: l.language })),
      dates: open.sort().map((d) => ({ dateCode: d, status: "AVAILABLE" as const })),
      shows: [...shows.values()],
      complete: !!first && failures.length === 0,
      failures, requests: this.requests - before.r,
      // District's seat-layout links fail when opened cold, so link to the date + language page.
      showLink: (s) => districtDateUrl(base, fmtOf.get(s.eventCode) || s.eventCode, s.dateCode),
      dateLink: (dc) => districtDateUrl(base, langs[0]?.fmtGrpId || "", dc),
    };
  }
}

/** District city slugs differ from BMS ones. */
export function districtRegion(citySlug: string): Region {
  return { name: citySlug, code: `D:${citySlug}`, slug: citySlug, lat: "", lon: "", geohash: "" };
}
