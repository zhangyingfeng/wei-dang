import { sleep } from "../util.js";
import type { ContentSource } from "./types.js";
import type { WeixinItem } from "../types.js";

// The (only, so far) ContentSource implementation — "路线B" from
// docs/DESIGN.md: the author logs into their own public-account admin
// backend, and this only ever queries that logged-in account's own fakeid —
// never a search across other accounts. That boundary is the whole reason
// this project exists instead of just wrapping an existing scraper.
//
// This is a skeleton: the overall data flow is settled (copied from
// zhi-dang's LoginContentSource), but the interface paths, parameters, and
// response fields are all marked TODO — they come from public reverse-
// engineering write-ups of other projects, undocumented and unverified
// against this project's own account, and will need a real capture session
// before they can be trusted. See docs/DESIGN.md for the full list of open
// questions.
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

// ---- Listing endpoint shape — everything below is unverified ----
// Best guess, assembled from third-party reverse-engineering write-ups, not
// captured from a real session:
//
//   GET https://mp.weixin.qq.com/cgi-bin/appmsgpublish
//       ?sub=list&search_field=null&begin=<offset>&count=<pageSize>
//       &type=9&token=<token>&lang=zh_CN&f=json&ajax=1
//
// Response roughly { base_resp: { ret, err_msg }, publish_page: "<JSON string>" }
// — publish_page is itself an escaped JSON string that needs a second parse;
// each entry's publish_info field is a further nested JSON string. This
// "string containing a string containing a string" shape is common in these
// admin-backend endpoints, but the exact nesting here hasn't been confirmed.
interface RawPublishPage { base_resp?: { ret: number; err_msg: string }; publish_page?: string }
interface RawPublishInfo { appmsgex?: RawAppMsg[] }
interface RawAppMsg { title: string; link: string; create_time: number; update_time: number; cover_img: string; digest: string }

function buildListUrl(offset: number, pageSize: number, token: string) {
  const url = new URL("https://mp.weixin.qq.com/cgi-bin/appmsgpublish");
  url.searchParams.set("sub", "list");
  url.searchParams.set("search_field", "null");
  url.searchParams.set("begin", String(offset));
  url.searchParams.set("count", String(pageSize));
  url.searchParams.set("type", "9");
  url.searchParams.set("token", token);
  url.searchParams.set("lang", "zh_CN");
  url.searchParams.set("f", "json");
  url.searchParams.set("ajax", "1");
  return url.toString();
}

// TODO: confirm both JSON.parse layers against a real response, and figure
// out how to classify a non-zero base_resp.ret — known possibilities from
// other admin-backend tools: an expired session (needs re-login), plain rate
// limiting, and a risk-control challenge page. The last one in particular
// often isn't JSON at all — it's an HTML verification page — which this
// function doesn't detect yet; it'll currently just fail JSON.parse and
// surface as a generic parse error instead of a clear "you got challenged"
// message.
function parsePublishPage(body: string): { items: RawAppMsg[]; isEnd: boolean; totalCount: number } {
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
  // TODO: confirm the actual end-of-pagination condition — total_count
  // comparison vs. an empty publish_list — against an account whose article
  // count sits right on a page-size boundary; testing one or two pages
  // isn't enough to be sure either way generalizes.
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
    coverUrl: raw.cover_img || null,
  };
}

// TODO: placeholder desktop UA — unverified whether the public article page
// returns different (or less parseable) markup depending on UA, e.g. a
// mobile UA producing real content while a desktop UA gets redirected to an
// interstitial.
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class WeixinContentSource implements ContentSource {
  constructor(private session: WeixinSession, private fetchPage: WeixinPageFetcher, private delayMs = 1200) {}

  async listAll(onCount?: (n: number) => void) {
    const items: WeixinItem[] = [];
    const seen = new Set<string>();
    let offset = 0;
    // Deliberately conservative: the backend's own admin UI paginates in
    // small pages (5-20 at a time), and both a large page size and a tight
    // request cadence are more likely to trip rate limiting or a challenge
    // page. Worth tuning up once the real thresholds are known.
    const pageSize = 20;
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
    // TODO: this regex is a guess at where #js_content starts and ends, not
    // verified against real markup — nested </div>s inside the body would
    // truncate it early. The proper fix is a real HTML parser (e.g. pairing
    // turndown with linkedom/happy-dom) instead of betting on a string match.
    // Separately: a deleted, friends-only, or "environment abnormal"
    // article returns an interstitial page instead of the body, and that
    // case isn't detected here yet — it would currently either fail this
    // regex (raising the generic error below) or, worse, silently export
    // the interstitial's text as if it were the article.
    const match = /<div[^>]*id="js_content"[^>]*>([\s\S]*?)<\/div>\s*(?:<script|<\/div>\s*<div id="js_sg_bar")/i.exec(html);
    if (!match) throw new Error("未能在文章页面中找到正文（可能页面结构已变化，或文章已被删除/仅限特定读者可见）。");
    return match[1];
  }
}
