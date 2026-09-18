// Image handling for public article pages (mp.weixin.qq.com/s/...) — the
// counterpart to zhi-dang's src/zhihu.ts downloadImage/normalizeImageSources,
// but for WeChat's markup and CDN instead of Zhihu's.
//
// TODO: everything in this file is a best guess, not verified against a real
// article page. WeChat's article body lazy-loads images with the real URL in
// data-src (this is the commonly documented attribute; unlike Zhihu there's
// no confirmed second fallback attribute or <noscript> duplicate, but that
// hasn't been checked against live HTML either).
export function normalizeImageSources(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const get = (name: string) => new RegExp(`\\s${name}=["']([^"']+)["']`, "i").exec(tag)?.[1];
    const source = get("data-src") || get("src");
    if (!source || source.startsWith("data:")) return "";
    let clean = tag.replace(/\sdata-src=["'][^"']*["']/gi, "");
    if (/\ssrc=["']/i.test(clean)) clean = clean.replace(/\ssrc=["'][^"']*["']/i, ` src="${source}"`);
    else clean = clean.replace(/^<img/i, `<img src="${source}"`);
    return clean;
  });
}

// Pulls each <img>'s real `src` attribute value out of already-normalized
// html. The \s before "src=" is load-bearing: WeChat articles imported from
// elsewhere (e.g. cross-posted from Zhihu) carry extra attributes like
// data-actualsrc alongside the real src — a bare "src=" substring match
// (no leading-whitespace anchor) reads that as a match too, and since it
// sorts later in the tag, a greedy [^>]+ before it grabs THAT value instead
// of the real src. That real src (the one turndown/final markdown actually
// uses) then never gets localized/downloaded — confirmed against a real
// 2015 article that cross-posted from Zhihu this way, where it silently
// left the true WeChat CDN URL un-downloaded and, because that URL has no
// file extension (WeChat encodes format in a "?wx_fmt=" query param, not a
// path extension), later broke Word-doc image embedding downstream.
export function extractImageUrls(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]!);
}

// TODO: unverified whether mmbiz.qpic.cn actually enforces a Referer check
// the way Zhihu's image CDN does — sending it defensively since it can't
// hurt, but it may turn out to be unnecessary.
export async function downloadImage(url: string) {
  const response = await fetch(url, { headers: { referer: "https://mp.weixin.qq.com/" } });
  if (!response.ok) throw new Error(`图片下载失败 ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  return { body, contentType };
}
