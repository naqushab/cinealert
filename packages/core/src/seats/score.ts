// "Perfect seats": find blocks of N adjacent available seats and rank them by
//  - depth: distance from the screen vs. an ideal (~2/3 back), front rows rejected
//  - centre: how close the block's middle is to the row's (physical) centre
//  - area: preferred seat class bonus
import type { SeatMap, SeatRow } from "./model.ts";
import type { SeatPrefs } from "../types.ts";

export interface SeatPick { row: string; area: string; price: number; seats: string[]; score: number; depth: number; centre: number }

export function findBestSeats(map: SeatMap, prefs: SeatPrefs, top = 5): SeatPick[] {
  const count = Math.max(1, prefs.count || 1);
  const ideal = prefs.idealDepth ?? 0.65;
  const minDepth = prefs.minDepth ?? 0.3;
  const areas = (prefs.areas || []).map((a) => a.toLowerCase());
  const nRows = map.rows.length;
  const allCols = map.rows.flatMap((r) => r.seats.map((s) => s.col));
  const centreCol = allCols.length ? (Math.min(...allCols) + Math.max(...allCols)) / 2 : 0;
  const halfWidth = allCols.length ? Math.max(1, (Math.max(...allCols) - Math.min(...allCols)) / 2) : 1;
  const picks: SeatPick[] = [];

  map.rows.forEach((row: SeatRow, i) => {
    const depth = nRows > 1 ? i / (nRows - 1) : 0.5;
    const lab = row.label.toUpperCase();
    if (prefs.fromRow || prefs.toRow) {
      if (prefs.fromRow && lab < prefs.fromRow.toUpperCase()) return;
      if (prefs.toRow && lab > prefs.toRow.toUpperCase()) return;
    } else if (depth < minDepth) return;
    if (areas.length && !areas.some((a) => row.area.toLowerCase().includes(a))) return;
    const seats = [...row.seats].sort((a, b) => a.col - b.col);
    for (let s = 0; s + count <= seats.length; s++) {
      const block = seats.slice(s, s + count);
      if (block.some((x) => x.status !== "available")) continue;
      if (block.some((x, k) => k > 0 && x.col - block[k - 1].col !== 1)) continue; // aisle/gap splits block
      const mid = (block[0].col + block[block.length - 1].col) / 2;
      const offset = Math.abs(mid - centreCol) / halfWidth;
      if (prefs.centre !== undefined && offset > prefs.centre) continue;
      const centre = 1 - Math.min(1, offset);
      const depthScore = 1 - Math.min(1, Math.abs(depth - ideal) / Math.max(ideal, 1 - ideal));
      const score = +(0.55 * centre + 0.45 * depthScore).toFixed(3);
      picks.push({ row: row.label, area: row.area, price: row.price, seats: block.map((x) => x.id), score, depth: +depth.toFixed(2), centre: +centre.toFixed(2) });
    }
  });
  picks.sort((a, b) => b.score - a.score);
  // one best block per row keeps the list useful
  const seenRows = new Set<string>();
  return picks.filter((p) => (seenRows.has(p.row) ? false : (seenRows.add(p.row), true))).slice(0, top);
}

export function seatSummary(p: SeatPick): string {
  return `Row ${p.row} ${p.seats.join(", ")} · ${p.area} ₹${p.price} · score ${(p.score * 100).toFixed(0)}`;
}
