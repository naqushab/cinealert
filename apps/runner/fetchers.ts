import { spawn } from "node:child_process";
import type { Fetcher } from "../../packages/core/src/index.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const nodeFetcher: Fetcher = async (url, headers) => {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(20_000) });
  return { status: r.status, body: await r.text() };
};

export function cffiFetcher(python = process.env.PYTHON || "python3"): Fetcher {
  return (url, headers) => new Promise((resolve, reject) => {
    const p = spawn(python, [new URL("../../tools/fetch_cffi.py", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", () => { try { resolve(JSON.parse(out)); } catch { reject(new Error("curl_cffi helper produced no JSON")); } });
    p.stdin.end(JSON.stringify({ url, headers }));
  });
}

export function pickFetcher(): Fetcher {
  return (process.env.FETCHER || "fetch") === "cffi" ? cffiFetcher() : nodeFetcher;
}
