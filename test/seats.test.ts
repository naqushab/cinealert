import { test } from "node:test";
import assert from "node:assert/strict";
import { seatMapFromLabels, findBestSeats, districtSeatUrl } from "../packages/core/src/index.ts";

// Real seat state captured from District, PVR Superplex Mall of India, PXL (Screen 1), 19 Dec 8:30 PM.
// Row: class, available columns. Every other column listed in `cols` is taken.
const MID = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 26, 27];
const REAL: [string, string, number[], number[]][] = [
  ["Q", "RECLINER", [4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 16, 17, 20, 21, 22, 23, 24, 25], []],
  ["P", "RECLINER", [4, 5, 6, 7, 11, 12, 13, 14, 15, 16, 20, 21, 22, 23, 24, 25], []],
  ...["N", "M", "L", "K", "J"].map((r) => [r, "PRIME", MID, []] as [string, string, number[], number[]]),
  ["H", "XTRA LEGROOM", MID, []],
  ["G", "CLASSIC", MID, [2, 25, 26, 27]],
  ["F", "CLASSIC", MID, [1, 25, 26, 27]],
  ["E", "CLASSIC", MID, [25, 26, 27]],
  ["D", "CLASSIC", MID, [1, 2, 3, 4, 5, 6, 7, 12, 18, 20, 21, 22, 23, 24, 25, 26, 27]],
];
const labels = (rows = REAL) => rows.flatMap(([row, cls, cols, free]) => cols.map((c) =>
  free.includes(c) ? `available  seat, class ${cls}, row ${row}, column ${c}, price 1000  ` : `unavailable seat, class ${cls}, row ${row}, column ${c}`));
const PREFS = { count: 2, fromRow: "G", centre: 0.5 };

test("District labels → seat map (front row first, aisles kept as gaps)", () => {
  const m = seatMapFromLabels(labels(), "DTYN", "37489");
  assert.equal(m.rows[0].label, "D"); assert.equal(m.rows.at(-1)!.label, "Q");
  assert.equal(m.rows.find((r) => r.label === "G")!.seats.filter((s) => s.status === "available").length, 4);
});

test("real 8:30 PM map: only edge seats free → no middle pair from row G", () => {
  const m = seatMapFromLabels(labels(), "DTYN", "37489");
  assert.deepEqual(findBestSeats(m, PREFS), []);
  // without the middle rule, G25+G26 (right edge) would qualify
  assert.equal(findBestSeats(m, { count: 2, fromRow: "G" })[0].seats.join(), "G25,G26");
  // row D (front) has a middle-ish pair but is excluded by fromRow
  assert.ok(findBestSeats(m, { count: 2, centre: 0.5, fromRow: "A" }).some((p) => p.row === "D"));
});

test("a cancellation of K13+K14 is found; K18+K20 across the aisle is not", () => {
  const rows = REAL.map((r) => (r[0] === "K" ? [r[0], r[1], r[2], [13, 14, 18, 20]] : r)) as typeof REAL;
  const best = findBestSeats(seatMapFromLabels(labels(rows), "DTYN", "1"), PREFS);
  assert.equal(best.length, 1);
  assert.deepEqual([best[0].row, best[0].seats], ["K", ["K13", "K14"]]);
});

test("seat-layout URL", () => {
  assert.equal(districtSeatUrl("Mm5dpqTqJz", "1024358-37489-obeovx-1024358", "20261219", "MV176735"),
    "https://www.district.in/movies/seat-layout/Mm5dpqTqJz?encsessionid=1024358-37489-obeovx-1024358&fromdate=2026-12-19&freeseating=false&fromsessions=true&type=MOVIES&contentid=176735");
});
