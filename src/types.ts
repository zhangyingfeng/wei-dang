export interface WeixinItem {
  id: string;
  title: string;
  url: string;
  html: string;
  excerpt: string;
  created: number;
  updated: number;
  readCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  coverUrl: string | null;
}
export interface ExportOptions { outputDir: string; downloadImages: boolean; delayMs: number; }
// What index.json actually stores per item: the source WeixinItem minus its
// raw html (already folded into the written Markdown, so keeping it here
// too would just double the file size) plus where it ended up on disk.
export interface ExportRecord extends Omit<WeixinItem,"html"> { cover: string | null; file: string; }
export type TaskStatus = "pending" | "active" | "done" | "error" | "skipped";
// One row per image referenced by an item — nested inside the "images"
// SubTask so the UI can show a per-image breakdown (which one failed, why)
// behind an expand toggle instead of cluttering the item row itself.
export interface ImageTask { url: string; status: TaskStatus; error?: string; }
export interface SubTask { key: "images" | "write" | "word"; status: TaskStatus; images?: ImageTask[]; }
// Set when this item's normalized body text hash-matches one or more other
// items in the same export (see contentHash in util.ts) — an exact-content
// signal only, surfaced read-only.
export interface DuplicateInfo { groupSize: number; otherTitles: string[]; }
export interface ExportTask { id: string; title: string; status: TaskStatus; subtasks: SubTask[]; error?: string; duplicate?: DuplicateInfo; }
// Emitted by Exporter.export as it works through each item, so a caller can
// update its own ExportTask list without the exporter needing to know
// anything about how progress is surfaced.
export type TaskEvent =
  | { type: "start"; id: string }
  | { type: "subtask"; id: string; key: SubTask["key"]; status: "active" | "done" | "error" | "skipped" }
  | { type: "images-list"; id: string; urls: string[] }
  | { type: "image"; id: string; url: string; status: "active" | "done" | "error"; error?: string }
  | { type: "done"; id: string; status: "done" | "error" | "skipped"; error?: string }
  | { type: "duplicate"; id: string; info: DuplicateInfo };
// "session-expired" is distinct from "done": the run stopped early because
// the logged-in session (see ContentSource/SessionExpiredError in
// src/source/types.ts) is no longer valid, not because every item finished
// — outputDir still points at a real, resumable, partial archive.
export interface Progress { phase: "idle"|"login"|"listing"|"exporting"|"done"|"session-expired"|"error"; message: string; current?: number; total?: number; outputDir?: string; tasks?: ExportTask[]; paused?: boolean; }
// Shared, in-memory, run-scoped control surface for pause/resume/skip — see
// zhi-dang's src/types.ts for the reasoning (deliberately lighter than a
// resume-after-restart design, which index.json/resumedRecords cover
// separately).
export interface ExportControl { paused: boolean; skippedItemIds: Set<string>; skipImagesItemIds: Set<string>; resumedRecords?: Map<string,ExportRecord>; }
export interface ListingReport { reportedTotal: number | null; received: number; unique: number; duplicates: number; warning: string | null; }
export interface ListingResult { items: WeixinItem[]; report: ListingReport; }
