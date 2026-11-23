// Pure check cycle: (watches, snapshots, previous state, now) -> (changes, next state).
// No I/O here, so it runs unchanged in GitHub Actions, a server or the Android app.
import type { Change, Snapshot, Watch, Show, Category } from "./types.ts";
import { categoryMatches, expandDates, showMatches } from "./match.ts";
import { buyUrl, seatLayoutUrl } from "./url.ts";
import { parseWatchUrl } from "./source.ts";

export interface CatState { status: number; price: number; soldOutSince?: string }
export interface WatchState {
  dates: string[];                       // dates that already had matching shows
  cats: Record<string, CatState>;        // venue|session|date|category
  lastCheckedAt?: string;
  lastResult?: string;
}
export interface State { watches: Record<string, WatchState>; health: { fails: number; warned: boolean; okStreak: number } }

export const emptyState = (): State => ({ watches: {}, health: { fails: 0, warned: false, okStreak: 0 } });

export const REOPEN_COOLDOWN_MS = 10 * 60_000;

export function watchTarget(w: Watch) {
  return parseWatchUrl(w.url, w.city);
}

export function diffWatch(w: Watch, snap: Snapshot, prev: WatchState | undefined, now: Date): { changes: Change[]; next: WatchState } {
  const t = watchTarget(w);
  const wanted = new Set(expandDates(w.dates?.length ? w.dates : []));
  const minStatus = w.minStatus ?? 1;
  const old: WatchState = prev || { dates: [], cats: {} };
  const next: WatchState = { dates: [...old.dates], cats: {}, lastCheckedAt: now.toISOString() };
  const changes: Change[] = [];
  const nowIso = now.toISOString();
  const link = snap.showLink || ((s: Show) => seatLayoutUrl(snap.region.slug, s.eventCode, s.venueCode, s.sessionId, s.dateCode));
  const dateLink = snap.dateLink || ((d: string) => buyUrl(snap.region.slug, t.movieSlug, snap.eventCode, d));

  const matched = snap.shows.filter((s) => showMatches(w, s, wanted));
  const openedDates = new Set<string>();
  for (const s of matched) {
    const cats = s.categories.filter((c) => categoryMatches(w, c));
    for (const c of cats) {
      const key = `${s.venueCode}|${s.sessionId}|${s.dateCode}|${c.name}`;
      const o = old.cats[key];
      const ok = c.status >= minStatus;
      const cs: CatState = { status: c.status, price: c.price };
      if (!ok) cs.soldOutSince = o?.soldOutSince && o.status < minStatus ? o.soldOutSince : nowIso;
      next.cats[key] = cs;
      if (!ok) continue;
      openedDates.add(s.dateCode);
      const push = (kind: Change["kind"], detail?: string) => changes.push({ kind, watchId: w.id, show: s, category: c, link: link(s), detail });
      if (!o) push("NEW_SHOW");
      else if (o.status < minStatus) {
        const since = o.soldOutSince ? Date.parse(o.soldOutSince) : 0;
        if (now.getTime() - since >= REOPEN_COOLDOWN_MS) push("BACK_IN_STOCK");
        else next.cats[key] = { ...o };  // keep sold-out marker; re-evaluate next run
      } else if (c.status > o.status) push("STATUS_UP");
    }
  }
  // Keep remembering seat classes that vanished this run (shows pulled / sold out) as sold out,
  // so they alert again when they return.
  for (const [key, o] of Object.entries(old.cats)) {
    if (!next.cats[key]) {
      const date = key.split("|")[2];
      if (date >= nowIso.slice(0, 10).replace(/-/g, "")) next.cats[key] = { ...o, status: 0, soldOutSince: o.status === 0 ? o.soldOutSince : nowIso };
    }
  }
  const dateChanges: Change[] = [];
  for (const d of [...openedDates].sort()) {
    if (!old.dates.includes(d)) {
      dateChanges.push({ kind: "DATE_OPENED", watchId: w.id, dateCode: d, link: dateLink(d) });
      next.dates.push(d);
    }
  }
  changes.unshift(...dateChanges);
  next.lastResult = `${matched.length} matching show(s), ${changes.length} change(s)`;
  return { changes, next };
}

export function healthUpdate(state: State, ok: boolean): "warn" | "recovered" | null {
  const h = state.health;
  if (ok) {
    h.fails = 0; h.okStreak++;
    if (h.warned && h.okStreak >= 1) { h.warned = false; return "recovered"; }
    return null;
  }
  h.okStreak = 0; h.fails++;
  if (h.fails >= 3 && !h.warned) { h.warned = true; return "warn"; }
  return null;
}

export type { Category };
