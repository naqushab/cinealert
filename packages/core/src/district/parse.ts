// District (district.in) movie pages are server-rendered Next.js. Verified live on 23 Nov 2026:
//   props.pageProps.data.serverState.movieContents[<contentId>].languageFormatGroups[] {language, fmtGrpId}
//   props.pageProps.data.serverState.movieSessions[<fmt+date>] {searchDate, data.sessionDates[], arrangedSessions[]}
//   arrangedSessions[] {data:{id,name}, sessions[] {sid, showDate, showTimeText, showTimeLocal, scrnFmt, audi,
//                       areas[] {code,label,price,sAvail,sTotal,statusColor}}}
// Page-level query: ?frmtid=<fmtGrpId lowercased>&fromdate=YYYY-MM-DD
import type { AvailStatus, Category, Show } from "../types.ts";

type J = any;
const NEXT_DATA = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

export function districtState(html: string): J | null {
  const m = html.match(NEXT_DATA);
  if (!m) return null;
  try { return JSON.parse(m[1])?.props?.pageProps?.data?.serverState || null; } catch { return null; }
}

export interface LangGroup { language: string; fmtGrpId: string }

export function districtLanguages(state: J): LangGroup[] {
  const out: LangGroup[] = [];
  for (const mc of Object.values(state?.movieContents || {}) as J[]) {
    for (const g of mc?.languageFormatGroups || []) {
      const id = String(g?.fmtGrpId || g?.format || "");
      if (id) out.push({ language: String(g.language || g.lang || ""), fmtGrpId: id });
    }
  }
  return out;
}

export function districtMovieName(state: J): string {
  for (const v of Object.values(state?.movieSessions || {}) as J[]) if (v?.meta?.movie?.name) return String(v.meta.movie.name);
  for (const mc of Object.values(state?.movieContents || {}) as J[]) if (mc?.name || mc?.title) return String(mc.name || mc.title);
  return "";
}

export function districtSessionDates(state: J): string[] {
  const out = new Set<string>();
  for (const v of Object.values(state?.movieSessions || {}) as J[])
    for (const d of v?.data?.sessionDates || []) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.add(d.replace(/-/g, ""));
  return [...out].sort();
}

function areaStatus(a: J): AvailStatus {
  const avail = Number(a?.sAvail);
  if (Number.isFinite(avail) && avail <= 0) return 0;
  const c = String(a?.statusColor || "").toUpperCase();
  if (c === "G") return 3;
  if (c === "Y") return 2;
  if (c === "R" || c === "O") return 1;
  const total = Number(a?.sTotal);
  if (Number.isFinite(avail) && Number.isFinite(total) && total > 0) return avail / total > 0.5 ? 3 : avail / total > 0.2 ? 2 : 1;
  return -1;
}

const timeCode = (local: string, text: string): number => {
  const m = (local || "").match(/T(\d{2}):(\d{2})/);
  if (m) return +m[1] * 100 + +m[2];
  const t = (text || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!t) return 0;
  let h = +t[1] % 12;
  if (t[3].toUpperCase() === "PM") h += 12;
  return h * 100 + +t[2];
};

export function districtShows(state: J, fmtGrpId: string): Show[] {
  const shows: Show[] = [];
  for (const v of Object.values(state?.movieSessions || {}) as J[]) {
    for (const c of v?.arrangedSessions || []) {
      const cinemaId = String(c?.data?.id || "");
      const name = String(c?.data?.name || c?.entityName || cinemaId);
      for (const s of [...(c?.sessions || []), ...(c?.data?.extraSessions || [])]) {
        const categories: Category[] = (s?.areas || []).map((a: J) => ({
          name: String(a?.label || a?.code || "").trim(),
          price: Number(a?.price) || 0,
          status: areaStatus(a),
          seatsAvail: Number.isFinite(Number(a?.sAvail)) ? Number(a.sAvail) : undefined,
          seatsTotal: Number.isFinite(Number(a?.sTotal)) ? Number(a.sTotal) : undefined,
        }));
        shows.push({
          venueCode: `D${cinemaId}`,
          venueName: name,
          sessionId: String(s?.sid || ""),
          eventCode: fmtGrpId,
          dateCode: String(s?.showDate || "").replace(/-/g, ""),
          time: String(s?.showTimeText || ""),
          timeCode: timeCode(s?.showTimeLocal, s?.showTimeText),
          format: "",
          screenAttr: [s?.scrnFmt, s?.audi].filter(Boolean).join(" · "),
          bookingRef: s?.encSessionId ? String(s.encSessionId) : undefined,
          categories,
        });
      }
    }
  }
  return shows;
}
