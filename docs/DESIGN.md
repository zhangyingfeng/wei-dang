# 技术方案设计

记录微档技术路线的选择过程，避免以后忘记"为什么不用另一条路"。

## 产品边界

和知档一致：只导出当前登录账号本人已经发布过的内容，不搜索、不抓取任何其他公众号；不绕过验证码；不经过开发者的服务器。这条边界排除了几条网上常见的方案（见下）。

## 调研过的方案，以及为什么选了路线B

| 方案 | 能否满足"只导出自己账号" | 采纳与否 |
|---|---|---|
| 搜狗微信搜索 | 是（可以只搜自己），但覆盖率太低（只有最近约10篇），没有阅读数据 | 否——数据不够完整 |
| 网页版微信被动接收推送 | 是 | 否——网页版微信新号已登不进，方案本身已经过时 |
| **公众号后台登录 + 自己的 token/cookie/fakeid**（路线B） | 是——只查自己的 fakeid，不搜别的账号 | **采纳** |
| 手机中间人抓包（mitmproxy/anyproxy） | 是 | 否——需要一台常年在线的实体手机做代理，运维成本和"轻量桌面应用"的定位不符 |
| DLL Hook 逆向 PC 客户端 | 是 | 否——技术门槛和维护成本最高，个人项目难以长期维护 |
| 官方开发接口 `freepublish/batchget` | 是，且最"干净" | 否——**只能拿到未群发通知的文章，已经群发推送给读者看过的文章拿不到**，覆盖率太低，见微信开放社区的讨论 |
| 搜索其他公众号（wechat-article-exporter 曾经用的路线） | 否——本来就是抓别人的号 | 否——既不符合边界，2026年7月也已经被微信官方关闭 |

路线B的核心操作：作者本人登录 `mp.weixin.qq.com` 后台，从地址栏/请求头里拿到 `token` + cookie，用这个会话去调用后台"内容管理"用的接口，但**只查询登录账号自己的 fakeid**，不去搜索/查询其他公众号——对应 `wechat-download-api`、`we-mp-rss`、`WechatOAApis` 这几个开源项目的做法。

## 已用真实账号验证过（2026-09-17）

用内置浏览器登录了一个真实公众号后台（27 篇已发表文章），核对了 `src/source/weixin.ts` 里当时标的每一处 TODO。发现了几个会导致**静默产出空归档**或**正文被截断**的真实 bug，已经修：

- **列表接口的 `type` 参数是错的**：旧代码猜的 `type=9` 会让接口返回 `ret:0`（成功）但 `publish_list` 是空数组——`listAll()` 会把这个当成"已到末页"直接结束，不报任何错，产出一个空归档。真实参数是 `type=101_1_102_103`，还需要 `sub_action=list_ex`、`free_publish_type=1_102_103`，不需要 `search_field`。管理页面自己发的请求还带一个 `fingerprint` 参数，但测试发现后端不校验这个值（省略或传垃圾值都成功），所以没有实现指纹生成。
- **响应里封面字段是 `cover`，不是 `cover_img`**——旧代码读错字段名，导出的 `coverUrl` 一直是 null。
- 两层 `JSON.parse`（`publish_page` → `publish_list[].publish_info` → `appmsgex[]`）的嵌套结构确认无误，`title`/`link`/`create_time`/`update_time`/`digest` 字段名也都对。
- 翻页终止条件确认：`total_count` 在同一账号的请求间保持不变，`begin >= total_count` 时 `publish_list` 为空——两种判断方式都可靠。管理页面自己用的分页大小是 10，已经把代码里的 20 改成 10。
- **正文提取的正则会截断真实文章**：`#js_content` 内部经常有自己的嵌套 `<div>`（视频播放器、图片容器等），"找下一个 `</div>`" 的正则遇到这种情况会在第一个嵌套 `<div>` 结束时就停——用一篇视频文章实测，正文从 221,836 字符被截到 185 字符。已经换成按深度计数找真正匹配的闭合标签（`extractJsContent`，见 [weixin.ts](../src/source/weixin.ts)）。
- **被作者自己删除的文章**：公开页面仍返回 HTTP 200，但没有 `#js_content`，页面里有"该内容已被发布者删除"这样的文案。之前会被当成正则匹配失败，报一个无关的通用错误；现在会检测这个文案，报一个准确的"文章已删除"错误。
- 正文页面确实不需要登录态（`fetch` 不带任何 cookie 也能拿到完整正文），桌面 UA 下渲染正常。

## 还没验证的部分

- 触发风控/频控时，响应体大概率不是 JSON 而是一段验证码 HTML 页面——这次抓包会话没有真的触发风控，`parsePublishPage` 对非 `ret:0` 响应的分类（登录过期 vs 频控 vs 风控挑战）还是猜测，没有真实样本。
- token/cookie 的有效期未知，过期后需要一个清晰的"重新登录"提示路径，还没做。
- 图片懒加载属性（`data-src`）、下载时需要的 `Referer` 头，还没有拿真实公众号文章验证过。
- "仅限特定读者可见"/"环境异常" 这类拦截页面还没实际遇到过，目前只有"已删除"这一种拦截情形有专门的错误提示。
- `appmsgpublish` 接口本身不带阅读数/点赞数/评论数——后台"发表记录"页面上能看到这些数据，但应该来自另一个单独的统计接口，这次没有顺手抓到，`readCount`/`likeCount`/`commentCount` 目前仍然是有意留空。
- 这条链路依赖真实公众号 + 手动扫码登录，纯离线单元测试覆盖不到网络层——但 `buildListUrl`/`parsePublishPage`/`extractJsContent` 这几个纯函数已经用从真实响应里提炼出的样例数据加了单元测试（见 `test/weixin.test.ts`），能防止这次修好的问题再次回归。

## 目前代码里已经做完、可以直接信任的部分

- `src/types.ts`、`src/util.ts`：从知档迁移或轻改的通用类型和工具函数，和公众号无关，可信度等同于知档本身。
- `src/exporter.ts`：从知档的 `Exporter` 迁移，去掉了知乎特有的"回答/文章"两分类和字段命名，改成统一的"文章"，逻辑（Markdown 转换、图片本地化去重、Word 导出、断点续传落盘）没有变。
- `src/source/types.ts`：`ContentSource` 接口，和知档的形状一致，`QuotaExhaustedError` 换成了语义更贴切的 `SessionExpiredError`（登录态失效，而不是配额用完）。

## 登录窗口 + Tauri 壳子（2026-09-17）

参考知档 `src-tauri/src/lib.rs` 的登录窗口机制，把 `server.ts`/`index.ts`/Tauri 壳子迁移了过来，`npm run tauri dev` 已经能跑起来。和知乎版本的关键区别：

- **登录检测方式不同**。知乎版靠轮询 `/api/v4/me` 接口判断是否登录；公众号没有等价接口，改成读登录窗口当前 URL 里的 `token` 查询参数（只在 URL 匹配 `mp.weixin.qq.com/cgi-bin/home` 时才提取，见 `lib.rs` 的 `current_token`），对应扫码登录成功后地址栏跳到后台首页、带上 `token=` 的那一刻。
- 微档只有一种登录方式，没有知档的"登录版/密钥版"分支——`Cargo.toml`、`lib.rs`、`server.ts` 都比知档对应文件简单，没有知档那套 `ServerOptions`/`#[cfg(feature = "key")]` 抽象。
- **验证方式**：`cargo check`、`cargo build`、`tauri build --debug` 都编译通过；用 `tauri build --debug` 产出的 `.app` 实际启动过一次，主窗口（Express 服务的真实页面）渲染正常，"开始登录"按钮、页脚文案都对；受当时的截图工具限制没能截到登录窗口本身渲染 mp.weixin.qq.com 二维码的画面，但地址/加载逻辑和之前用内置浏览器手动验证过的登录流程一致。**没有做过一次真正的扫码登录到导出完成的端到端测试**——这需要真实账号 + 手机扫码，留给下一步。
- **release 打包还没搭**：`tauri.conf.json` 里没有 `externalBin`/`beforeBuildCommand`，`create_main_window` 目前不管 debug/release 都固定指向 `http://127.0.0.1:4417`，也就是说只有 `npm run tauri dev`（连同 `npm run dev` 一起跑）能真正工作；`tauri build` 产出的正式 `.app` 会打开一个连不上任何服务器的空窗口，因为没有知档那样把 Express 编译成 sidecar 二进制一起打包。这是有意暂缓的——先把开发态跑通，打包/签名是后续独立的工作。
- 图标是占位符（`src-tauri/icons/`，一个用脚本生成的绿色"档"字方块），不是正式视觉设计。

## 下一步

1. ~~找一个真实公众号，手动登录后台抓包，核对 `src/source/weixin.ts` 里的每一处 TODO。~~ 已完成（2026-09-17），见上面"已用真实账号验证过"。
2. 补上验证码/风控页面的识别和清晰的错误提示——需要真的触发一次风控才能核实响应形状，这次抓包会话没遇到。
3. ~~参考知档 `src-tauri/src/lib.rs` 的登录窗口机制，做一个指向 `mp.weixin.qq.com` 的对应实现。~~ 已完成（2026-09-17），见上面"登录窗口 + Tauri 壳子"。
4. **真正跑一次端到端**：`npm run tauri dev`，点"开始登录"，手机扫码登录一个真实公众号，确认 `wait_for_login` 能正确从 URL 里拿到 token、`weixin_fetch` relay 能让 `WeixinContentSource.listAll` 真的把内容管理页的接口打通，一路导出到本地 Markdown/Word。这是唯一还没做过的、决定这条链路能不能用的测试。
5. 打包发布：把 Express 编译成 sidecar 二进制（参考知档 `scripts/build-sidecar.sh`），补上 `externalBin`/`beforeBuildCommand`，让 `tauri build` 产出真正能独立运行的 `.app`；换一版正式图标。
