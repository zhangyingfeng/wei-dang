import test from "node:test"; import assert from "node:assert/strict";
import { buildListUrl, parsePublishPage, extractJsContent } from "../src/source/weixin.js";

// Field names and query params below are copied from a real captured
// response/request (2026-09-17), not invented — see docs/DESIGN.md. The
// token value itself is a placeholder, not the real one that was captured —
// a real session token has no reason to live in version control even after
// it's expired.
test("buildListUrl matches the real admin backend's query shape", () => {
  const url = new URL(buildListUrl(10, 10, "test-token"));
  assert.equal(url.pathname, "/cgi-bin/appmsgpublish");
  assert.equal(url.searchParams.get("type"), "101_1_102_103");
  assert.equal(url.searchParams.get("sub_action"), "list_ex");
  assert.equal(url.searchParams.get("begin"), "10");
  assert.equal(url.searchParams.get("token"), "test-token");
  assert.equal(url.searchParams.has("search_field"), false);
});

function fakePublishPage(totalCount: number, items: { title: string; link: string; cover: string }[]) {
  const publishList = items.map((it) => ({
    publish_type: 101,
    publish_info: JSON.stringify({
      appmsgex: [{ title: it.title, link: it.link, cover: it.cover, digest: "", create_time: 1, update_time: 1 }],
    }),
  }));
  return JSON.stringify({
    base_resp: { ret: 0, err_msg: "ok" },
    publish_page: JSON.stringify({ total_count: totalCount, publish_list: publishList }),
  });
}

test("parsePublishPage unwraps the real double-nested JSON shape and reads `cover`", () => {
  const body = fakePublishPage(1, [{ title: "标题", link: "https://mp.weixin.qq.com/s/abc", cover: "https://mmbiz.qpic.cn/x.jpg" }]);
  const { items, isEnd, totalCount } = parsePublishPage(body);
  assert.equal(totalCount, 1);
  assert.equal(isEnd, false);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.cover, "https://mmbiz.qpic.cn/x.jpg");
});

test("parsePublishPage reports isEnd once a page is empty", () => {
  const { isEnd, totalCount } = parsePublishPage(fakePublishPage(1, []));
  assert.equal(isEnd, true);
  assert.equal(totalCount, 1);
});

test("parsePublishPage surfaces a non-zero base_resp.ret as an error", () => {
  const body = JSON.stringify({ base_resp: { ret: 61024, err_msg: "invalid session" } });
  assert.throws(() => parsePublishPage(body), /61024/);
});

test("extractJsContent finds the real close tag past a nested <div> (regression: naive regex truncated a real article from 221,836 chars to 185)", () => {
  const html = `<div id="js_content"><p>intro</p><div class="video_iframe_wrapper"><div>player</div></div><p>tail</p></div><script>tail-of-page</script>`;
  const content = extractJsContent(html);
  assert.equal(content, '<p>intro</p><div class="video_iframe_wrapper"><div>player</div></div><p>tail</p>');
});

test("extractJsContent returns null when the page has no article body (e.g. a deleted-article interstitial)", () => {
  const html = `<html><body><div class="weui-msg">该内容已被发布者删除</div></body></html>`;
  assert.equal(extractJsContent(html), null);
});
