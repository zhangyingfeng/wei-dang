import test from "node:test"; import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os"; import path from "node:path";
import { Exporter } from "../src/exporter.js";
import { DeletedContentError } from "../src/source/types.js";
import type { ContentSource } from "../src/source/types.js";
import type { ListingReport, WeixinItem } from "../src/types.js";

const report: ListingReport = { reportedTotal: null, received: 1, unique: 1, duplicates: 0, warning: null };
function item(id: string): WeixinItem {
  return { id, title: id, url: `https://mp.weixin.qq.com/s/${id}`, html: "", excerpt: "", created: 1700000000, updated: 1700000000, readCount: null, likeCount: null, commentCount: null, coverUrl: null };
}
async function tmpDir() { return mkdtemp(path.join(os.tmpdir(), "exporter-test-")); }

// Regression: a user reported that re-running an export kept re-attempting
// (and re-failing) articles already confirmed deleted by the author. Fixed
// by giving DeletedContentError its own terminal "deleted" status — never
// retried, and recorded in export-report.json's deletedItems so a later
// run's server.ts can skip it outright (see the next test).
test("a deleted article is recorded as deleted, not error, and fetchBody isn't retried", async () => {
  const outputDir = await tmpDir();
  let calls = 0;
  const source: ContentSource = {
    async listAll() { return { items: [], report }; },
    async fetchBody() { calls++; throw new DeletedContentError("这篇文章已被作者删除，无法归档正文。"); },
  };
  const events: string[] = [];
  await new Exporter().export([item("a")], report, { outputDir, downloadImages: false, delayMs: 10 }, source, (e) => { if (e.type === "done") events.push(e.status); });
  assert.equal(calls, 1);
  assert.deepEqual(events, ["deleted"]);
  const written = JSON.parse(await readFile(path.join(outputDir, "export-report.json"), "utf8"));
  assert.equal(written.summary.deleted, 1);
  assert.equal(written.deletedItems[0].itemId, "a");
});

test("ExportControl.deletedItemIds skips a known-deleted item without calling fetchBody at all", async () => {
  const outputDir = await tmpDir();
  let calls = 0;
  const source: ContentSource = {
    async listAll() { return { items: [], report }; },
    async fetchBody() { calls++; throw new Error("should not be called for a pre-confirmed deletion"); },
  };
  const events: string[] = [];
  await new Exporter().export([item("a")], report, { outputDir, downloadImages: false, delayMs: 10 }, source, (e) => { if (e.type === "done") events.push(e.status); }, { paused: false, skippedItemIds: new Set(), skipImagesItemIds: new Set(), deletedItemIds: new Set(["a"]) });
  assert.equal(calls, 0);
  assert.deepEqual(events, ["deleted"]);
});
