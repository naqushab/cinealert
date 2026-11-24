import type { ActionButton, Button, Change, Notification, Show, Watch } from "../types.ts";
import { rankShows } from "../rank.ts";

const DOT = ["🔴", "🟡", "🟠", "🟢"];
const WORD = ["Sold out", "Almost full", "Filling fast", "Available"];
const KIND: Record<Change["kind"], string> = { DATE_OPENED: "📅", NEW_SHOW: "🆕", BACK_IN_STOCK: "🔁 back", STATUS_UP: "⬆️", SEATS_FOUND: "💺" };
const TG_MAX = 60;      // Telegram: everything (split into several messages if needed)
const PUSH_MAX = 6;     // ntfy / email body: top entries, plus a "View all" link

export const prettyDate = (dc: string) => {
  const d = new Date(`${dc.slice(0, 4)}-${dc.slice(4, 6)}-${dc.slice(6, 8)}T00:00:00Z`);
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
};
/** Escape for HTML (email) and Telegram HTML alike: only &amp; &lt; &gt; &quot; are used. */
export const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const time12 = (s: Show) => s.time.replace(/^0/, "");
const shortVenue = (v: string) => v.replace(/^(PVR|INOX|Cinepolis)\s*:\s*/i, "$1 ").split(",")[0].slice(0, 26);
const fmtLine = (s: Show) => [s.format, s.screenAttr].filter(Boolean).join(" · ").replace(/\bMS[- ]+/gi, "");
const seats = (c: Change) => (c.category?.seatsAvail !== undefined ? ` · ${c.category.seatsAvail}/${c.category.seatsTotal} left` : "");

export function buildNotification(w: Watch, movieName: string, changes: Change[], sourceLabel = ""): Notification {
  const name = w.label || movieName || "Movie";
  const opened = changes.filter((c) => c.kind === "DATE_OPENED");
  const title = opened.length
    ? `🎟️ ${name}: bookings open (${opened.map((c) => prettyDate(c.dateCode!)).join(", ")})`
    : `🎟️ ${name}: ${changes.filter((c) => c.show).length} update(s)`;

  // group: date → show → changed seat classes
  const byShow = new Map<string, Change[]>();
  for (const c of changes) if (c.show) {
    const k = `${c.show.dateCode}|${String(c.show.timeCode).padStart(4, "0")}|${c.show.venueName}|${c.show.sessionId}`;
    byShow.set(k, [...(byShow.get(k) || []), c]);
  }
  const groups = [...byShow.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
  const shown = groups.slice(0, TG_MAX);
  const top = groups.slice(0, PUSH_MAX);

  // ---------- Telegram ----------
  const tg: string[] = [`🎟️ <b>${esc(name)}</b>${sourceLabel ? ` · ${esc(sourceLabel)}` : ""}`];
  if (opened.length) tg.push(`📅 <b>Bookings open:</b> ${opened.map((c) => `<a href="${esc(c.link)}">${prettyDate(c.dateCode!)}</a>`).join(", ")}`);
  let lastDate = "";
  for (const g of shown) {
    const s = g[0].show!;
    if (s.dateCode !== lastDate) { tg.push("", `<b>${prettyDate(s.dateCode)}</b>`); lastDate = s.dateCode; }
    tg.push(`🕖 <b>${esc(time12(s))}</b> · ${esc(s.venueName)}`);
    if (fmtLine(s)) tg.push(`      <i>${esc(fmtLine(s))}</i>`);
    for (const c of g) tg.push(`      ${DOT[c.category!.status] || "⚪"} ${esc(c.category!.name)} ₹${c.category!.price}${esc(seats(c))} ${KIND[c.kind]}${c.detail ? `\n      💺 ${esc(c.detail)}` : ""}`);
    tg.push(`      <a href="${esc(g[0].link)}">Book this show →</a>`);
  }
  if (groups.length > TG_MAX) tg.push("", `<i>...and ${groups.length - TG_MAX} more: tap "📋 All ${groups.length} shows".</i>`);

  // ---------- plain text (ntfy) & email HTML ----------
  const text: string[] = [], html: string[] = [];
  for (const c of opened) { text.push(`📅 ${prettyDate(c.dateCode!)} is open → ${c.link}`); html.push(`<p><b>📅 ${prettyDate(c.dateCode!)}</b> is open: <a href="${esc(c.link)}">all shows</a></p>`); }
  for (const g of top) {
    const s = g[0].show!;
    const cats = g.map((c) => `${DOT[c.category!.status] || ""} ${c.category!.name} ₹${c.category!.price} ${WORD[c.category!.status] || ""}${seats(c)}`);
    text.push(`${prettyDate(s.dateCode)} ${time12(s)} · ${s.venueName}${fmtLine(s) ? ` · ${fmtLine(s)}` : ""}\n  ${cats.join("\n  ")}`);
    html.push(`<p><b>${prettyDate(s.dateCode)} ${esc(time12(s))}</b> · ${esc(s.venueName)}${fmtLine(s) ? ` · <i>${esc(fmtLine(s))}</i>` : ""}<br>${cats.map(esc).join("<br>")}<br><a href="${esc(g[0].link)}">Book this show</a></p>`);
  }
  const trimmed = groups.length > PUSH_MAX;
  if (trimmed) { text.push(`+${groups.length - PUSH_MAX} more: tap "All ${groups.length} shows"`); html.push(`<p>+${groups.length - PUSH_MAX} more shows (see "All ${groups.length} shows" below)</p>`); }

  // ---------- full list (Markdown page) ----------
  const md: string[] = [`# ${name}${sourceLabel ? ` · ${sourceLabel}` : ""}`, "", `_${changes.filter((c) => c.show).length} change(s) in ${groups.length} show(s)_`, ""];
  if (opened.length) md.push(`**Bookings open:** ${opened.map((c) => `[${prettyDate(c.dateCode!)}](${c.link})`).join(" · ")}`, "");
  let mdDate = "";
  for (const g of groups) {
    const s = g[0].show!;
    if (s.dateCode !== mdDate) { md.push(`## ${prettyDate(s.dateCode)}`, "", "| Time | Cinema | Format | Seats | Book |", "|---|---|---|---|---|"); mdDate = s.dateCode; }
    const cats = g.map((c) => `${DOT[c.category!.status] || ""} ${c.category!.name} ₹${c.category!.price}${seats(c)}`).join("<br>");
    md.push(`| **${time12(s)}** | ${s.venueName.replace(/\|/g, "/")} | ${fmtLine(s).replace(/\|/g, "/")} | ${cats} | [Book](${g[0].link}) |`);
  }

  // ---------- buttons ----------
  const uniq = groups.map((g) => g[0]);
  const ranked = rankShows(uniq.map((c) => c.show!), { seats: w.minSeats, categories: w.categories, preferTime: w.type === "show" ? w.time : undefined }, 3);
  const buttons: Button[] = ranked.map((r) => ({
    text: `🎟️ ${prettyDate(r.show.dateCode).replace(/^\w+, /, "")} ${time12(r.show)} · ${shortVenue(r.show.venueName)}`.slice(0, 60),
    url: uniq.find((x) => x.show === r.show)!.link,
  }));
  for (const c of opened.slice(0, 2)) buttons.push({ text: `📅 All shows · ${prettyDate(c.dateCode!)}`, url: c.link });
  const actions: ActionButton[] = [
    { text: "🏆 Best now", data: `a|best|${w.id}` },
    { text: "🔕 Snooze 6h", data: `a|snooze|${w.id}|6` },
    { text: "⏸ Pause", data: `a|pause|${w.id}` },
  ];
  return {
    title, text: text.join("\n"), html: html.join(""), tg: tg.join("\n"), full: md.join("\n") + "\n", total: groups.length, trimmed,
    link: opened[0]?.link || changes[0]?.link || w.url,
    priority: opened.length ? "urgent" : "high", buttons, actions,
  };
}
