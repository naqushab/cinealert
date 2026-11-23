// Validates a watch against what the site lists now (snapshot) and what we've learned (catalog).
// errors   = can never work as written (bad link, past dates, unknown city) → don't save
// warnings = not available *now* but could appear later (format not listed yet, cinema not showing it...)
import type { Snapshot, Watch, Show } from "./types.ts";
import type { Catalog } from "./catalog.ts";
import { cityVenues, formatKeys } from "./catalog.ts";
import { FORMAT_ALIASES, formatMatches, showFormatLabel } from "./formats.ts";
import { categoryMatches, cinemaMatches, expandDates, showMatches } from "./match.ts";
import { prettyDate } from "./notify/format.ts";

export interface Validation { errors: string[]; warnings: string[]; info: string[]; matchingShows: number }

const uniq = <T>(a: T[]) => [...new Set(a)];
const mins = (hhmm: number) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

export function validateWatch(w: Watch, snap: Snapshot | null, catalog: Catalog | null, now = new Date()): Validation {
  const v: Validation = { errors: [], warnings: [], info: [], matchingShows: 0 };
  const todayCode = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10).replace(/-/g, "");
  const dates = expandDates(w.dates || []);

  // ---- dates
  const past = dates.filter((d) => d < todayCode);
  if (dates.length && past.length === dates.length) v.errors.push(`All dates are in the past (${past.map(prettyDate).join(", ")}).`);
  else if (past.length) v.warnings.push(`Ignoring past date(s): ${past.map(prettyDate).join(", ")}.`);

  // ---- formats known?
  for (const f of [...(w.formats || []), ...(w.excludeFormats || [])]) {
    const key = f.toUpperCase().replace(/[\s-]+/g, "_");
    if (!FORMAT_ALIASES[key]) v.warnings.push(`"${f}" isn't a known format name; it will be matched as text. Known: ${Object.keys(FORMAT_ALIASES).join(", ")}.`);
  }

  if (!snap) { v.warnings.push("Couldn't read the site right now, so nothing else was checked. The watch will still run."); return v; }
  if (!snap.complete) v.warnings.push(`Partial data from the site (${snap.failures[0] || "some requests failed"}); checks below may be incomplete.`);

  const shows = snap.shows;
  const all = new Set(dates);
  const future = dates.filter((d) => d >= todayCode);
  const open = new Set(snap.dates.filter((d) => d.status !== "NOT_OPEN").map((d) => d.dateCode));
  for (const s of shows) open.add(s.dateCode);

  // ---- language (District groups; BMS language is part of the link's event)
  if (w.language && snap.source === "district") {
    const langs = snap.formats.map((f) => f.title.toLowerCase());
    if (langs.length && !langs.includes(w.language.toLowerCase()))
      v.warnings.push(`Language "${w.language}" isn't listed yet (now: ${snap.formats.map((f) => f.title).join(", ")}). You'll be alerted if it's added.`);
  }

  // ---- dates open?
  const notOpen = future.filter((d) => !open.has(d));
  if (future.length && notOpen.length === future.length) v.warnings.push(`None of your dates are open for booking yet. Open now: ${[...open].sort().map(prettyDate).join(", ") || "none"}.`);
  else if (notOpen.length) v.warnings.push(`Not open yet: ${notOpen.map(prettyDate).join(", ")}.`);

  // ---- formats offered by the movie?
  const labels = uniq(shows.map((s) => showFormatLabel(s.format, s.screenAttr)));
  const movieKeys = uniq(labels.flatMap(formatKeys));
  for (const f of w.formats || []) {
    if (!labels.some((l) => formatMatches(l, f)))
      v.warnings.push(`This movie isn't listed in ${f} right now${movieKeys.length ? ` (formats now: ${movieKeys.join(", ")})` : ""}. It may be added later.`);
  }

  // ---- cinemas exist / show it / in that format?
  const venues = catalog ? cityVenues(catalog, snap.source, snap.region.slug) : [];
  const specs = w.type === "show" ? [w.cinema] : w.cinemas || [];
  for (const spec of specs) {
    const showing = shows.filter((s) => cinemaMatches(s, spec));
    if (!showing.length) {
      const known = venues.filter(([code, info]) => cinemaMatches({ venueCode: code, venueName: info.name } as Show, spec));
      if (known.length) v.warnings.push(`"${spec}" (${known.map(([, i]) => i.name).slice(0, 3).join("; ")}) isn't showing this movie right now. It may be added later.`);
      else v.warnings.push(`No cinema matching "${spec}" is showing this movie, and none by that name has been seen in ${snap.region.slug}${venues.length ? ` (${venues.length} cinemas known)` : ""}. Check the spelling, or use /inspect for codes.`);
      continue;
    }
    const names = uniq(showing.map((s) => s.venueName));
    if (names.length > 3 && w.type === "show") v.warnings.push(`"${spec}" matches ${names.length} cinemas (${names.slice(0, 3).join("; ")}...). Use a cinema code from /inspect to pin one.`);
    for (const f of w.formats || []) {
      if (showing.some((s) => formatMatches(showFormatLabel(s.format, s.screenAttr), f))) continue;
      const hallKeys = uniq(showing.map((s) => s.venueCode)).flatMap((c) => venues.find(([code]) => code === c)?.[1].formats || []);
      const everHad = hallKeys.some((k) => formatMatches(k.replace(/_/g, " "), f) || k === f.toUpperCase());
      v.warnings.push(`${names[0]}${names.length > 1 ? ` (+${names.length - 1})` : ""} isn't showing it in ${f} now${everHad ? " (it does have that format for other movies)" : hallKeys.length ? `; formats seen there so far: ${uniq(hallKeys).join(", ")}` : ""}.`);
    }
  }

  // ---- what matches right now
  const matching = shows.filter((s) => showMatches(w, s, all));
  if (w.type === "show" && w.time && matching.length === 0) {
    const near = shows.filter((s) => cinemaMatches(s, w.cinema) && (!all.size || all.has(s.dateCode)));
    if (near.length) {
      const times = uniq(near.map((s) => s.time)).slice(0, 8);
      if (!near.some((s) => Math.abs(mins(s.timeCode) - mins(+w.time!.replace(":", ""))) <= (w.toleranceMinutes ?? 45)))
        v.warnings.push(`No show near ${w.time} at that cinema now. Times listed: ${times.join(", ")}.`);
    }
  }
  const withCats = matching.filter((s) => s.categories.some((c) => categoryMatches(w, c)));
  if (w.categories?.length && matching.length && !withCats.length) {
    const classes = uniq(matching.flatMap((s) => s.categories.map((c) => c.name))).slice(0, 10);
    v.warnings.push(`No seat class like "${w.categories.join("/")}" in the matching shows${w.maxPrice ? ` within ₹${w.maxPrice}` : ""}. Classes there: ${classes.join(", ")}.`);
  } else if (w.maxPrice && matching.length && !withCats.length) {
    const cheapest = Math.min(...matching.flatMap((s) => s.categories.map((c) => c.price)).filter((p) => p > 0));
    v.warnings.push(`Nothing at or below ₹${w.maxPrice}; cheapest matching seat is ₹${cheapest}.`);
  }
  if (w.minSeats && snap.source !== "district") v.info.push("Seat counts (seats=N) only work on District; BookMyShow uses availability status instead.");

  v.matchingShows = withCats.length;
  const avail = withCats.filter((s) => s.categories.some((c) => categoryMatches(w, c) && c.status >= (w.minStatus ?? 1))).length;
  if (withCats.length && !avail) v.warnings.push(`All ${withCats.length} matching show(s) are sold out in your seat class right now. You'll be alerted if seats come back or new shows are added.`);
  v.info.push(withCats.length ? `${withCats.length} show(s) match right now, ${avail} with seats available.` : "Nothing matches right now. You'll be alerted when something does.");
  return v;
}

export function validationText(v: Validation, esc: (s: string) => string = (s) => s): string {
  return [
    ...v.errors.map((e) => `⛔ ${esc(e)}`),
    ...v.warnings.map((e) => `⚠️ ${esc(e)}`),
    ...v.info.map((e) => `i️ ${esc(e)}`),
  ].join("\n");
}
