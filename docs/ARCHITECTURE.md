# CineAlert architecture & roadmap

```
packages/core        pure TS: url · regions · formats · match · engine(diff) · bms/{client,parse}
                     seats/{model,score,providers} · notify/{format,channels}
apps/runner          Node entry points: main (check cycle), inspect, seats; fetchers (fetch | curl_cffi)
apps/android         (planned) Expo app importing packages/core
tools/fetch_cffi.py  Chrome-fingerprint HTTP helper
watches.json         what to watch + channels      state branch: state.json (per-watch memory, health)
```

## Check cycle
1. Group watches by (city, movie). One `snapshot` per group: `dateCode=""` gives the format chips, the 7-day date strip and the first day.
   Then one request per (needed chip × wanted open date). Fetch only matching chips when every wanted format is a chip;
   fetch all chips when a screen label (PXL, Infinity Vision...) is wanted. Requests are spaced 1.5 s ± 30%, retried once,
   and the run stops asking after an unrecovered refusal.
2. **Partial guard:** if any request failed, nothing is compared or saved for that group.
3. `diffWatch` (pure) → changes keyed `venue|session|date|category`. Seat classes that disappear are remembered as sold out,
   so their return alerts again (`BACK_IN_STOCK`).
4. One grouped notification per watch per run; state is saved only if at least one channel accepted it (at-least-once delivery).
5. Health: ⚠️ after 3 failed runs in a row, ✅ on recovery.

Measured on 23 Nov 2026 (Avengers: Doomsday, NCR, 4 format chips, 17–25 Dec): **16 requests, 929 shows, 44 cinemas.**

## District source (verified live 23 Nov 2026: 842 shows, 6 requests for one language, 4 dates)
`/movies/<slug>-movie-tickets-in-<city>-MV<id>` → `serverState.movieContents[id].languageFormatGroups` (language → fmtGrpId);
`?frmtid=<fmtGrpId lowercased>` → `sessionDates`; `&fromdate=YYYY-MM-DD` → `movieSessions.*.arrangedSessions[].sessions[].areas[]`
with `label, price, sAvail, sTotal, statusColor`. Status: 0 if `sAvail=0`, else G=3, Y=2, R=1.
District has refused GitHub runners before (veerabahu, kyloprat repos). If it does, the health alert fires; there is no proxy fallback by design.
Seat-layout pages (`/movies/seat-layout/<fmt>?encsessionid=...`) show "technical error" when opened directly (they need the booking flow), so alerts link to the date page instead.

## Validation & guided add
- `validateWatch(watch, snapshot, catalog)` (pure): ⛔ errors (past dates, bad link/city) vs ⚠️ warnings (format / language / date / cinema / cinema×format / show time / class / price / sold out "not now, maybe later").
- `catalog` (`learn()` on every snapshot): cinemas per source+city with the format keys each has screened.
- `bot/wizard.ts` (pure state machine): `newDraft(snapshot)` → `render()` → `onCallback()` / `onText()` → `draftToWatch()`. Telegram callback data is `<draftId>|<op>|<index>` (≤64 bytes); option lists live in the draft (`bot.json`). The Android app can drive the same machine.
- Tested end to end with a scripted fake Telegram against live BMS (23 Nov 2026).

## Best seat / best show
- **`rankShows`** (live today, both sources): ranks (show × seat class) by availability (exact ratio on District, status on BMS),
  preferred class, and closeness to a preferred time. Powers `/best` and the ranked booking buttons in every alert.
- **`minSeats`**: District alerts only when at least N seats are left in a matching class; `show` watches with `seats.count` use it as the fallback when no seat map exists.
- **`findBestSeats`** (seat-level): ready, waiting for a seat-map source (below).

## Seats ("perfect seats")
`findBestSeats(map, {count, areas, idealDepth, minDepth})` scores each block of N adjacent free seats:
0.55 × centredness + 0.45 × closeness to the ideal depth (default 65% back; front 30% rejected). Aisles split blocks.
It works today on any `SeatMap`. **What's missing is a live seat-map source.** BMS seat layouts sit behind the
booking flow and Cloudflare, and none of the 7 reference repos has a working one. Plan, in order:
1. **Android WebView reader (preferred):** the user opens the show's seat page in the app's in-app browser, as a normal session.
   An injected script reads the rendered seat grid into a `SeatMap`, and the app ranks the seats on the device.
   This covers "given a URL, find the perfect seats".
2. **Recorded seat-layout API:** capture the seat-layout request in browser devtools on a home network, add the response
   as a fixture, then write a `bmsSeatProvider` parser. This is only usable from networks BMS accepts.
3. Until then, `show` watches with `seats` fall back to seat-class alerts (e.g. "RECLINER available") and say so in the result.

## Android app (planned, minimal rewrite)
- **Expo (React Native, TypeScript)** imports `packages/core` directly: same parser, matcher, diff, scoring and notifiers.
- On-device checks with `expo-background-fetch` (Android runs it every ~15 min or less often, at the OS's discretion), using the phone's own network,
  which BMS generally accepts. The GitHub Actions runner stays as the always-on backup.
- Screens: paste or share a BMS link (Android share sheet) → watch editor (dates, cinemas, formats, seat classes) → list → seat finder (WebView).
- Sync watches with the repo via the GitHub API (fine-grained token, single repo, Contents read/write), so the phone and Actions share one `watches.json`.
- Notifications: local notifications for on-device checks; ntfy for runner alerts until we add Firebase Cloud Messaging (FCM).

## Roadmap
| Phase | Scope |
|---|---|
| ✅ 0 | Core engine, BMS showtimes source, movie & show watches, Telegram / ntfy / email / webhook, GitHub Actions, tests, live-verified |
| ✅ 1 | Telegram commands via `getUpdates` (+ optional listen window), District source with exact seat counts, `rankShows` / `/best`, `minSeats`, ranked booking buttons |
| 2 | Android app: watch editor + on-device checks + local notifications (reuses `packages/core` incl. the bot command grammar) |
| 3 | Seat-level finder: Android WebView reader → `SeatMap` → `findBestSeats`; `SEATS_FOUND` alerts |
| 4 | Recorded real fixtures for contract tests, more cities via the BMS regions API, District city discovery |
