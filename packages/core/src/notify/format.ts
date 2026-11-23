import type { Button, Change, Notification, Watch } from "../types.ts";
import { rankShows } from "../rank.ts";

const STATUS = ["🔴 Sold out", "🟡 Almost full", "🟠 Filling fast", "🟢 Available"];
const ICON: Record<Change["kind"], string> = { DATE_OPENED: "📅", NEW_SHOW: "🆕", BACK_IN_STOCK: "🔁", STATUS_UP: "⬆️", SEATS_FOUND: "💺" };

export const prettyDate = (dc: string) => {
  const d = new Date(`${dc.slice(0, 4)}-${dc.slice(4, 6)}-${dc.slice(6, 8)}T00:00:00Z`);
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const seatsLeft = (c: Change) => (c.category?.seatsAvail !== undefined ? ` ${c.category.seatsAvail}/${c.category.seatsTotal} left` : "");
const shortVenue = (v: string) => v.replace(/^(PVR|INOX|Cinepolis)\s*:\s*/i, "$1 ").split(",")[0].slice(0, 28);

export function buildNotification(w: Watch, movieName: string, changes: Change[], sourceLabel = ""): Notification {
  const name = (w.label || movieName || "Movie") + (sourceLabel ? ` [${sourceLabel}]` : "");
  const opened = changes.filter((c) => c.kind === "DATE_OPENED");
  const title = opened.length
    ? `🎟️ ${name}: bookings open (${opened.map((c) => prettyDate(c.dateCode!)).join(", ")})`
    : `🎟️ ${name}: ${changes.length} update(s)`;

  // group category changes by show
  const byShow = new Map<string, Change[]>();
  for (const c of changes) if (c.show) {
    const k = `${c.show.dateCode}|${c.show.venueCode}|${c.show.sessionId}`;
    byShow.set(k, [...(byShow.get(k) || []), c]);
  }
  const lines: string[] = [], html: string[] = [];
  for (const c of opened) { lines.push(`📅 ${prettyDate(c.dateCode!)} is open → ${c.link}`); html.push(`<b>📅 ${prettyDate(c.dateCode!)}</b> is open — <a href="${c.link}">book</a>`); }
  const shows = [...byShow.values()].sort((a, b) => (a[0].show!.dateCode + String(a[0].show!.timeCode).padStart(4, "0")).localeCompare(b[0].show!.dateCode + String(b[0].show!.timeCode).padStart(4, "0")));
  for (const group of shows.slice(0, 25)) {
    const s = group[0].show!;
    const fmt = [s.format, s.screenAttr].filter(Boolean).join(" · ");
    const cats = group.map((c) => `${ICON[c.kind]} ${c.category!.name} ₹${c.category!.price} ${STATUS[c.category!.status] || ""}${seatsLeft(c)}${c.detail ? ` (${c.detail})` : ""}`).join("; ");
    lines.push(`${prettyDate(s.dateCode)} ${s.time} · ${s.venueName}${fmt ? ` · ${fmt}` : ""}\n   ${cats}\n   ${group[0].link}`);
    html.push(`<b>${prettyDate(s.dateCode)} ${esc(s.time)}</b> · ${esc(s.venueName)}${fmt ? ` · <i>${esc(fmt)}</i>` : ""}<br>&nbsp;&nbsp;${esc(cats)} — <a href="${group[0].link}">seats</a>`);
  }
  if (shows.length > 25) { lines.push(`...and ${shows.length - 25} more shows`); html.push(`...and ${shows.length - 25} more shows`); }
  // Fast path to booking: one button per best new show (ranked), then the date page.
  const uniq = [...byShow.values()].map((g) => g[0]);
  const ranked = rankShows(uniq.map((c) => c.show!), { seats: w.minSeats, categories: w.categories, preferTime: w.type === "show" ? w.time : undefined }, 3);
  const buttons: Button[] = ranked.map((r) => {
    const c = uniq.find((x) => x.show === r.show)!;
    return { text: `${prettyDate(r.show.dateCode)} ${r.show.time} · ${shortVenue(r.show.venueName)}`.slice(0, 60), url: c.link };
  });
  for (const c of opened.slice(0, 2)) buttons.push({ text: `All shows · ${prettyDate(c.dateCode!)}`, url: c.link });
  return {
    buttons,
    title,
    text: lines.join("\n"),
    html: html.join("<br>"),
    link: opened[0]?.link || changes[0]?.link || w.url,
    priority: opened.length ? "urgent" : "high",
  };
}
