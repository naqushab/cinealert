// Learned cinema catalogue: every cinema any check has seen in a city, with the formats it has
// screened (for any movie). Used to tell "cinema doesn't exist / typo" from "not showing this yet",
// and "this hall never shows PXL" from "PXL isn't listed yet".
import type { Snapshot, SourceName } from "./types.ts";
import { FORMAT_ALIASES, formatMatches, showFormatLabel } from "./formats.ts";

export interface VenueInfo { name: string; formats: string[]; lastSeen: string }
export interface Catalog { cities: Record<string, Record<string, VenueInfo>> }   // key: "<source>|<city>"

export const emptyCatalog = (): Catalog => ({ cities: {} });
export const cityKey = (source: SourceName | undefined, city: string) => `${source || "bms"}|${city}`;

/** Canonical format keys present in a label, e.g. "MS-Infinity Vsn 3d PXL" → ["PXL","INFINITY_VISION","3D"]. */
export function formatKeys(label: string): string[] {
  return Object.keys(FORMAT_ALIASES).filter((k) => formatMatches(label, k));
}

export function learn(cat: Catalog, snap: Snapshot, now = new Date()): number {
  const key = cityKey(snap.source, snap.region.slug);
  const city = (cat.cities[key] ||= {});
  let added = 0;
  for (const s of snap.shows) {
    const v = city[s.venueCode] || (added++, (city[s.venueCode] = { name: s.venueName, formats: [], lastSeen: "" }));
    v.name = s.venueName;
    v.lastSeen = now.toISOString().slice(0, 10);
    for (const f of formatKeys(showFormatLabel(s.format, s.screenAttr))) if (!v.formats.includes(f)) v.formats.push(f);
  }
  return added;
}

export function cityVenues(cat: Catalog, source: SourceName | undefined, city: string): [string, VenueInfo][] {
  return Object.entries(cat.cities[cityKey(source, city)] || {});
}
