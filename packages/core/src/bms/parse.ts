// Parser for /api/movies-data/v4/showtimes-by-event/primary-dynamic (structure from
// aviiciii/bms-ticket-notifier + kyloprat/ticket-bot, both MIT). Defensive: unknown shapes yield
// empty results and `recognised=false` so the engine can raise a "parser may be broken" alert.
import type { AvailStatus, DateStatus, DateState, FormatChip, Show } from "../types.ts";

type J = any;

const DATE_STYLE: Record<string, DateState> = {
  "date-selected": "BOOKABLE",
  "date-default": "AVAILABLE",
  "date-disabled": "NOT_OPEN",
};

export function recognised(data: J): boolean {
  const d = data?.data;
  return !!d && (Array.isArray(d.showtimeWidgets) || Array.isArray(d.topStickyWidgets));
}

export function parseMovieName(data: J): string {
  for (const w of data?.data?.bottomSheetData?.["format-selector"]?.widgets || []) {
    if (w?.type !== "vertical-text-list") continue;
    for (const d of w.data || []) if (d?.styleId === "bottomsheet-subtitle" && d.text) return String(d.text);
  }
  return "";
}

export function parseFormats(data: J, eventCode: string): FormatChip[] {
  for (const w of data?.data?.bottomSheetData?.["format-selector"]?.widgets || []) {
    if (w?.type !== "chip-list") continue;
    const chips: FormatChip[] = (w.data || [])
      .map((c: J) => ({ eventCode: String(c?.cta?.additionalData?.eventCode || ""), title: String(c?.title || "") }))
      .filter((c: FormatChip) => c.eventCode);
    if (chips.some((c) => c.eventCode === eventCode)) return chips;
  }
  return [{ eventCode, title: "" }];
}

export function parseDates(data: J): DateStatus[] {
  const out: DateStatus[] = [];
  for (const w of data?.data?.topStickyWidgets || []) {
    if (w?.type !== "horizontal-block-list") continue;
    for (const item of w.data || []) {
      const id = String(item?.id || "");
      if (/^\d{8}$/.test(id)) out.push({ dateCode: id, status: DATE_STYLE[item.styleId] || "UNKNOWN" });
    }
  }
  return out;
}

const toStatus = (v: unknown): AvailStatus => {
  const n = Number(v);
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : -1;
};

export function parseShows(data: J, eventCode: string, format: string): Show[] {
  const shows: Show[] = [];
  for (const w of data?.data?.showtimeWidgets || []) {
    if (w?.type !== "groupList") continue;
    for (const g of w.data || []) {
      if (g?.type !== "venueGroup") continue;
      for (const card of g.data || []) {
        if (card?.type !== "venue-card") continue;
        const a = card.additionalData || {};
        for (const st of card.showtimes || []) {
          const sa = st?.additionalData || {};
          let dateCode = String(sa.showDateCode || sa.dateCode || "").trim();
          if (!dateCode && /^\d{8}/.test(sa.cutOffDateTime || "")) dateCode = sa.cutOffDateTime.slice(0, 8);
          shows.push({
            venueCode: String(a.venueCode || ""),
            venueName: String(a.venueName || "Unknown"),
            sessionId: String(sa.sessionId || ""),
            eventCode: String(sa.eventCode || eventCode),
            dateCode,
            time: String(st.title || ""),
            timeCode: Number(sa.showTimeCode) || 0,
            format,
            screenAttr: String(st.screenAttr || sa.attributes || ""),
            categories: (sa.categories || []).map((c: J) => ({
              name: String(c?.priceDesc || "").trim(),
              price: Number(c?.curPrice) || 0,
              status: toStatus(c?.availStatus),
            })),
          });
        }
      }
    }
  }
  return shows;
}
