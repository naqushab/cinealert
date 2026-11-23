import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBmsUrl, resolveRegion, expandDates, timeInWindow, formatMatches, chipsToFetch, BmsClient, diffWatch,
  findBestSeats, seatMapFromAscii, buildNotification, emptyState, healthUpdate,
} from "../packages/core/src/index.ts";
import type { Fetcher, MovieWatch, ShowWatch } from "../packages/core/src/index.ts";
import { primaryDynamic } from "./fixtures/build.ts";

const USER_URL = "https://in.bookmyshow.com/movies/national-capital-region-ncr/avengers-doomsday/buytickets/ET00526306/20261217?etCodes=ET00526306&language=english&refEventCode=ET00526306";

test("parses the user's buytickets URL", () => {
  const u = parseBmsUrl(USER_URL);
  assert.deepEqual(u, { citySlug: "national-capital-region-ncr", movieSlug: "avengers-doomsday", eventCode: "ET00526306", dateCode: "20261217", language: "english" });
  assert.equal(resolveRegion(u.citySlug).code, "NCR");
});

test("parses seat-layout URLs and share text", () => {
  const u = parseBmsUrl("Book now! https://in.bookmyshow.com/movies/chennai/seat-layout/ET00478890/INTO/12345/20261218");
  assert.equal(u.venueCode, "INTO"); assert.equal(u.sessionId, "12345"); assert.equal(u.dateCode, "20261218");
});

test("date ranges and time windows", () => {
  assert.equal(expandDates(["2026-12-17..2026-12-25"]).length, 9);
  assert.deepEqual(expandDates(["2026-12-31..2027-01-01"]), ["20261231", "20270101"]);
  assert.ok(timeInWindow(1930, "night")); assert.ok(!timeInWindow(1030, "evening"));
  assert.ok(timeInWindow(2330, "22:00-01:00")); assert.ok(timeInWindow(30, "22:00-01:00"));
});

test("format matching across chip title and screen label", () => {
  assert.ok(formatMatches("IMAX 3D", "IMAX"));
  assert.ok(formatMatches("3D PXL", "PXL"));
  assert.ok(formatMatches("MS INFVSN ICE 3D", "INFINITY_VISION"));
  assert.ok(formatMatches("3D Infinity Vision", "infinity vision"));
  assert.ok(formatMatches("MS-Infinity Vsn 3d PXL", "INFINITY_VISION") && formatMatches("MS-Infinity Vsn 3d PXL", "PXL"));
  assert.ok(formatMatches("MS - Inf Vsn 4DX 3D 4DX", "4DX") && !formatMatches("MS-Infinity Vsn 3d", "IMAX"));
  assert.ok(!formatMatches("2D", "3D"));
  const chips = [{ title: "2D" }, { title: "3D" }, { title: "IMAX 3D" }];
  assert.deepEqual(chipsToFetch(chips, ["IMAX"]).map((c) => c.title), ["IMAX 3D"]);
  assert.equal(chipsToFetch(chips, ["IMAX", "PXL"]).length, 3, "PXL is a screen label -> need all chips");
});

function fakeFetcher(routes: Record<string, unknown>, calls: string[] = []): Fetcher {
  return async (url) => {
    const u = new URL(url);
    const key = `${u.searchParams.get("eventCode")}|${u.searchParams.get("dateCode")}`;
    calls.push(key);
    return key in routes ? { status: 200, body: JSON.stringify(routes[key]) } : { status: 403, body: "blocked" };
  };
}
const noSleep = async () => {};

const IMAX = "ET1IMAX", BASE = "ET00526306";
const chips: [string, string][] = [[BASE, "3D"], [IMAX, "IMAX 3D"]];
const dates: [string, string][] = [["20261217", "date-selected"], ["20261218", "date-default"], ["20261219", "date-disabled"]];
const show = (date: string, cats: [string, number, number][], over: Partial<{ venue: string; code: string; session: string; tc: number; time: string; screen: string }> = {}) =>
  ({ venue: "PVR: Logix, Noida", code: "PVLX", session: `S${date}`, date, time: "07:30 PM", tc: 1930, cats, ...over });

test("snapshot fans out over format chips and strip dates, then diff alerts", async () => {
  const calls: string[] = [];
  const routes = {
    [`${BASE}|`]: primaryDynamic({ event: BASE, chips, dates, shows: [show("20261217", [["RECLINER", 900, 3]], { screen: "PXL", session: "P1" })] }),
    [`${IMAX}|`]: primaryDynamic({ event: IMAX, chips, dates, shows: [show("20261217", [["PRIME", 650, 3], ["CLASSIC", 400, 0]])] }),
    [`${BASE}|20261218`]: primaryDynamic({ event: BASE, chips, dates, shows: [] }),
    [`${IMAX}|20261218`]: primaryDynamic({ event: IMAX, chips, dates, shows: [show("20261218", [["PRIME", 650, 2]], { code: "PVSC", venue: "PVR: Select Citywalk" })] }),
  };
  const c = new BmsClient({ fetcher: fakeFetcher(routes, calls), sleep: noSleep });
  const snap = await c.snapshot(resolveRegion("ncr"), BASE, expandDates(["2026-12-17..2026-12-25"]), ["IMAX", "PXL"]);
  assert.ok(snap.complete, snap.failures.join());
  assert.equal(snap.shows.length, 3);
  assert.ok(!calls.includes(`${BASE}|20261219`), "disabled date not requested");

  const w: MovieWatch = { id: "w", type: "movie", url: USER_URL, dates: ["2026-12-17..2026-12-25"], formats: ["IMAX", "PXL"] };
  const t0 = new Date("2026-12-01T10:00:00Z");
  const r1 = diffWatch(w, snap, undefined, t0);
  assert.deepEqual(r1.changes.filter((x) => x.kind === "DATE_OPENED").map((x) => x.dateCode), ["20261217", "20261218"]);
  assert.equal(r1.changes.filter((x) => x.kind === "NEW_SHOW").length, 3, "sold-out CLASSIC not alerted");
  const n = buildNotification(w, snap.movieName, r1.changes);
  assert.match(n.title, /bookings open/); assert.equal(n.priority, "urgent");

  // same data next hour -> silence
  assert.equal(diffWatch(w, snap, r1.next, new Date(t0.getTime() + 3600e3)).changes.length, 0);

  // CLASSIC comes back after being sold out -> BACK_IN_STOCK (if cinema filter allows)
  const snap2 = structuredClone(snap);
  snap2.shows.find((s) => s.categories.some((c) => c.name === "CLASSIC"))!.categories.find((c) => c.name === "CLASSIC")!.status = 3;
  const r3 = diffWatch(w, snap2, r1.next, new Date(t0.getTime() + 3600e3));
  assert.deepEqual(r3.changes.map((x) => x.kind), ["BACK_IN_STOCK"]);
});

test("a refused request makes the snapshot incomplete and stops further requests", async () => {
  const calls: string[] = [];
  const routes = { [`${BASE}|`]: primaryDynamic({ event: BASE, chips, dates }) }; // IMAX chip -> 403
  const c = new BmsClient({ fetcher: fakeFetcher(routes, calls), sleep: noSleep });
  const snap = await c.snapshot(resolveRegion("ncr"), BASE, ["20261217", "20261218"], ["IMAX"]);
  assert.equal(snap.complete, false);
  assert.equal(calls.filter((k) => k.startsWith(IMAX)).length, 2, "one retry, then give up");
});

test("show watch: one cinema, near a time, seat class filter", () => {
  const w: ShowWatch = { id: "s", type: "show", url: USER_URL, cinema: "PVLX", time: "19:30", toleranceMinutes: 30, categories: ["recliner"] };
  const snap = { eventCode: BASE, region: resolveRegion("ncr"), movieName: "X", formats: [], dates: [], complete: true, failures: [], requests: 1,
    shows: [
      { venueCode: "PVLX", venueName: "PVR Logix", sessionId: "1", eventCode: BASE, dateCode: "20261218", time: "07:45 PM", timeCode: 1945, format: "IMAX 3D", screenAttr: "", categories: [{ name: "RECLINER", price: 900, status: 3 as const }, { name: "PRIME", price: 600, status: 3 as const }] },
      { venueCode: "PVLX", venueName: "PVR Logix", sessionId: "2", eventCode: BASE, dateCode: "20261218", time: "10:30 PM", timeCode: 2230, format: "IMAX 3D", screenAttr: "", categories: [{ name: "RECLINER", price: 900, status: 3 as const }] },
    ] };
  const r = diffWatch(w, snap, undefined, new Date("2026-12-01T00:00:00Z"));
  const shows = r.changes.filter((c) => c.kind === "NEW_SHOW");
  assert.equal(shows.length, 1); assert.equal(shows[0].category!.name, "RECLINER");
});

test("perfect seats: centred block, mid-back, respects gaps and count", () => {
  const map = seatMapFromAscii([
    "A:CLASSIC:300:AAAAA_AAAAA",
    "B:CLASSIC:300:AAAAA_AAAAA",
    "C:PRIME:500:...AA_AA...",
    "D:PRIME:500:..AAA_AAA..",
    "E:PRIME:500:AA..._...AA",
    "F:RECLINER:900:A.A.A_A.A.A",
  ]);
  const best = findBestSeats(map, { count: 2 });
  assert.equal(best[0].row, "D");
  assert.ok(best.every((p) => p.row !== "A" && p.row !== "B"), "front rows rejected");
  assert.equal(findBestSeats(map, { count: 2, areas: ["recliner"] }).length, 0, "no two adjacent recliners");
  assert.equal(findBestSeats(map, { count: 4 }).length, 0, "aisle gap splits a block");
});

test("health hysteresis: warn after 3 fails, recover once", () => {
  const s = emptyState();
  assert.equal(healthUpdate(s, false), null); assert.equal(healthUpdate(s, false), null);
  assert.equal(healthUpdate(s, false), "warn"); assert.equal(healthUpdate(s, false), null);
  assert.equal(healthUpdate(s, true), "recovered");
});
