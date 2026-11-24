// Shared domain types. Pure TypeScript (erasable syntax only) so the same code runs in
// Node 23.6+ without a build step and inside a React Native (Expo) app later.

/** BMS availability per seat class: 0 sold out, 1 almost full, 2 filling fast, 3 available. */
export type AvailStatus = 0 | 1 | 2 | 3 | -1;

export interface Region { code: string; slug: string; lat: string; lon: string; geohash: string; name: string }

export interface Category {
  name: string;
  price: number;
  status: AvailStatus;
  seatsAvail?: number;   // District gives exact counts; BMS does not
  seatsTotal?: number;
}

export interface Show {
  venueCode: string;
  venueName: string;
  sessionId: string;
  eventCode: string;   // child event code (each format is its own event on BMS)
  dateCode: string;    // YYYYMMDD
  time: string;        // "07:30 PM"
  timeCode: number;    // 1930
  format: string;      // format chip title, e.g. "IMAX 3D"
  screenAttr: string;  // screen label, e.g. "PXL", "INSIGNIA"
  bookingRef?: string; // District encSessionId (needed for its seat-layout page)
  categories: Category[];
}

export type DateState = "BOOKABLE" | "AVAILABLE" | "NOT_OPEN" | "UNKNOWN";
export interface DateStatus { dateCode: string; status: DateState }
export interface FormatChip { eventCode: string; title: string }

export type SourceName = "bms" | "district";

export interface Snapshot {
  source?: SourceName;     // default "bms"
  eventCode: string;
  region: Region;
  movieName: string;
  formats: FormatChip[];
  dates: DateStatus[];
  shows: Show[];
  complete: boolean;       // false when any upstream request failed -> never diff
  failures: string[];
  requests: number;
  /** Booking links (source specific). Optional so hand-built snapshots in tests still work. */
  showLink?: (s: Show) => string;
  dateLink?: (dateCode: string) => string;
}

// ---------------- watches ----------------

/** "morning" | "afternoon" | "evening" | "night" | "late" | "HH:MM-HH:MM" */
export type TimeWindow = string;

export interface SeatPrefs {
  count: number;              // seats together
  areas?: string[];           // preferred seat classes, e.g. ["RECLINER", "PRIME"]
  idealDepth?: number;        // 0 = front row, 1 = last row. Default 0.65
  minDepth?: number;          // reject rows closer than this. Default 0.3
  minScore?: number;          // 0..1, alert only above this. Default 0.6
  fromRow?: string;           // only rows at/behind this label, e.g. "G" (A = front)
  toRow?: string;
  centre?: number;            // max offset of the block's middle from the centre, as a fraction of half-width (0.5 = middle half)
}

export interface WatchBase {
  id: string;
  enabled?: boolean;
  label?: string;
  url: string;                // any BMS movie / buytickets / seat-layout URL
  city?: string;              // override city slug from URL
  dates?: string[];           // "2026-12-17", "20261217" or ranges "2026-12-17..2026-12-25"
  formats?: string[];         // aliases: IMAX, PXL, INFINITY_VISION, 4DX, 3D ... (any match)
  excludeFormats?: string[];
  times?: TimeWindow[];
  categories?: string[];      // seat class substrings, e.g. ["recliner"]
  maxPrice?: number;
  minStatus?: AvailStatus;    // default 1 (anything not sold out)
  minSeats?: number;          // seats left in the class (District only; ignored where unknown)
  language?: string;          // District language group, e.g. "english"
  channels?: string[];        // channel names from config; default all
}

/** Any cinema (optionally limited / excluding some). */
export interface MovieWatch extends WatchBase { type: "movie"; cinemas?: string[]; excludeCinemas?: string[] }

/** One cinema, one show time, optional seat preferences. */
export interface ShowWatch extends WatchBase {
  type: "show";
  cinema: string;             // venue code ("PVLX") or name fragment
  time?: string;              // "19:30"
  toleranceMinutes?: number;  // default 45
  seats?: SeatPrefs;
}

export type Watch = MovieWatch | ShowWatch;

// ---------------- changes / alerts ----------------

export type ChangeKind = "DATE_OPENED" | "NEW_SHOW" | "BACK_IN_STOCK" | "STATUS_UP" | "SEATS_FOUND";

export interface Change {
  kind: ChangeKind;
  watchId: string;
  show?: Show;
  category?: Category;
  dateCode?: string;
  detail?: string;
  link: string;
}

export interface Button { text: string; url: string }
export interface ActionButton { text: string; data: string }   // Telegram callback button (≤64-byte data)
export interface Notification {
  title: string; text: string; html: string; link: string; priority: "default" | "high" | "urgent";
  buttons?: Button[];          // URL buttons (booking)
  tg?: string;                 // Telegram-flavoured HTML (only <b><i><a><code>, \n line breaks)
  actions?: ActionButton[];    // callback buttons (pause, snooze, best now...)
  full?: string;               // complete list as Markdown (published as a "View all" page when the push is trimmed)
  total?: number;              // shows in the full list
  trimmed?: boolean;           // text/html (push, email) show only the top entries
  allUrl?: string;             // set by the runner once the full page is published
}

export interface Notifier { name: string; send(n: Notification): Promise<void> }

export interface HttpResult { status: number; body: string }
/** Injected transport so Node (fetch / curl_cffi) and mobile can each supply their own. */
export type Fetcher = (url: string, headers: Record<string, string>) => Promise<HttpResult>;
