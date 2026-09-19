# site/ — 微档落地页

「微档」介绍页的静态源文件。**不是微档应用的一部分**，也不参与
`npm test` / `npm run build`。网站托管、域名、DNS 不属于微档——这里只是暂居，
最终应搬到个人站自己的仓库（参考知档 `site/` 的同类安排）。

## 内容

| 文件 | 说明 |
|---|---|
| `index.html` | 单页，内联 CSS + 一小段 JS，无构建步骤，无第三方脚本，无统计代码 |
| `assets/app-icon.png` | 从 `../src-tauri/icons/128x128@2x.png` 复制 |
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

## 部署（Cloudflare Workers 静态资源 + 子域名）

Cloudflare Dashboard → Workers & Pages → **Create application** → **Import a repository**
→ 选 `zhangyingfeng/wei-dang`：

| 设置 | 值 |
|---|---|
| 路径 / Root directory | `site` |
| 构建命令 / Build command | 留空 |
| 部署命令 / Deploy command | `npx wrangler deploy` |
| 非生产分支部署命令 | `npx wrangler versions upload`（默认，保留） |

首次部署后，进这个 Worker → **Settings → Domains & Routes → Add → Custom domain**
→ 选一个子域名（知档用的是 `zhi-dang.yingfeng.ca`，微档可以对应用 `wei-dang.yingfeng.ca`）。
DNS 在 Cloudflare，会自动建 CNAME 并签证书。

之后每次 push 到 `main` 自动重新部署。本地用 `npx wrangler dev` 或上面的
`http.server` 预览。

## 更新图标

```bash
cp src-tauri/icons/128x128@2x.png site/assets/app-icon.png
```

文案改动时，与 `README.md` / `docs/PRIVACY.md` / `docs/DESIGN.md` 保持一致。
