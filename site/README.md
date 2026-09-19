# site/ — 微档落地页

「微档」介绍页的静态源文件。**不是微档应用的一部分**，也不参与
`npm test` / `npm run build`。网站托管、域名、DNS 不属于微档——这里只是暂居，
最终应搬到个人站自己的仓库（参考知档 `site/` 的同类安排）。

## 内容

| 文件 | 说明 |
|---|---|
| `index.html` | 单页，内联 CSS + 一小段 JS，无构建步骤，无第三方脚本，无统计代码；`<head>` 里有 canonical/OG/Twitter 卡片/JSON-LD，全部指向 `yingfeng.ca/wei-dang` |
| `assets/app-icon.png` | 从 `../src-tauri/icons/128x128@2x.png` 复制 |
| `robots.txt` | 允许全部抓取，指向 `sitemap.xml` |
| `sitemap.xml` | 只有首页这一条 URL，用的是 canonical 地址 `yingfeng.ca/wei-dang` |
| `wrangler.jsonc` | Cloudflare Workers 静态资源托管配置（assets-only，无 Worker 脚本） |
| `.assetsignore` | 把配置文件本身排除在上传的静态资源之外 |

`index.html` 里的一段 JS 只做一件事：调用 GitHub 公开 API 取最新 release 的版本号和
`.dmg` 下载地址。失败时页面里的静态链接（指向 `releases/latest`）已经是对的。

目前没有界面截图——微档只有一个版本，不需要像知档那样对比两版；等有合适的真实截图
（比如登录界面、导出完成界面）可以仿照知档 `site/README.md` 里"更新截图"那一节的做法
补上「怎么用」这几步的配图。

## 本地预览

```bash
python3 -m http.server -d site 8000
```

打开 <http://localhost:8000>。

## 部署（Cloudflare Workers 静态资源）

Cloudflare Dashboard → Workers & Pages → **Create application** → **Import a repository**
→ 选 `zhangyingfeng/wei-dang`：

| 设置 | 值 |
|---|---|
| 路径 / Root directory | `site` |
| 构建命令 / Build command | 留空 |
| 部署命令 / Deploy command | `npx wrangler deploy` |
| 非生产分支部署命令 | `npx wrangler versions upload`（默认，保留） |

首次部署后，进这个 Worker → **Settings → Domains & Routes → Add → Custom domain**
→ `wei-dang.yingfeng.ca`（和知档的 `zhi-dang.yingfeng.ca` 对应）。DNS 在 Cloudflare，
会自动建 CNAME 并签证书。**这个子域名只是 Cloudflare Custom Domain 机制要求的内部落地
地址，不对外发布、不出现在任何文档或页面的链接里**——对外统一用下面的子路径地址。

之后每次 push 到 `main` 自动重新部署。本地用 `npx wrangler dev` 或上面的
`http.server` 预览。

### 对外地址：`yingfeng.ca/wei-dang`

`yingfeng.ca` zone → **Rules → Redirect Rules → Create**：

- 匹配：`(http.host eq "yingfeng.ca" and starts_with(http.request.uri.path, "/wei-dang"))`
- 动态重定向到：`concat("https://wei-dang.yingfeng.ca", substring(http.request.uri.path, 9))`
- 301，保留查询字符串

`substring` 的偏移量 9 不用跟着改——`/wei-dang` 和 `/zhi-dang` 长度刚好一样，跟知档那条规则的写法完全对应，只是换了路径和目标域名。

文档、README、GitHub 仓库的 homepage 字段等所有对外展示的链接，一律写 `yingfeng.ca/wei-dang`；
`wei-dang.yingfeng.ca` 只在这份部署说明里，作为配置 Custom Domain 时要填的值出现。

## 更新图标

```bash
cp src-tauri/icons/128x128@2x.png site/assets/app-icon.png
```

文案改动时，与 `README.md` / `docs/PRIVACY.md` / `docs/DESIGN.md` 保持一致。
