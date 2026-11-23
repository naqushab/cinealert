import { test } from "node:test";
import assert from "node:assert/strict";
import { validateWatch, emptyCatalog, learn, newDraft, render, onCallback, onText, draftToWatch, steps, parseCommand, resolveRegion } from "../packages/core/src/index.ts";
import type { Snapshot, Show, Watch } from "../packages/core/src/index.ts";

const URL_ = "https://in.bookmyshow.com/movies/national-capital-region-ncr/avengers-doomsday/buytickets/ET00526306/20261217";
const now = new Date("2026-11-23T04:30:00Z");
const show = (venueCode: string, venueName: string, dateCode: string, timeCode: number, format: string, screenAttr: string, cats: [string, number, number][]): Show =>
  ({ venueCode, venueName, sessionId: `${venueCode}${dateCode}${timeCode}`, eventCode: "E", dateCode, time: String(timeCode), timeCode, format, screenAttr,
    categories: cats.map(([name, price, status]) => ({ name, price, status: status as 0 | 1 | 2 | 3 })) });
const snap: Snapshot = {
  source: "bms", eventCode: "ET00526306", region: resolveRegion("ncr"), movieName: "Avengers: Doomsday", complete: true, failures: [], requests: 3,
  formats: [{ eventCode: "A", title: "MS-Infinity Vsn 3d" }, { eventCode: "B", title: "MS - Inf Vsn 4DX 3D" }],
  dates: [{ dateCode: "20261217", status: "BOOKABLE" }, { dateCode: "20261218", status: "AVAILABLE" }, { dateCode: "20261221", status: "NOT_OPEN" }],
  shows: [
    show("DTYN", "PVR: Superplex Mall Of India, Noida", "20261217", 1930, "MS-Infinity Vsn 3d", "PXL", [["RECLINER", 1600, 2], ["CLASSIC", 900, 3]]),
    show("DTYN", "PVR: Superplex Mall Of India, Noida", "20261217", 2215, "MS - Inf Vsn 4DX 3D", "4DX", [["CLASSIC", 1400, 3]]),
    show("PTCW", "PVR: Select City Walk, Delhi", "20261218", 1900, "MS-Infinity Vsn 3d", "", [["CLASSIC", 800, 2]]),
  ],
};

const w = (o: Partial<Watch>): Watch => ({ id: "x", type: "movie", url: URL_, ...o }) as Watch;
const has = (arr: string[], re: RegExp) => arr.some((x) => re.test(x));

test("validation: future-proof warnings, not failures", () => {
  const cat = emptyCatalog();
  learn(cat, snap);
  learn(cat, { ...snap, shows: [show("PVLE", "PVR: Superplex Logix, Noida", "20261210", 1800, "IMAX 3D", "", [["CLASSIC", 700, 3]])] });

  let v = validateWatch(w({ formats: ["IMAX"] }), snap, cat, now);
  assert.equal(v.errors.length, 0); assert.ok(has(v.warnings, /isn't listed in IMAX right now/));

  v = validateWatch(w({ cinemas: ["logix"] }), snap, cat, now);
  assert.ok(has(v.warnings, /Superplex Logix.*isn't showing this movie right now/), "known cinema, not showing yet");

  v = validateWatch(w({ cinemas: ["xyzzy plex"] }), snap, cat, now);
  assert.ok(has(v.warnings, /none by that name has been seen/), "unknown cinema → spelling hint");

  v = validateWatch(w({ cinemas: ["select city"], formats: ["PXL"] }), snap, cat, now);
  assert.ok(has(v.warnings, /Select City Walk.*isn't showing it in PXL now/));

  v = validateWatch(w({ dates: ["2026-12-21..2026-12-22"] }), snap, cat, now);
  assert.ok(has(v.warnings, /None of your dates are open/));
  v = validateWatch(w({ dates: ["2026-11-01"] }), snap, cat, now);
  assert.ok(v.errors.length === 1, "all-past dates are an error");

  v = validateWatch({ id: "s", type: "show", url: URL_, cinema: "DTYN", time: "15:00", toleranceMinutes: 30 }, snap, cat, now);
  assert.ok(has(v.warnings, /No show near 15:00/));

  v = validateWatch(w({ categories: ["sofa"] }), snap, cat, now);
  assert.ok(has(v.warnings, /No seat class like "sofa"/));

  v = validateWatch(w({ language: "tamil" }), { ...snap, source: "district", formats: [{ eventCode: "x", title: "English" }] }, cat, now);
  assert.ok(has(v.warnings, /Language "tamil" isn't listed yet/));

  v = validateWatch(w({ formats: ["PXL"], dates: ["2026-12-17"] }), snap, cat, now);
  assert.deepEqual([v.errors.length, v.warnings.length, v.matchingShows], [0, 0, 1]);
});

test("wizard: link → taps → show watch", () => {
  assert.equal(parseCommand(URL_).cmd, "wizard", "bare link starts guided setup");
  assert.equal(parseCommand(`/add ${URL_} formats=pxl`).cmd, "add", "options = one-line add");
  const d = newDraft("k1", "1", URL_, snap, now);
  assert.equal(d.step, "dates");
  const tapLabel = (label: string) => {
    const kb = render(d).keyboard.flat();
    const b = kb.find((x) => x.text.replace("✅ ", "").startsWith(label));
    assert.ok(b, `button "${label}" in ${kb.map((x) => x.text).join(" | ")}`);
    const [, op, arg] = b!.data.split("|");
    return onCallback(d, op, arg);
  };
  tapLabel("Thu, 17 Dec");
  assert.equal(onText(d, "24-12..25-12", now), "");
  assert.deepEqual(d.sel.dates, ["20261217", "20261224", "20261225"]);
  tapLabel("Next");
  assert.equal(d.step, "formats");
  tapLabel("PXL");
  tapLabel("Next");
  assert.equal(d.step, "cinemas");
  assert.deepEqual(render(d).keyboard.flat().filter((b) => b.data.includes("|t|")).map((b) => b.text), ["PVR: Superplex Mall Of India,..."], "only PXL halls listed");
  tapLabel("PVR: Superplex");
  tapLabel("Next");
  assert.equal(d.step, "showtime");
  tapLabel("7:30 PM");
  tapLabel("Next");
  assert.equal(d.step, "classes", "times step skipped once a show time is picked");
  tapLabel("recliner"); tapLabel("Next");
  tapLabel("2"); tapLabel("Next");
  assert.equal(d.step, "review");
  assert.equal(steps(d).at(-1), "review");
  const watch = draftToWatch(d);
  assert.equal(watch.type, "show");
  assert.deepEqual(watch, { url: URL_, label: "Avengers: Doomsday · national-capital-region-ncr", dates: ["2026-12-17", "2026-12-24", "2026-12-25"], formats: ["PXL"],
    categories: ["recliner"], minSeats: 2, type: "show", cinema: "DTYN", time: "19:30", toleranceMinutes: 20, seats: { count: 2, areas: ["recliner"] } });
  assert.equal(tapLabel("Save"), "save");
});

test("wizard: typed unknown cinema is kept as a watched name; Any skips", () => {
  const d = newDraft("k2", "1", URL_, snap, now);
  onCallback(d, "next", ""); onCallback(d, "next", "");
  assert.equal(d.step, "cinemas");
  const note = onText(d, "Logix", now);
  assert.match(note, /added it as a name/);
  assert.deepEqual(d.sel.cinemas, ["Logix"]);
  onCallback(d, "any", "");
  assert.deepEqual(d.sel.cinemas, []);
  assert.equal(d.step, "times");
});

test("best: preferred time outranks emptier halls far from it", async () => {
  const { rankShows } = await import("../packages/core/src/index.ts");
  const mk = (id: string, tc: number, avail: number) => ({ venueCode: id, venueName: id, sessionId: id, eventCode: "e", dateCode: "20261218", time: String(tc), timeCode: tc, format: "", screenAttr: "",
    categories: [{ name: "RECLINER", price: 900, status: 3 as const, seatsAvail: avail, seatsTotal: 20 }] });
  const r = rankShows([mk("morning", 615, 20), mk("evening", 1915, 6)], { seats: 2, categories: ["recliner"], preferTime: "19:30" });
  assert.equal(r[0].show.venueCode, "evening");
  assert.ok(r[0].why.includes("15 min from your time"));
});
