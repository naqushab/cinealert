// Telegram commands without hosting anything: each run reads pending messages (getUpdates),
// and optionally keeps listening for BOT_LISTEN_SECONDS so replies are near-instant.
import { readFile, writeFile } from "node:fs/promises";
import { HELP, parseCommand } from "../../packages/core/src/index.ts";
import type { Command, Draft, Watch } from "../../packages/core/src/index.ts";

export interface BotStore { offset: number; nextId: number; watches: Watch[]; paused: string[]; drafts: Record<string, Draft> }
const FILE = (dir: string) => `${dir}/bot.json`;

export async function loadBot(dir: string): Promise<BotStore> {
  const empty: BotStore = { offset: 0, nextId: 1, watches: [], paused: [], drafts: {} };
  try { return { ...empty, ...JSON.parse(await readFile(FILE(dir), "utf8")) }; } catch { return empty; }
}
export const saveBot = (dir: string, b: BotStore) => writeFile(FILE(dir), JSON.stringify(b, null, 2) + "\n");

export interface Tg { token: string; allowed: Set<string> }

export async function tgCall(tg: Tg, method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${tg.token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
  return j.result;
}

export async function reply(tg: Tg, chat: string, html: string): Promise<void> {
  for (let i = 0; i < html.length; i += 3800)
    await tgCall(tg, "sendMessage", { chat_id: chat, text: html.slice(i, i + 3800), parse_mode: "HTML", disable_web_page_preview: true });
}

type KB = { text: string; data: string }[][];
const markup = (kb: KB) => ({ inline_keyboard: kb.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) });

/** Sends or edits the wizard card. Returns the message id. */
export async function card(tg: Tg, chat: string, html: string, kb: KB, msgId?: number): Promise<number> {
  const text = html.slice(0, 4000);
  if (msgId) {
    try { await tgCall(tg, "editMessageText", { chat_id: chat, message_id: msgId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: markup(kb) }); return msgId; }
    catch (e) { if (/not modified/.test((e as Error).message)) return msgId; }
  }
  const m = await tgCall(tg, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: markup(kb) });
  return m.message_id;
}

export const ack = (tg: Tg, id: string, text = "") => tgCall(tg, "answerCallbackQuery", { callback_query_id: id, text }).catch(() => {});

export interface Incoming { chat: string; text: string; command: Command; callback?: { id: string; data: string; msgId: number } }

/** Fetch pending messages from allowed chats. waitSeconds > 0 long-polls. */
export async function pull(tg: Tg, bot: BotStore, waitSeconds = 0, log = console.log): Promise<Incoming[]> {
  const updates: any[] = await tgCall(tg, "getUpdates", { offset: bot.offset, timeout: waitSeconds, allowed_updates: ["message", "callback_query"] }, (waitSeconds + 15) * 1000);
  const out: Incoming[] = [];
  for (const u of updates) {
    bot.offset = Math.max(bot.offset, u.update_id + 1);
    if (u.callback_query) {
      const q = u.callback_query, chat = String(q.message?.chat?.id ?? "");
      if (tg.allowed.has(chat)) out.push({ chat, text: "", command: { cmd: "help" }, callback: { id: q.id, data: String(q.data || ""), msgId: q.message?.message_id } });
      else await ack(tg, q.id, "Not allowed");
      continue;
    }
    const chat = String(u.message?.chat?.id ?? "");
    const text = String(u.message?.text || u.message?.caption || "");
    if (!chat || !text) continue;
    if (!tg.allowed.has(chat)) { log(`  ignored message from chat ${chat} (not in TELEGRAM_CHAT_ID)`); continue; }
    out.push({ chat, text, command: parseCommand(text) });
  }
  return out;
}

export function describeWatch(w: Watch): string {
  const bits = [w.type === "show" ? `${w.cinema}${w.time ? ` @${w.time}` : ""}` : (w.cinemas?.join("/") || "any cinema"),
    w.dates?.join(",") || "any date", w.formats?.join("/") || "any format",
    w.categories?.length ? w.categories.join("/") : "", w.minSeats ? `${w.minSeats}+ seats` : "", w.maxPrice ? `≤₹${w.maxPrice}` : ""].filter(Boolean);
  return bits.join(" · ");
}

export { HELP };
