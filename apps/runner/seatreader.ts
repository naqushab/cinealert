// Opens District seat-layout pages in headless Chromium (as a normal visitor, no login) and reads
// the seat labels. Read-only: never selects or holds seats. Never solves challenges.
import { seatMapFromLabels } from "../../packages/core/src/index.ts";
import type { SeatMap } from "../../packages/core/src/index.ts";

export interface SeatJob { url: string; venueCode: string; sessionId: string }
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function readSeatMaps(jobs: SeatJob[], log: (s: string) => void): Promise<Map<string, SeatMap | null>> {
  const out = new Map<string, SeatMap | null>();
  if (!jobs.length) return out;
  let pw: any;
  try { pw = await import("playwright"); } catch {
    log("  seats: playwright not installed (npm i --no-save playwright && npx playwright install chromium)");
    jobs.forEach((j) => out.set(j.url, null));
    return out;
  }
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ userAgent: UA, locale: "en-IN", viewport: { width: 1280, height: 900 } })).newPage();
    for (const j of jobs) {
      try {
        await page.goto(j.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForSelector('[aria-label*="seat, class"]', { timeout: 20_000 });
        const labels: string[] = await page.$$eval('[aria-label*="seat, class"]', (els: Element[]) => els.map((e) => e.getAttribute("aria-label") || ""));
        const map = seatMapFromLabels(labels, j.venueCode, j.sessionId);
        out.set(j.url, map.rows.length ? map : null);
      } catch (e) {
        log(`  seats: couldn't read ${j.venueCode}/${j.sessionId}: ${String((e as Error).message).split("\n")[0]}`);
        out.set(j.url, null);
      }
      await page.waitForTimeout(1500 + Math.random() * 1500);
    }
  } finally { await browser.close(); }
  return out;
}
