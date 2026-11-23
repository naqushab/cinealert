// Channel adapters. All plain fetch(), so they work in Node, GitHub Actions and React Native.
import type { Notification, Notifier } from "../types.ts";

type Fetch = typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function telegram(token: string, chatIds: string[], f: Fetch = fetch): Notifier {
  return {
    name: "telegram",
    async send(n: Notification) {
      // Telegram caps messages at 4096 chars; split on line boundaries.
      const body = `<b>${n.title.replace(/</g, "&lt;")}</b>\n\n${n.html.replace(/<br>/g, "\n")}`;
      const chunks: string[] = [];
      let cur = "";
      for (const line of body.split("\n")) {
        if ((cur + line).length > 3800) { chunks.push(cur); cur = ""; }
        cur += line + "\n";
      }
      if (cur.trim()) chunks.push(cur);
      for (const chat_id of chatIds) {
        for (let i = 0; i < chunks.length; i++) {
          const payload: Record<string, unknown> = { chat_id, text: chunks[i], parse_mode: "HTML", disable_web_page_preview: true };
          if (i === chunks.length - 1) payload.reply_markup = { inline_keyboard: (n.buttons?.length ? n.buttons : [{ text: "🎟️ Book now", url: n.link }]).slice(0, 6).map((b) => [{ text: b.text, url: b.url }]) };
          for (let attempt = 0; ; attempt++) {
            const r = await f(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
            if (r.ok) break;
            const j: any = await r.json().catch(() => ({}));
            if (r.status === 429 && attempt < 3) { await sleep(Math.min(30, j?.parameters?.retry_after ?? 5) * 1000); continue; }
            throw new Error(`telegram ${chat_id}: HTTP ${r.status} ${j?.description || ""}`);
          }
        }
      }
    },
  };
}

/** ntfy.sh push (free Android/iOS app, no account). JSON publish keeps emoji safe. */
export function ntfy(topic: string, server = "https://ntfy.sh", f: Fetch = fetch, token?: string): Notifier {
  return {
    name: "ntfy",
    async send(n: Notification) {
      const r = await f(server.replace(/\/$/, "") + "/", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ topic, title: n.title, message: n.text.slice(0, 3900), click: n.buttons?.[0]?.url || n.link, actions: (n.buttons || []).slice(0, 3).map((b) => ({ action: "view", label: b.text.slice(0, 40), url: b.url })), priority: n.priority === "urgent" ? 5 : n.priority === "high" ? 4 : 3, tags: ["ticket"] }),
      });
      if (!r.ok) throw new Error(`ntfy: HTTP ${r.status}`);
    },
  };
}

/** Email via Resend's HTTP API (free tier: 100/day). */
export function resendEmail(apiKey: string, from: string, to: string[], f: Fetch = fetch): Notifier {
  return {
    name: "email",
    async send(n: Notification) {
      const html = `<div style="font-family:sans-serif"><h2>${n.title}</h2><p>${n.html}</p><p>${(n.buttons?.length ? n.buttons : [{ text: "Book now", url: n.link }]).map((b) => `<a href="${b.url}" style="display:inline-block;margin:4px;background:#f84464;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${b.text}</a>`).join("")}</p></div>`;
      const r = await f("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, subject: n.title, html, text: `${n.text}\n\n${n.link}` }),
      });
      if (!r.ok) throw new Error(`email: HTTP ${r.status} ${await r.text().catch(() => "")}`);
    },
  };
}

/** Generic JSON webhook (Discord-compatible "content" field included). */
export function webhook(url: string, f: Fetch = fetch): Notifier {
  return {
    name: "webhook",
    async send(n: Notification) {
      const r = await f(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...n, content: `**${n.title}**\n${n.text}`.slice(0, 1900) }) });
      if (!r.ok) throw new Error(`webhook: HTTP ${r.status}`);
    },
  };
}

export function consoleNotifier(log: (s: string) => void = console.log): Notifier {
  return { name: "console", async send(n) { log(`\n=== ${n.title} [${n.priority}]\n${n.text}\n→ ${n.link}\n`); } };
}

/** At-least-once: resolves true if at least one channel delivered. */
export async function dispatch(n: Notification, notifiers: Notifier[], log: (s: string) => void = console.log): Promise<boolean> {
  const results = await Promise.allSettled(notifiers.map((x) => x.send(n)));
  results.forEach((r, i) => { if (r.status === "rejected") log(`  ✗ ${notifiers[i].name}: ${r.reason?.message || r.reason}`); });
  return results.some((r) => r.status === "fulfilled");
}
