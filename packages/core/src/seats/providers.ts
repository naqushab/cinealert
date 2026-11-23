import type { SeatLayoutProvider, SeatMap } from "./model.ts";
import { seatMapFromJson } from "./model.ts";

/** Reads seat maps from a directory of JSON files named <venue>_<session>.json (fs injected). */
export function fileProvider(readFile: (path: string) => Promise<string | null>, dir: string): SeatLayoutProvider {
  return {
    name: "file",
    async get(venueCode, sessionId) {
      const raw = await readFile(`${dir}/${venueCode}_${sessionId}.json`);
      return raw ? seatMapFromJson(raw) : null;
    },
  };
}

/** Placeholder for a live BMS seat-layout source. None of the reference repos has a working
 *  one (the page sits behind Cloudflare; zayn0001's Playwright attempt stops at the challenge).
 *  Planned sources, in order: (1) Android app WebView opened by the user, (2) a captured
 *  seat-layout API response from a home network, parsed against recorded fixtures.
 *  We will NOT solve CAPTCHAs or bypass challenges. */
export const unavailableProvider: SeatLayoutProvider = {
  name: "unavailable",
  async get(): Promise<SeatMap | null> { return null; },
};
