import type { ListingReport, WeixinItem } from "../types.js";

// The one seam between "where content comes from" and everything else
// (Exporter, the eventual server.ts, the task list UI) — same shape as
// zhi-dang's ContentSource. WeixinContentSource (weixin.ts) is the only
// implementation so far, and it's still a skeleton (see docs/DESIGN.md).
export interface ContentSource {
  // Discovers every article the logged-in account has published. Items may
  // come back with an empty html body (the backend's list endpoint is
  // metadata-only) — fetchBody is what actually fills that in per item.
  listAll(onCount?: (n: number) => void): Promise<{ items: WeixinItem[]; report: ListingReport }>;
  // Returns the full HTML body for one item.
  fetchBody(item: WeixinItem): Promise<string>;
}

// Thrown when the logged-in session (the token/cookie captured from the
// login window) is no longer valid — Exporter.export catches this
// specifically and stops the run early, leaving the remaining items
// untouched ("pending") so a later run — after the user logs in again —
// resumes them normally instead of recording a wall of identical auth
// failures. Distinct from zhi-dang's QuotaExhaustedError: there's no known
// per-day quota on this path (see docs/DESIGN.md), the failure mode here is
// "the session itself stopped working," not "ran out of allowance."
export class SessionExpiredError extends Error {}
