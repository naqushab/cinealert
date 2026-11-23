// Normalised seat map. Any provider (captured BMS seat-layout JSON, the Android app's WebView
// reader, District areas) converts into this shape; scoring only ever sees this.
export type SeatStatus = "available" | "sold" | "blocked";

export interface Seat { id: string; col: number; status: SeatStatus }        // col = physical column incl. gaps
export interface SeatRow { label: string; area: string; price: number; seats: Seat[] }
/** rows[0] is the row closest to the screen. */
export interface SeatMap { venueCode: string; sessionId: string; rows: SeatRow[]; source: string }

export interface SeatLayoutProvider {
  name: string;
  get(venueCode: string, sessionId: string, eventCode: string, dateCode: string): Promise<SeatMap | null>;
}

/** Loads a SeatMap JSON saved earlier (from the Android app, a browser capture, or tests). */
export function seatMapFromJson(raw: string): SeatMap {
  const m = JSON.parse(raw);
  if (!Array.isArray(m?.rows)) throw new Error("seat map JSON needs a rows[] array");
  return m as SeatMap;
}

/** Compact text form for tests and debugging:  "J:RECLINER:450: ..AA_AA.." (A available, . sold, _ gap) */
export function seatMapFromAscii(lines: string[], venueCode = "TEST", sessionId = "1"): SeatMap {
  const rows: SeatRow[] = lines.map((line) => {
    const [label, area, price, layout] = line.split(":");
    const seats: Seat[] = [];
    let n = 0;
    [...layout].forEach((ch, col) => {
      if (ch === "_" || ch === " ") return;
      n++;
      seats.push({ id: `${label}${n}`, col, status: ch === "A" ? "available" : ch === "X" ? "blocked" : "sold" });
    });
    return { label, area, price: Number(price), seats };
  });
  return { venueCode, sessionId, rows, source: "ascii" };
}
