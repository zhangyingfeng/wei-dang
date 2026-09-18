import { sleep } from "../util.js";
import { DeletedContentError, type ContentSource } from "./types.js";
import type { WeixinItem } from "../types.js";

// The (only, so far) ContentSource implementation — "路线B" from
// docs/DESIGN.md: the author logs into their own public-account admin
// backend, and this only ever queries that logged-in account's own fakeid —
// never a search across other accounts. That boundary is the whole reason
// this project exists instead of just wrapping an existing scraper.
//
// The overall data flow is settled (copied from zhi-dang's
// LoginContentSource). The listing endpoint's params/response shape and the
// article-body extraction have been checked against a real logged-in
// session (2026-09-17, see docs/DESIGN.md) — remaining TODOs below are the
// parts that capture session didn't exercise (risk-control/challenge
// responses, session expiry).
//
// Key difference from zhi-dang's login source: Zhihu's member-listing
// endpoint returns full HTML content per item, so fetchBody there is a
// no-op. WeChat's backend listing endpoint is metadata-only, so fetchBody
// has to fetch the article's public page separately — but that page doesn't
// require the logged-in session, so it can be a plain Node-side fetch
// instead of going through the login-window relay.

// The backend's endpoints only trust same-origin cookies + the token in the
// URL; this process can't hold that cookie, so listAll's requests have to be
// relayed through the login window's own page context — same idea as
// zhi-dang's frontendBridge.ts, just not written yet (no Tauri shell exists
// in this repo so far, see docs/DESIGN.md's next steps).
export type WeixinPageFetcher = (url: string) => Promise<{ status: number; body: string }>;

// Captured from the login window's URL after a successful QR-code login
// (token=xxxxxxxx in the address bar) — not a field any API call returns.
// There's no separate fakeid to track: the backend list endpoint is scoped
// to the logged-in account by cookie+token alone, so nothing here should
// ever request a different account's content.
export interface WeixinSession { token: string }

// ---- Listing endpoint shape — verified 2026-09-17 against a real account ----
//
//   GET https://mp.weixin.qq.com/cgi-bin/appmsgpublish
//       ?sub=list&begin=<offset>&count=<pageSize>&query=&type=101_1_102_103
//       &show_type=&free_publish_type=1_102_103&sub_action=list_ex
//       &search_card=0&token=<token>&lang=zh_CN&f=json&ajax=1
//
// `type=9` (the earlier guess) also returns base_resp.ret 0 but an *empty*
// publish_list on a real account with 27 published items — a silent-empty
// failure, not a loud one, so this was worth getting right. The admin UI
// also sends a `fingerprint` param, but the backend accepts requests with it
// omitted or set to garbage (tested), so it's left out here rather than
// implementing whatever client-side fingerprinting generates it.
//
// Response: { base_resp: { ret, err_msg }, publish_page: "<JSON string>" }
// — publish_page is itself an escaped JSON string that needs a second parse;
// each entry's publish_info field is a further nested JSON string. Both
// parse layers and the publish_list/appmsgex field names below are
// confirmed against real responses.
interface RawPublishPage { base_resp?: { ret: number; err_msg: string }; publish_page?: string }
interface RawPublishInfo { appmsgex?: RawAppMsg[] }
interface RawAppMsg { title: string; link: string; create_time: number; update_time: number; cover: string; digest: string }

export function buildListUrl(offset: number, pageSize: number, token: string) {
  const url = new URL("https://mp.weixin.qq.com/cgi-bin/appmsgpublish");
  url.searchParams.set("sub", "list");
  url.searchParams.set("begin", String(offset));
  url.searchParams.set("count", String(pageSize));
  url.searchParams.set("query", "");
  url.searchParams.set("type", "101_1_102_103");
  url.searchParams.set("show_type", "");
  url.searchParams.set("free_publish_type", "1_102_103");
  url.searchParams.set("sub_action", "list_ex");
  url.searchParams.set("search_card", "0");
  url.searchParams.set("token", token);
  url.searchParams.set("lang", "zh_CN");
  url.searchParams.set("f", "json");
  url.searchParams.set("ajax", "1");
  return url.toString();
}

// TODO: the success path (ret 0) is verified; a non-zero base_resp.ret or a
// non-JSON body has not actually been observed (this capture session never
// triggered risk control or an expired session), so the classification
// below — and in particular the risk-control-page guess — is still
// unconfirmed. Revisit once one of these actually happens against a real
// account.
export function parsePublishPage(body: string): { items: RawAppMsg[]; isEnd: boolean; totalCount: number } {
  let page: RawPublishPage;
  try { page = JSON.parse(body); }
  catch { throw new Error("公众号后台返回的不是预期的 JSON——可能是登录态过期，或者触发了验证码/风控页面，需要重新登录。"); }
  if (page.base_resp && page.base_resp.ret !== 0) throw new Error(`公众号后台接口返回错误 ${page.base_resp.ret}：${page.base_resp.err_msg}`);
  if (!page.publish_page) throw new Error("公众号后台返回的数据格式已经变化，无法继续解析；请检查应用更新。");
  const parsed = JSON.parse(page.publish_page) as { publish_list?: { publish_info?: string }[]; total_count?: string };
  const items = (parsed.publish_list ?? []).flatMap((entry) => {
    if (!entry.publish_info) return [];
    const info = JSON.parse(entry.publish_info) as RawPublishInfo;
    return info.appmsgex ?? [];
  });
  const totalCount = Number(parsed.total_count ?? 0);
  // Verified against a real 27-article account: total_count stays constant
  // across pages, and publish_list is empty once offset >= total_count — so
  // either condition alone is a reliable end-of-pagination signal.
  return { items, isEnd: items.length === 0, totalCount };
}

function normalizeItem(raw: RawAppMsg): WeixinItem {
  const id = /\/s\/([\w-]+)/.exec(raw.link)?.[1] ?? raw.link;
  return {
    id,
    title: raw.title,
    url: raw.link,
    // The listing endpoint doesn't give the body — fetchBody fetches the
    // article's public page separately and fills this in.
    html: "",
    excerpt: raw.digest ?? "",
    created: raw.create_time,
    updated: raw.update_time ?? raw.create_time,
    // The listing endpoint most likely doesn't expose engagement numbers at
    // all — those typically live behind a separate stats endpoint
    // (something like getappmsgext) that isn't necessarily available for
    // every article. Left as null rather than guessed at.
    readCount: null,
    likeCount: null,
    commentCount: null,
    coverUrl: raw.cover || null,
  };
}

// Confirmed 2026-09-17: a real article page renders full content with this
// desktop UA (mobile UA not tested, but there's no reason to prefer it).
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// A deleted article's public page still returns HTTP 200, just with an
// interstitial instead of #js_content — confirmed against a real deleted
// article in this account's own history. Matched by substring rather than
// parsed structurally since the interstitial's own markup isn't a
// documented contract, just observed text.
const DELETED_MARKERS = ["该内容已被发布者删除", "此内容因违规无法查看", "该内容已被发送人删除"];

// #js_content routinely contains nested <div>s of its own (video players,
// image wrappers), so "stop at the next </div>" truncates real articles —
// confirmed against a real video post where it cut 221,836 characters of
// content down to 185. This scans for the actual matching close tag by
// depth instead of trusting the first one.
export function extractJsContent(html: string): string | null {
  const openTagMatch = /<div[^>]*\bid="js_content"[^>]*>/i.exec(html);
  if (!openTagMatch) return null;
  const contentStart = openTagMatch.index + openTagMatch[0].length;
  const tagRe = /<div\b|<\/div>/gi;
  tagRe.lastIndex = openTagMatch.index;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    depth += m[0].toLowerCase().startsWith("<div") ? 1 : -1;
    if (depth === 0) return html.slice(contentStart, m.index);
  }
  return null; // unbalanced markup — shouldn't happen, but don't return a bogus slice
}

export class WeixinContentSource implements ContentSource {
  constructor(private session: WeixinSession, private fetchPage: WeixinPageFetcher, private delayMs = 1200) {}

  async listAll(onCount?: (n: number) => void) {
    const items: WeixinItem[] = [];
    const seen = new Set<string>();
    let offset = 0;
    // Matches the real admin UI's own page size (verified 2026-09-17); a
    // larger page size hasn't been tested and a tight request cadence is
    // more likely to trip rate limiting or a challenge page, so there's no
    // reason to push past what the UI itself uses.
    const pageSize = 10;
    let completed = false;
    const maxPages = 1000;
    for (let guard = 0; guard < maxPages; guard++) {
      const { status, body } = await this.fetchPage(buildListUrl(offset, pageSize, this.session.token));
      if (status !== 200) throw new Error(`公众号后台接口返回 HTTP ${status}，登录态可能已失效，请重新登录。`);
      const page = parsePublishPage(body);
      for (const raw of page.items) {
        const item = normalizeItem(raw);
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
      onCount?.(items.length);
      if (page.isEnd) { completed = true; break; }
      offset += pageSize;
      await sleep(this.delayMs);
    }
    if (!completed) throw new Error("公众号分页超过安全上限，导出已停止以避免生成不完整归档。");
    return { items, report: { reportedTotal: null, received: items.length, unique: items.length, duplicates: 0, warning: null } };
  }

  // The public article page needs no session and no login-window relay —
  // simpler than Zhihu, where the body also has to come from inside the
  // logged-in window.
  async fetchBody(item: WeixinItem) {
    const response = await fetch(item.url, { headers: { "User-Agent": DESKTOP_UA } });
    if (!response.ok) throw new Error(`公众号文章页面请求失败 ${response.status}`);
    const html = await response.text();
    const content = extractJsContent(html);
    if (content === null) {
      if (DELETED_MARKERS.some((marker) => html.includes(marker))) throw new DeletedContentError("这篇文章已被作者删除，无法归档正文。");
      // TODO: "仅限特定读者可见"/"环境异常" interstitials haven't actually
      // been observed yet (only the deleted case has), so they'd still fall
      // through to this generic message rather than a specific one.
      throw new Error("未能在文章页面中找到正文（可能页面结构已变化，或文章仅限特定读者可见）。");
    }
    return content;
  }
}
