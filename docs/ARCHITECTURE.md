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
| 1 | Telegram bot commands (`/add <link>`, `/list`, `/pause`), handled in the hourly run via `getUpdates` (no webhook hosting) |
| 2 | Android app MVP: watch editor + on-device checks + local notifications |
| 3 | Seat finder: WebView reader → `SeatMap` → `findBestSeats`; `SEATS_FOUND` alerts on device |
| 4 | District source (`__NEXT_DATA__`, per-area seat counts), real recorded fixtures, more cities via the BMS regions API |
