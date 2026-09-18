// The public-account backend only trusts same-origin cookies + the token in
// the URL; this Node process can't hold that cookie, so WeixinContentSource's
// requests have to be relayed through the login window's own page context
// (see do_weixin_fetch in src-tauri/src/lib.rs). This module is the Node-side
// half of that relay — a long-poll queue the frontend drains via
// GET /api/frontend-fetch-request, runs through the login window's fetch(),
// and reports back via POST /api/frontend-fetch-result.
import type { WeixinPageFetcher } from "./source/weixin.js";

interface QueuedRequest { id: number; url: string }
interface PendingResolver { resolve: (page: { status: number; body: string }) => void; reject: (error: Error) => void }

let nextId = 1;
const pending = new Map<number, PendingResolver>();
const queue: QueuedRequest[] = [];
let waitingResolver: ((value: QueuedRequest | null) => void) | null = null;

export const fetchViaFrontend: WeixinPageFetcher = (url: string) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const item = { id, url };
    if (waitingResolver) { const notify = waitingResolver; waitingResolver = null; notify(item); }
    else queue.push(item);
  });

export function waitForFrontendRequest(timeoutMs: number): Promise<QueuedRequest | null> {
  return new Promise((resolve) => {
    const queued = queue.shift();
    if (queued) { resolve(queued); return; }
    const timer = setTimeout(() => { waitingResolver = null; resolve(null); }, timeoutMs);
    waitingResolver = (value) => { clearTimeout(timer); resolve(value); };
  });
}

// Unlike Zhihu's relay, there's no fixed response shape to validate here —
// parsePublishPage (weixin.ts) already does its own JSON-shape checking and
// error messages, so this just hands the raw status/body through.
export function submitFrontendResult(id: number, status: number, body: string) {
  const resolver = pending.get(id);
  if (!resolver) return;
  pending.delete(id);
  if (status === 0) { resolver.reject(new Error(`登录窗口请求失败：${body}`)); return; }
  resolver.resolve({ status, body });
}
