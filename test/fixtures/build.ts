// SYNTHETIC fixtures shaped like primary-dynamic responses (structure taken from the reference
// repos' parsers). Replace/add real recorded responses under test/fixtures/real/ when captured.
export interface FxShow { venue: string; code: string; session: string; date: string; time: string; tc: number; screen?: string; cats: [string, number, number][] }

export function primaryDynamic(opts: { event: string; chips?: [string, string][]; dates?: [string, string][]; shows?: FxShow[]; name?: string }) {
  const venues = new Map<string, FxShow[]>();
  for (const s of opts.shows || []) venues.set(s.code, [...(venues.get(s.code) || []), s]);
  return {
    data: {
      topStickyWidgets: [{ type: "horizontal-block-list", data: (opts.dates || []).map(([id, styleId]) => ({ id, styleId, data: [{}, {}, {}] })) }],
      bottomSheetData: { "format-selector": { widgets: [
        { type: "vertical-text-list", data: [{ styleId: "bottomsheet-subtitle", text: opts.name || "Test Movie" }] },
        { type: "chip-list", data: (opts.chips || [[opts.event, "2D"]]).map(([eventCode, title]) => ({ title, cta: { additionalData: { eventCode } } })) },
      ] } },
      showtimeWidgets: [{ type: "groupList", data: [{ type: "venueGroup", data: [...venues.values()].map((ss) => ({
        type: "venue-card",
        additionalData: { venueName: ss[0].venue, venueCode: ss[0].code },
        showtimes: ss.map((s) => ({ title: s.time, screenAttr: s.screen || "", additionalData: {
          sessionId: s.session, showDateCode: s.date, showTimeCode: String(s.tc),
          categories: s.cats.map(([priceDesc, curPrice, availStatus]) => ({ priceDesc, curPrice: String(curPrice), availStatus: String(availStatus) })),
        } })),
      })) }] }],
    },
  };
}
