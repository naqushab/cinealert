import { BmsClient, DistrictClient, districtRegion, parseWatchUrl, resolveRegion } from "../../packages/core/src/index.ts";
import type { Fetcher, Snapshot, Watch, WatchTarget } from "../../packages/core/src/index.ts";

export interface Clients { bms: BmsClient; district: DistrictClient; requests(): number }

export function makeClients(fetcher: Fetcher, log: (s: string) => void): Clients {
  const gap = Number(process.env.MIN_GAP_MS || 1500);
  const bms = new BmsClient({ fetcher, log, minGapMs: gap });
  const district = new DistrictClient({ fetcher, log, minGapMs: gap });
  return { bms, district, requests: () => bms.requests + district.requests };
}

export function groupKey(w: Watch): string {
  const t = parseWatchUrl(w.url, w.city);
  return t.source === "district"
    ? `district|${t.citySlug}|${t.eventCode}|${(w.language || t.language || "").toLowerCase()}`
    : `bms|${resolveRegion(t.citySlug).code}|${t.eventCode}`;
}

export async function snapshotFor(c: Clients, t: WatchTarget, dates: string[], formats: string[], language?: string): Promise<Snapshot> {
  if (t.source === "district") return c.district.snapshot(districtRegion(t.citySlug), t.movieSlug, t.eventCode, dates, language || t.language);
  return c.bms.snapshot(resolveRegion(t.citySlug), t.eventCode, dates, formats);
}
