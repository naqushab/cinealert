import type { Region } from "./types.ts";

// code, canonical slug, lat, lon, geohash (values used by the BMS web client; see reference repos).
const R = (name: string, code: string, slug: string, lat: string, lon: string, geohash: string): Region =>
  ({ name, code, slug, lat, lon, geohash });

const REGIONS: Region[] = [
  R("Delhi NCR", "NCR", "national-capital-region-ncr", "28.613", "77.209", "ttn"),
  R("Mumbai", "MUMBAI", "mumbai", "19.076", "72.878", "te7"),
  R("Bengaluru", "BANG", "bengaluru", "12.972", "77.594", "tdr"),
  R("Chennai", "CHEN", "chennai", "13.056", "80.206", "tf3"),
  R("Hyderabad", "HYD", "hyderabad", "17.385", "78.487", "tep"),
  R("Kolkata", "KOLK", "kolkata", "22.573", "88.364", "tun"),
  R("Pune", "PUNE", "pune", "18.520", "73.856", "te2"),
  R("Kochi", "KOCH", "kochi", "9.932", "76.267", "t9z"),
];

const ALIASES: Record<string, string> = {
  "delhi-ncr": "NCR", delhi: "NCR", ncr: "NCR", noida: "NCR", gurgaon: "NCR", gurugram: "NCR",
  "national-capital-region-ncr": "NCR", bangalore: "BANG", bombay: "MUMBAI", madras: "CHEN", calcutta: "KOLK",
};

export function resolveRegion(slugOrCode: string): Region {
  const k = (slugOrCode || "").trim().toLowerCase();
  const code = ALIASES[k];
  const hit = REGIONS.find((r) => r.code === code || r.slug === k || r.code.toLowerCase() === k);
  if (hit) return hit;
  throw new Error(`Unknown city "${slugOrCode}". Add it to packages/core/src/regions.ts (code, slug, lat, lon, geohash).`);
}

export function listRegions(): Region[] { return [...REGIONS]; }
