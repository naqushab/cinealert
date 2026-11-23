import { readFile } from "node:fs/promises";
import type { Notifier, Watch } from "../../packages/core/src/index.ts";
import { consoleNotifier, ntfy, resendEmail, telegram, webhook } from "../../packages/core/src/index.ts";

export interface ChannelCfg { type: "telegram" | "ntfy" | "email" | "webhook"; [k: string]: string }
import type { SeatWatch } from "./seatwatch.ts";
export interface Config { channels: Record<string, ChannelCfg>; watches: Watch[]; seatWatches?: SeatWatch[]; dailySummaryHourIST?: number }

export async function loadConfig(path = process.env.WATCHES_FILE || "watches.json"): Promise<Config> {
  const cfg = JSON.parse(await readFile(path, "utf8")) as Config;
  const ids = new Set<string>();
  for (const w of cfg.watches) {
    if (!w.id || ids.has(w.id)) throw new Error(`watch ids must be unique and non-empty (got "${w.id}")`);
    ids.add(w.id);
    if (w.type !== "movie" && w.type !== "show") throw new Error(`watch ${w.id}: type must be "movie" or "show"`);
    if (w.type === "show" && !w.cinema) throw new Error(`watch ${w.id}: "show" watches need "cinema"`);
  }
  return cfg;
}

const env = (name?: string) => (name ? (process.env[name] || "").trim() : "");
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Builds notifiers whose secrets are present; missing ones are skipped with a warning. */
export function buildNotifiers(cfg: Config, dryRun: boolean, log = console.log): Record<string, Notifier> {
  if (dryRun) return { console: consoleNotifier() };
  const out: Record<string, Notifier> = {};
  for (const [name, c] of Object.entries(cfg.channels || {})) {
    if (c.type === "telegram" && env(c.tokenEnv) && env(c.chatIdsEnv)) out[name] = telegram(env(c.tokenEnv), list(env(c.chatIdsEnv)));
    else if (c.type === "ntfy" && env(c.topicEnv)) out[name] = ntfy(env(c.topicEnv), c.server || "https://ntfy.sh", fetch, env(c.tokenEnv) || undefined);
    else if (c.type === "email" && env(c.apiKeyEnv) && env(c.toEnv)) out[name] = resendEmail(env(c.apiKeyEnv), env(c.fromEnv) || "CineAlert <onboarding@resend.dev>", list(env(c.toEnv)));
    else if (c.type === "webhook" && env(c.urlEnv)) out[name] = webhook(env(c.urlEnv));
    else log(`  (channel "${name}" skipped: its secrets are not set)`);
  }
  if (!Object.keys(out).length) { log("  No channels configured: printing alerts to the log instead."); out.console = consoleNotifier(); }
  return out;
}
