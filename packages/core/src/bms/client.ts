import type { Fetcher, FormatChip, Region, Show, Snapshot, DateStatus } from "../types.ts";
import { parseDates, parseFormats, parseMovieName, parseShows, recognised } from "./parse.ts";
import { chipsToFetch } from "../formats.ts";

const API = "https://in.bookmyshow.com/api/movies-data/v4/showtimes-by-event/primary-dynamic";

export function bmsHeaders(region: Region, eventCode: string): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-IN,en;q=0.9",
    Referer: `https://in.bookmyshow.com/movies/${region.slug}/buytickets/${eventCode}/`,
    Origin: "https://in.bookmyshow.com",
    "x-app-code": "WEB",
    "x-region-code": region.code,
    "x-region-slug": region.slug,
    "x-geohash": region.geohash,
    "x-latitude": region.lat,
    "x-longitude": region.lon,
    "x-location-selection": "manual",
    "x-lsid": "",
  };
}

export function showtimesUrl(region: Region, eventCode: string, dateCode: string): string {
  const q = new URLSearchParams({
    eventCode, dateCode, isDesktop: "true", regionCode: region.code, xLocationShared: "false",
    memberId: "", lsId: "", subCode: "", lat: region.lat, lon: region.lon,
  });
  return `${API}?${q}`;
}

export interface ClientOptions {
  fetcher: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  minGapMs?: number;   // politeness gap between requests (jittered)
  retryDelayMs?: number;
  log?: (s: string) => void;
}

/** One instance per run: caches responses, and stops asking after an unrecovered refusal
 *  (more requests only deepen a block; kyloprat lesson). */
export class BmsClient {
  private cache = new Map<string, any | null>();
  private blocked = false;
  requests = 0;
  failures: string[] = [];
  opts: Required<ClientOptions>;

  constructor(opts: ClientOptions) {
    this.opts = {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      minGapMs: 1500,
      retryDelayMs: 4000,
      log: () => {},
      ...opts,
    };
  }

  async showtimes(region: Region, eventCode: string, dateCode: string): Promise<any | null> {
    const key = `${region.code}|${eventCode}|${dateCode}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.blocked) { this.failures.push(`${key}: skipped (blocked earlier)`); return null; }
    let result: any | null = null;
    for (let attempt = 0; attempt < 2 && result === null; attempt++) {
      if (this.requests > 0) await this.opts.sleep(this.opts.minGapMs * (0.7 + Math.random() * 0.6));
      if (attempt > 0) await this.opts.sleep(this.opts.retryDelayMs);
      this.requests++;
      try {
        const r = await this.opts.fetcher(showtimesUrl(region, eventCode, dateCode), bmsHeaders(region, eventCode));
        if (r.status === 200) {
          const json = JSON.parse(r.body);
          if (recognised(json)) result = json;
          else this.failures.push(`${key}: unrecognised response shape`);
        } else {
          this.opts.log(`  HTTP ${r.status} for ${key}`);
          if (attempt === 1) this.failures.push(`${key}: HTTP ${r.status}`);
        }
      } catch (e) {
        this.opts.log(`  request error for ${key}: ${(e as Error).message}`);
        if (attempt === 1) this.failures.push(`${key}: ${(e as Error).message}`);
      }
    }
    if (result === null) this.blocked = true;
    this.cache.set(key, result);
    return result;
  }

  /** Full picture for one movie in one city on the wanted dates. */
  async snapshot(region: Region, eventCode: string, wantedDates: string[], wantedFormats: string[] = [], excludedFormats: string[] = []): Promise<Snapshot> {
    const before = { req: this.requests, fail: this.failures.length };
    const shows: Show[] = [];
    let dates: DateStatus[] = [];
    let formats: FormatChip[] = [{ eventCode, title: "" }];
    let movieName = "";

    const first = await this.showtimes(region, eventCode, "");
    if (first) {
      formats = parseFormats(first, eventCode);
      dates = parseDates(first);
      movieName = parseMovieName(first);
      const chips = chipsToFetch(formats, wantedFormats, excludedFormats);
      const strip = new Set(dates.filter((d) => d.status !== "NOT_OPEN").map((d) => d.dateCode));
      // "" returns the first open day; dated calls only work inside the 7-day strip.
      const firstDay = dates.find((d) => d.status === "BOOKABLE")?.dateCode || "";
      const datesToAsk = wantedDates.length ? wantedDates.filter((d) => strip.has(d)) : [...strip].slice(0, 7);
      for (const chip of chips) {
        for (const dc of new Set(["", ...datesToAsk])) {
          if (dc && dc === firstDay) continue; // "" already returned the first open day
          const data = chip.eventCode === eventCode && dc === "" ? first : await this.showtimes(region, chip.eventCode, dc);
          if (!data) continue;
          for (const s of parseShows(data, chip.eventCode, chip.title)) shows.push(s);
        }
      }
    }
    const unique = new Map<string, Show>();
    for (const s of shows) unique.set(`${s.venueCode}|${s.sessionId}|${s.dateCode}`, s);
    // A day beyond the strip is open when it has shows.
    const dateMap = new Map(dates.map((d) => [d.dateCode, d]));
    for (const s of unique.values()) if (s.dateCode && !dateMap.has(s.dateCode)) dateMap.set(s.dateCode, { dateCode: s.dateCode, status: "AVAILABLE" });
    const failures = this.failures.slice(before.fail);
    return {
      eventCode, region, movieName, formats,
      dates: [...dateMap.values()].sort((a, b) => a.dateCode.localeCompare(b.dateCode)),
      shows: [...unique.values()],
      complete: !!first && failures.length === 0,
      failures,
      requests: this.requests - before.req,
    };
  }
}
