# CineAlert

Watches **BookMyShow** and **District** for the movies, dates, cinemas, formats and seat classes you care about, and
alerts you on **Telegram**, **phone push (ntfy)** and/or **email**. Runs free on **GitHub Actions**
(hourly), with nothing to host and no machine of yours left running.

- No build step: TypeScript run directly by Node ≥ 23.6. No npm dependencies.
- `packages/core` is pure TS with no Node APIs, so the planned Android app (Expo / React Native) reuses it unchanged.

## Telegram commands

Talk to your bot (only chats listed in `TELEGRAM_CHAT_ID` are obeyed):

| Command | Does |
|---|---|
| *(paste a BMS or District link)* | Watch it (same as `/add`) |
| `/add <link> dates=17-12..25-12 formats=pxl,4dx cinemas="logix,mall of india" times=evening,night class=recliner seats=2 max=1500 lang=english` | Watch a movie (any or listed cinemas) |
| `/show <link> cinema=PVLE time=19:30 seats=2 class=recliner dates=18-12` | Watch one cinema / one show time |
| `/best <link> date=18-12 seats=2 class=recliner time=19:30 lang=english` | Rank the best shows to book **right now** |
| `/inspect <link>` | Formats, open dates, cinema codes |
| `/list` · `/pause <id>` · `/resume <id>` · `/remove <id>` | Manage watches (bot watches are `b1`, `b2`...; file watches can be paused) |

**Reply speed.** Nothing is hosted, so commands are read when the workflow runs: on the next hourly run by default.
Set the repo **variable** `BOT_LISTEN_SECONDS` (Settings → Secrets and variables → Actions → Variables) to keep
listening after each check, e.g. `1500` = live replies for ~25 min of every hour. Do this on a public repo
(free minutes); on a private repo it uses ~25 Actions minutes per run. Run the workflow by hand for an instant pass.
Watches added from Telegram live in `bot.json` on the `state` branch.

## Sources

| | BookMyShow | District |
|---|---|---|
| Link | `in.bookmyshow.com/movies/<city>/<movie>/buytickets/ET...` | `district.in/movies/<movie>-movie-tickets-in-<city>-MV...` |
| Data | showtimes API (JSON) | server-rendered page data |
| Availability | status per seat class (sold out / almost full / filling fast / available) | **exact seats left** per class (`48/108 left`) |
| Formats | chips (Infinity Vision, 4DX 3D, ICE 3D...) + screen labels (PXL) | screen format (`MS INFINITY VISION 4DX-3D`); `lang=` picks the language |
| Booking link in alerts | straight to the show's **seat layout** | the date + language showtimes page (District's seat links don't open cold) |

`minSeats` (`seats=` in commands) uses District's exact counts; BMS doesn't publish counts, so it's ignored there.

## Watch types

| `type` | Use it for | Key fields |
|---|---|---|
| `movie` | A movie at **any** cinema (or a list, or "all except") | `cinemas`, `excludeCinemas` |
| `show`  | **One** cinema, around **one** time, specific seat class / seats | `cinema`, `time`, `toleranceMinutes`, `seats` |

Common fields: `url` (any BMS movie, buytickets or seat-layout link), `dates` (`"2026-12-17"` or a
range `"2026-12-17..2026-12-25"`), `formats` / `excludeFormats`, `times` (`morning`, `afternoon`,
`evening`, `night`, `late`, or `"18:00-23:30"`), `categories` (seat-class substrings like `recliner`),
`maxPrice`, `minStatus` (1 almost full · 2 filling fast · 3 available), and `channels`.

**Formats.** BMS has two levels. Format *chips* are separate events (e.g. `MS-Infinity Vsn 3d`,
`MS - Inf Vsn 4DX 3D`, `MS InfVsn ICE 3D`). *Screen labels* sit on each show (`PXL`, `ATMOS`, `4DX`).
A wanted format matches either level. Aliases: `IMAX, PXL, INFINITY_VISION, 4DX, SCREENX, ICE, EPIQ, DOLBY, INSIGNIA, 3D, 2D`.

**Alerts** come with up to 3 **ranked "book this" buttons** (best new shows for your preferences) plus "All shows" for opened dates, in Telegram, ntfy (action buttons) and email.
Kinds: 📅 date opened · 🆕 new show / seat class · 🔁 back after sold out (10-minute cooldown) ·
⬆️ availability improved · 💺 good seats found (needs a seat map; see docs) · ⚠️ BMS blocking us / ✅ recovered · 🫡 daily summary.

## Set up (free, about 15 minutes)

1. **Create a GitHub repo** on your *personal* account and push this folder (commands at the bottom).
   - Public repo: unlimited Actions minutes, but your `watches.json` is visible. Secrets stay hidden.
   - Private repo: 2,000 min/month, which is plenty for hourly runs (~3 min each ≈ 2,200/month at 24 runs a day).
     Use cron `17 */2 * * *` or `17 6-23 * * *` to stay inside the limit.
2. **Telegram:** message @BotFather, run `/newbot`, copy the token. Send your bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`.
3. **Phone push (optional):** install the **ntfy** app, subscribe to a long random topic name (e.g. `cinealert-7f3k9x2q`).
4. **Email (optional):** create a free key at resend.com. With `onboarding@resend.dev` as the sender you can only mail your own address.
5. **Repo → Settings → Secrets and variables → Actions:** add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
   (comma-separate several ids) and optionally `NTFY_TOPIC`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TO`.
   Channels without secrets are skipped.
6. **Actions tab:** enable workflows, then run **CineAlert check** once by hand (`Run workflow`).

The first run alerts on everything that already matches; after that you only hear about changes.
State is kept on a separate `state` branch.

## Add a movie

Edit `watches.json` (the GitHub web or mobile app is fine), paste the BMS link into `url`, set dates and formats, and commit.
To see what a link offers (formats, open dates, cinema codes), run:

```bash
pip install curl_cffi            # once
FETCHER=cffi node apps/runner/inspect.ts "<bookmyshow link>"
```

## Local commands

```bash
npm test                                    # unit tests (synthetic fixtures)
FETCHER=cffi node apps/runner/main.ts --dry-run   # real check, prints alerts, saves nothing
node apps/runner/seats.ts --layout seatmap.json --count 2 --areas recliner   # best seats from a saved map
```

## Why GitHub Actions + curl_cffi

BookMyShow refuses plain HTTP clients (HTTP 403 based on the TLS fingerprint) and often refuses data-centre IPs.
`tools/fetch_cffi.py` sends requests with Chrome's fingerprint. If GitHub's IPs get blocked anyway, you
get one ⚠️ alert and the run keeps trying. The Android app (roadmap) then becomes the fallback, because it checks from your phone's network.
We never solve CAPTCHAs or bypass challenges. Keep the volume low: this is a personal tool.

See `docs/ARCHITECTURE.md` for design and roadmap.
