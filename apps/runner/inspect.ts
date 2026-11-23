// Shows what BMS currently lists for a link, to help write a watch:
//   node apps/runner/inspect.ts "<bms url>" [YYYYMMDD]
import { BmsClient, parseBmsUrl, resolveRegion, prettyDate } from "../../packages/core/src/index.ts";
import { pickFetcher } from "./fetchers.ts";

const [url, date] = process.argv.slice(2);
if (!url) { console.log('usage: node apps/runner/inspect.ts "<bookmyshow url>" [YYYYMMDD]'); process.exit(1); }
const t = parseBmsUrl(url);
const region = resolveRegion(t.citySlug);
const snap = await new BmsClient({ fetcher: pickFetcher(), log: console.log }).snapshot(region, t.eventCode, date ? [date] : []);
console.log(`\n${snap.movieName || t.movieSlug} · ${region.name} · ${t.eventCode}${snap.complete ? "" : "  (INCOMPLETE: " + snap.failures.join("; ") + ")"}`);
console.log(`Formats: ${snap.formats.map((f) => `${f.title || "(default)"} [${f.eventCode}]`).join(", ")}`);
console.log(`Dates:   ${snap.dates.map((d) => `${prettyDate(d.dateCode)} ${d.status}`).join(" | ") || "none listed yet"}`);
const venues = new Map<string, Set<string>>();
for (const s of snap.shows) venues.set(`${s.venueCode}  ${s.venueName}`, (venues.get(`${s.venueCode}  ${s.venueName}`) || new Set()).add([s.format, s.screenAttr].filter(Boolean).join(" ")));
console.log(`Cinemas (${venues.size}):`);
for (const [v, f] of [...venues].sort()) console.log(`  ${v}  —  ${[...f].join(", ")}`);
