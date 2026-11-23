// Parses every BMS link shape we've seen:
//  /movies/<city>/<movie-slug>/<ET>                                  movie page
//  /movies/<city>/<movie-slug>/buytickets/<ET>/<YYYYMMDD>?...        showtimes page
//  /movies/<city>/seat-layout/<ET>/<VENUE>/<SESSION>/<YYYYMMDD>      seat layout
//  /buytickets/<slug>-<city>/movie-<city>-<ET>-MT/<YYYYMMDD>         legacy
export interface ParsedBmsUrl {
  citySlug: string;
  movieSlug: string;
  eventCode: string;
  dateCode?: string;
  venueCode?: string;
  sessionId?: string;
  language?: string;
}

export function parseBmsUrl(raw: string): ParsedBmsUrl {
  const m = (raw || "").match(/https?:\/\/\S+/);
  const u = new URL(m ? m[0] : raw);
  if (!/bookmyshow\.com$/.test(u.hostname)) throw new Error(`Not a BookMyShow link: ${raw}`);
  const parts = u.pathname.split("/").filter(Boolean);
  const ev = parts.find((p) => /^ET\d{8,}$/i.test(p)) || (u.pathname.match(/(ET\d{8,})/i) || [])[1];
  if (!ev) throw new Error(`No event code (ET...) in ${raw}`);
  const out: ParsedBmsUrl = { citySlug: "", movieSlug: "", eventCode: ev.toUpperCase() };
  const date = parts.find((p) => /^\d{8}$/.test(p));
  if (date) out.dateCode = date;
  const mi = parts.indexOf("movies");
  if (mi >= 0) {
    out.citySlug = parts[mi + 1] || "";
    const next = parts[mi + 2] || "";
    if (next === "seat-layout") {
      out.venueCode = parts[mi + 4];
      out.sessionId = parts[mi + 5];
    } else if (!/^ET\d+$/i.test(next)) {
      out.movieSlug = next;
    }
  }
  const lang = u.searchParams.get("language");
  if (lang) out.language = lang.toLowerCase();
  return out;
}

export function buyUrl(citySlug: string, movieSlug: string, eventCode: string, dateCode: string): string {
  return `https://in.bookmyshow.com/movies/${citySlug}/${movieSlug || "movie"}/buytickets/${eventCode}/${dateCode}`;
}

export function seatLayoutUrl(citySlug: string, eventCode: string, venueCode: string, sessionId: string, dateCode: string): string {
  return `https://in.bookmyshow.com/movies/${citySlug}/seat-layout/${eventCode}/${venueCode}/${sessionId}/${dateCode}`;
}
