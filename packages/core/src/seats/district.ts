// District seat-layout page: every seat element carries an aria-label like
//   "available  seat, class PRIME, row K, column 13, price 1000"
//   "unavailable seat, class RECLINER, row Q, column 4"
// Rows are listed back (furthest from screen) first. Column numbers are physical, so a
// missing number (e.g. 8, 19) is an aisle and splits blocks. Verified 23 Nov 2026.
import type { SeatMap, SeatRow } from "./model.ts";

const RE = /^(\w+)\s+seat, class (.+?), row (\w+), column (\d+)(?:, price (\d+))?/i;

export function seatMapFromLabels(labels: string[], venueCode: string, sessionId: string): SeatMap {
  const rows = new Map<string, SeatRow>();
  const order: string[] = [];
  for (const raw of labels) {
    const m = raw.trim().match(RE);
    if (!m) continue;
    let r = rows.get(m[3]);
    if (!r) { r = { label: m[3], area: m[2].trim(), price: Number(m[5] || 0), seats: [] }; rows.set(m[3], r); order.push(m[3]); }
    if (m[5] && !r.price) r.price = Number(m[5]);
    r.seats.push({ id: `${m[3]}${m[4]}`, col: Number(m[4]), status: m[1].toLowerCase() === "available" ? "available" : "sold" });
  }
  return { venueCode, sessionId, source: "district-page", rows: order.reverse().map((k) => rows.get(k)!) };
}

export const districtSeatUrl = (fmtGrpId: string, encSessionId: string, dateCode: string, contentId: string) =>
  `https://www.district.in/movies/seat-layout/${fmtGrpId}?encsessionid=${encSessionId}&fromdate=${dateCode.slice(0, 4)}-${dateCode.slice(4, 6)}-${dateCode.slice(6, 8)}&freeseating=false&fromsessions=true&type=MOVIES&contentid=${contentId.replace(/^MV/i, "")}`;
