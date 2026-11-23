// "Perfect seats" for one show from a saved seat map:
//   node apps/runner/seats.ts --layout captures/PVLX_12345.json --count 2 [--areas recliner,prime] [--url <seat-layout url>]
// Live seat-map fetching is not wired yet (see docs/ARCHITECTURE.md §Seats).
import { readFile } from "node:fs/promises";
import { findBestSeats, seatMapFromJson, seatSummary, parseBmsUrl } from "../../packages/core/src/index.ts";

const a = process.argv.slice(2);
const opt = (k: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
if (opt("--url")) console.log("Show:", parseBmsUrl(opt("--url")!));
const layout = opt("--layout");
if (!layout) { console.log("usage: node apps/runner/seats.ts --layout <seatmap.json> --count 2 [--areas recliner]"); process.exit(1); }
const map = seatMapFromJson(await readFile(layout, "utf8"));
const picks = findBestSeats(map, { count: Number(opt("--count") || 2), areas: opt("--areas")?.split(",") }, 5);
console.log(picks.length ? picks.map((p, i) => `${i + 1}. ${seatSummary(p)}`).join("\n") : "No matching block of seats is free.");
