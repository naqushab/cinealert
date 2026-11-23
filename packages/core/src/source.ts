// One entry point for any supported link. Watches may point at BookMyShow or District.
import type { SourceName } from "./types.ts";
import { parseBmsUrl } from "./url.ts";

export interface WatchTarget {
  source: SourceName;
  citySlug: string;
  movieSlug: string;
  eventCode: string;       // BMS ET code | District content id ("MV176735")
  dateCode?: string;
  venueCode?: string;
  sessionId?: string;
  language?: string;
  url: string;             // canonical movie URL for the city
}

const DISTRICT_RE = /district\.in\/movies\/([a-z0-9-]+?)-movie-tickets(?:-in-([a-z0-9-]+?))?-(MV\d+)/i;

export function parseWatchUrl(raw: string, cityOverride?: string): WatchTarget {
  const text = raw || "";
  const d = text.match(DISTRICT_RE);
  if (d) {
    const citySlug = (cityOverride || d[2] || "").toLowerCase();
    if (!citySlug) throw new Error("District link has no city (...-movie-tickets-in-<city>-MV...). Add \"city\" to the watch.");
    const u = new URL((text.match(/https?:\/\/\S+/) || [text])[0]);
    const fd = u.searchParams.get("fromdate");
    return {
      source: "district", citySlug, movieSlug: d[1].toLowerCase(), eventCode: d[3].toUpperCase(),
      dateCode: fd ? fd.replace(/-/g, "") : undefined,
      url: `https://www.district.in/movies/${d[1].toLowerCase()}-movie-tickets-in-${citySlug}-${d[3].toUpperCase()}`,
    };
  }
  const b = parseBmsUrl(text);
  const citySlug = cityOverride || b.citySlug;
  return { source: "bms", ...b, citySlug, url: `https://in.bookmyshow.com/movies/${citySlug}/${b.movieSlug || "movie"}/${b.eventCode}` };
}

export function isSupportedLink(text: string): boolean {
  return DISTRICT_RE.test(text) || /bookmyshow\.com\/\S*ET\d{8,}/i.test(text);
}
