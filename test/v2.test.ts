import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, parseDateSpec, parseWatchUrl, districtShows, districtLanguages, districtSessionDates, districtState, rankShows, DistrictClient, districtRegion, diffWatch, buildNotification, expandDates } from "../packages/core/src/index.ts";
import type { MovieWatch } from "../packages/core/src/index.ts";

const today = new Date("2026-11-23T04:00:00Z");
const BMS = "https://in.bookmyshow.com/movies/national-capital-region-ncr/avengers-doomsday/buytickets/ET00526306/20261217?language=english";
const DIST = "https://www.district.in/movies/avengers-doomsday-movie-tickets-in-delhi-ncr-MV176735";

test("watch URLs: BMS and District", () => {
  assert.equal(parseWatchUrl(BMS).source, "bms");
  const d = parseWatchUrl(DIST + "?frmtid=mm5dpqtqjz&fromdate=2026-12-18");
  assert.deepEqual([d.source, d.citySlug, d.movieSlug, d.eventCode, d.dateCode], ["district", "delhi-ncr", "avengers-doomsday", "MV176735", "20261218"]);
});

test("date specs", () => {
  assert.deepEqual(parseDateSpec("17-12..25-12", today), ["2026-12-17..2026-12-25"]);
  assert.deepEqual(parseDateSpec("17..20", today, 12), ["2026-12-17..2026-12-20"]);
  assert.deepEqual(parseDateSpec("3-1", today), ["2027-01-03"], "past month rolls to next year");
  assert.deepEqual(parseDateSpec("2026-12-18,19/12", today), ["2026-12-18", "2026-12-19"]);
  assert.equal(expandDates(parseDateSpec("17-12..25-12", today)).length, 9);
});

test("commands", () => {
  const a = parseCommand(`/add ${BMS} dates=17..25 formats=pxl,4dx cinemas="superplex logix,mall of india" times=evening,night class=recliner seats=2 max=1500`, today);
  assert.equal(a.cmd, "add");
  if (a.cmd !== "add" || a.watch.type !== "movie") throw new Error();
  assert.deepEqual(a.watch.dates, ["2026-12-17..2026-12-25"]);
  assert.deepEqual(a.watch.formats, ["PXL", "4DX"]);
  assert.deepEqual(a.watch.cinemas, ["superplex logix", "mall of india"]);
  assert.equal(a.watch.minSeats, 2); assert.equal(a.watch.maxPrice, 1500); assert.equal(a.watch.language, "english");
  const s = parseCommand(`/show ${BMS} cinema=PVLE time=19:30 seats=2 class=recliner`, today);
  assert.ok(s.cmd === "add" && s.watch.type === "show" && s.watch.cinema === "PVLE" && s.watch.seats?.count === 2);
  assert.equal(parseCommand(BMS, today).cmd, "add", "bare link = /add");
  assert.equal(parseCommand(`/show ${BMS}`, today).cmd, "error");
  assert.deepEqual(parseCommand("/pause b2"), { cmd: "pause", id: "b2" });
  const b = parseCommand(`/best ${DIST} date=18-12 seats=2 time=19:30`, today);
  assert.ok(b.cmd === "best" && b.dates[0] === "2026-12-18" && b.seats === 2 && b.time === "19:30");
  assert.equal(parseCommand("/nope").cmd, "error");
});

// Shape copied from a live District response (23 Nov 2026), trimmed.
const page = (date: string, sessions: any[]) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { data: { serverState: {
  movieContents: { "176735": { languageFormatGroups: [{ language: "English", fmtGrpId: "Mm5dpqTqJz" }, { language: "Hindi", fmtGrpId: "zdwDdFFDqQ" }] } },
  movieSessions: { [`mm5dpqtqjz${date}`]: { searchDate: date, meta: { movie: { name: "Avengers: Doomsday" } }, data: { sessionDates: ["2026-12-17", "2026-12-18"] },
    arrangedSessions: [{ data: { id: 1022277, name: "PVR ECX, Chanakyapuri, New Delhi" }, sessions }] } },
} } } } })}</script></html>`;
const sess = (sid: string, date: string, time: string, local: string, fmt: string, areas: any[]) =>
  ({ sid, showDate: date, showTimeText: time, showTimeLocal: `${date}T${local}:00`, scrnFmt: fmt, audi: "AUDI 01", areas });

test("District parser", () => {
  const st = districtState(page("2026-12-17", [sess("16630", "2026-12-17", "09:00 AM", "09:00", "MS INFINITY VISION 4DX-3D", [
    { code: "CR", label: "CLASSIC ROWS", price: 750, sAvail: 128, sTotal: 130, statusColor: "G" },
    { code: "MR", label: "RECLINER", price: 1400, sAvail: 0, sTotal: 36, statusColor: "R" }])]));
  assert.deepEqual(districtLanguages(st).map((l) => l.language), ["English", "Hindi"]);
  assert.deepEqual(districtSessionDates(st), ["20261217", "20261218"]);
  const [s] = districtShows(st, "Mm5dpqTqJz");
  assert.equal(s.venueCode, "D1022277"); assert.equal(s.timeCode, 900); assert.equal(s.dateCode, "20261217");
  assert.deepEqual(s.categories.map((c) => [c.name, c.status, c.seatsAvail]), [["CLASSIC ROWS", 3, 128], ["RECLINER", 0, 0]]);
});

test("District snapshot + diff + minSeats + ranked booking buttons", async () => {
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    const d = new URL(url).searchParams.get("fromdate") || "2026-12-17";
    return { status: 200, body: page(d, [
      sess(`A${d}`, d, "07:30 PM", "19:30", "MS INFINITY VISION 3D PXL", [{ label: "RECLINER", price: 1400, sAvail: 6, sTotal: 36, statusColor: "Y" }]),
      sess(`B${d}`, d, "10:30 PM", "22:30", "MS INFINITY VISION 3D", [{ label: "RECLINER", price: 1400, sAvail: 1, sTotal: 36, statusColor: "R" }]),
    ]) };
  };
  const c = new DistrictClient({ fetcher, sleep: async () => {} });
  const snap = await c.snapshot(districtRegion("delhi-ncr"), "avengers-doomsday", "MV176735", ["20261218"], "english");
  assert.ok(snap.complete, snap.failures.join());
  assert.ok(!urls.some((u) => u.includes("zdwddffdqq")), "language filter avoids Hindi pages");
  const w: MovieWatch = { id: "d", type: "movie", url: DIST, dates: ["2026-12-18"], categories: ["recliner"], minSeats: 2 };
  const r = diffWatch(w, snap, undefined, today);
  const news = r.changes.filter((x) => x.kind === "NEW_SHOW");
  assert.equal(news.length, 1, "show with 1 seat left filtered by minSeats");
  assert.match(news[0].link, /frmtid=mm5dpqtqjz&fromdate=2026-12-18/);
  const n = buildNotification(w, snap.movieName, r.changes, "District");
  assert.match(n.text, /6\/36 left/);
  assert.ok(n.buttons && n.buttons.length >= 1 && /PVR ECX/.test(n.buttons[0].text));
  const ranked = rankShows(snap.shows, { seats: 2, categories: ["recliner"], preferTime: "22:00" });
  assert.equal(ranked.length, 1);
});
