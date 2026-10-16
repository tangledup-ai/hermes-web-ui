# 浏览器接入：业界与开源方案调研

日期：2026-10-15
用途：在实现 `docs/web-agent-browser/` 这套 spec 之前，用外部证据交叉验证我们的设计决策，
并暴露需要重新确认的分歧点。

> **证据分级**（请勿把 [二手] 当结论用）
> - **[实测]** 在本机/本仓库直接观测到的行为。
> - **[一手]** 厂商官方文档、官方博客、官方仓库页面。
> - **[二手]** 技术博客/百科/社区文章转述，**仅用于定位线索**。
> - **[未验证]** 因网络限制未能取得一手证据。

> **网络限制声明**：本次 `github.com` 与 `raw.githubusercontent.com` 请求全部超时，
> `npmjs.com` 返回 403。因此**未能直接读取 browser-use / agent-browser / playwright-mcp /
> chrome-devtools-mcp 的仓库源码与 README 正文**。这些项目的细节仅到 [二手] 级，需补验。
> 已取得一手证据：Chrome 官方博客、Browserbase 官方文档、Hermes Agent 官方设计文档、
> ZCode 官网与 gitcode 仓库页、以及本机实测的 CodeBuddy 预览行为。

---

## 一、结论摘要

**1. 业界有两条互斥路线，中文产品大多选了 B，我们与同族的 Hermes Agent 选了 A。**

| 路线 | 控制对象 | 代表 | 需服务端浏览器 |
|---|---|---|---|
| **A. CDP 直连无头/云端浏览器** | 自己起的浏览器 | browser-use、agent-browser、Browserbase、**Hermes Agent 官方**、Playwright MCP、Chrome DevTools MCP | 需要 |
| **B. 浏览器扩展控制用户真实浏览器** | 用户自己的浏览器 | Qwen BrowserQwen、Claude for Chrome、**腾讯 Marvis**、mcp-chrome、playwriter | 不需要 |

**2. 我们的三项核心设计都被业界独立采用，没有一项是我们发明的：**

| 我们的设计 | 业界同款 | 证据 |
|---|---|---|
| CDP 直连、不经 Playwright 封装 | agent-browser（Rust 直连 CDP，Node 仅 wrapper）；Hermes Agent 直接持有 CDP 连接 | [二手]/[一手] |
| 无障碍树快照 + 短命元素引用 `@eN` | agent-browser 招牌设计、Playwright MCP、browser-use、Hermes Agent `browser_snapshot` | [二手]/[一手] |
| 每 tab 独立会话 + 租约/接管 | Browserbase per-page live view、Hermes Agent per-task supervisor | [一手] |

**3. 反面证据**：OpenAI 自研 AI 浏览器 **ChatGPT Atlas 已关停**（2026-07-09 宣布、8-09 停服，[二手]）。
业界回到"扩展 + 已有浏览器"或"云端浏览器 + 面板"。→ **不要做浏览器，做面板。**

**4. 两个需要拍板的分歧点**（见第五节）：画面用 **iframe** 还是 **自绘 canvas**；
CDP screencast 的帧率在"用户手动接管"场景可能不够流畅。

---

## 二、产品矩阵

| 产品 | 接入方式 | 可见性 | 证据等级 |
|---|---|---|---|
| **腾讯 Marvis** | **浏览器扩展**（默认适配 Chrome，另发 Edge 专属插件，`static.marvis.qq.com/plugin...`） | 用户真实浏览器，天然可见 | [二手] CSDN/博客园/百度百科 |
| **阿里 Qwen** | **Chrome 扩展 BrowserQwen**（`chrome://extensions` 加载解压目录）+ Qwen-Agent 框架原生支持 MCP | 用户真实浏览器 | [一手] 仓库自述 + 安装文档标题 |
| **Anthropic Claude** | **Chrome 扩展 Claude for Chrome**（2025-08-26 限量预览）+ 双层权限（客户端 prompt + 扩展按域名授权） | 用户真实浏览器 | [二手] 媒体/百科 |
| **CodeBuddy** | **Electron webview 顶层导航**（非 iframe） | IDE 面板内可见 | **[实测]** 见 §2.1 |
| **智谱 ZCode** | 桌面应用 + 浏览器界面 + 终端 Agent，**共享一份 Agent 运行时**；Apache-2.0 开源 | — | [一手] 官网 + gitcode 仓库页 |
| **OpenAI ChatGPT Agent / Operator** | **云端浏览器**，且用两个浏览器（文本推理用 + 图形界面用），CUA 视觉模型 | 云端，Operator 支持接管 | [二手] |
| **OpenAI ChatGPT Atlas** | **已关停**（2026-07-09 宣布、8-09 停服） | — | [二手] |

### 2.1 CodeBuddy 预览面板 [实测]

本机实测请求指纹（临时探针服务接收）：

```
{"method":"GET","url":"/","secFetchDest":"document","secFetchMode":"navigate",
 "secFetchSite":"none",
 "ua":"... CodeBuddyCN/1.106.1 Chrome/138.0.7204.251 Electron/37.7.0 Safari/537.36"}
```

`sec-fetch-dest: document` + `sec-fetch-mode: navigate` + `sec-fetch-site: none` + 无 `Referer`
→ **顶层文档导航，不是 iframe 嵌套**；宿主是 Electron 应用。

**判定**：CodeBuddy 预览 = 路线 A 的 Electron 变体（与 Hermes 桌面端同源能力），
**无对外控制面**，因此不能被外部程序驱动，也不能被嵌入到别的页面里。

---

## 三、开源矩阵

| 项目 | 控制方式 | 可见性 | 证据等级 |
|---|---|---|---|
| **agent-browser**（Vercel Labs，本项目已在用 `^0.26.0`） | Rust 原生二进制，**CDP 直连**，Node 仅跨平台 wrapper；约 36k 行 Rust；多会话隔离 | headless | [二手] 多篇技术解析一致 |
| **browser-use** | 本地运行，CDP 控制浏览器；可接 Browserbase | 有 live view | [二手] |
| **microsoft/playwright-mcp** | stdio；可连现有浏览器 | headed 模式存在 | **[未验证]** GitHub 超时 |
| **ChromeDevTools/chrome-devtools-mcp**（Google 官方） | 四种：专用 profile（默认）/ 远程调试端口 / 临时 profile / **`--autoConnect` 连活跃 Chrome**（M144+） | 用户真实 Chrome | [一手] Chrome 官方博客 |
| **Browserbase Live View** | **iframe 嵌入 live view URL** | 云端，支持接管 | [一手] 官方文档 |
| **Hermes Agent Browser CDP Supervisor**（同族官方） | 每 task 一个 asyncio task + **到 CDP 端点的持久 WebSocket** | **明确不做用户实时画面** | [一手] 官方设计文档 |
| **neko / KasmVNC** | WebRTC/WebSocket + H.264 硬件编码（1080P <100ms） | 完整远程桌面 | [二手] |

---

## 四、最相关的一份：Hermes Agent 官方 Browser CDP Supervisor [一手]

来源：`hermes-agent.nousresearch.com/docs/zh-Hans/developer-guide/browser-supervisor`
（PR 14540，2026-04-23，作者 @teknium1）。**与本项目同族**，因此这是最高价值的对照物。

### 4.1 它做了什么

- 每个 `task_id` 一个**后台 asyncio.Task**，持有**到后端 CDP 端点的持久 WebSocket 连接**。
- 订阅的域：`Page.enable`（对话框/框架事件）、`Runtime.enable`（console/异常）、
  `Target.setAutoAttach {autoAttach:true, flatten:true}`（暴露 OOPIF 子 target）。
- 维护四个数据结构：对话框队列、框架树、会话映射（`session_id` → 会话，用于路由 OOPIF 操作）、
  最近 50 条控制台错误环形缓冲。
- 线程安全靠**快照锁**：后台线程写，Agent 侧工具调用**同步读冻结快照**。
- 生命周期：`get_or_start(task_id, cdp_url)` 幂等；**CDP URL 变更时停止旧 supervisor 并重启，
  绝不跨端点复用状态**。
- 新增工具 `browser_dialog(action, prompt_text, dialog_id)`；
  `browser_cdp(frame_id=...)` 作为长尾逃生舱口（cookies、viewport、网络限速）。

### 4.2 它明确不做什么（对我们至关重要）

> **非目标**：向用户实时流式传输对话框/框架事件（需要 gateway 钩子）

也就是说：**官方 Agent 侧的浏览器能力不做"用户可见画面"，也不做人工接管**。
它解决的是"对话框阻塞 JS 线程"与"跨域 iframe 不可见"两个能力缺口，不是可见性问题。

### 4.3 它的后端支持矩阵

| 后端 | 对话框检测 | 对话框响应 | 框架树 | OOPIF `Runtime.evaluate` |
|---|---|---|---|---|
| 本地 Chrome（`--remote-debugging-port`）/ `/browser connect` | ✓ | ✓ | ✓ | ✓ |
| Browserbase | ✓（经 bridge） | ✓（经 bridge） | ✓ | ✓ |
| Camofox | ✗（无 CDP，仅 REST） | ✗ | 部分 | ✗ |

### 4.4 从它身上学到的两条实质经验

1. **Browserbase 的 CDP 代理内部用 Playwright，并在约 10ms 内自动关闭原生对话框**，
   导致 `Page.handleJavaScriptDialog` 跟不上。官方的绕行方案是：
   `Page.addScriptToEvaluateOnNewDocument` 注入 bridge 脚本，把 `alert/confirm/prompt`
   改写成发往魔法主机 `hermes-dialog-bridge.invalid` 的**同步 XHR**，再用 `Fetch.enable`
   拦截这些 XHR（变成 `Fetch.requestPaused`），`Fetch.fulfillRequest` 回 JSON 完成对话框。
   → **教训：谁在中间封装了 Playwright，谁就会改变原生语义。** 我们的 D1（不用 Playwright）
   恰好避开这一类坑。
2. **`/browser connect` 证明官方有"连接到已存在浏览器"的机制**。我们的 runtime 若不显式对齐，
   会与它各起一个 Chrome；需要在 spec 里写明"不共享实例"。

---

## 五、与我们 spec 的逐条对照

| 我们的 spec 决策 | 业界对照 | 判定 |
|---|---|---|
| D1 自持 CDP，不用 Playwright/Puppeteer | agent-browser 同样直连 CDP；Hermes Agent 官方同样自持连接 | **✓ 被验证** |
| spec-02 `--remote-debugging-pipe`（不开端口） | 业界普遍用端口（`--remote-debugging-port` / `--autoConnect`）或 CDP WS；pipe 少见但 puppeteer 在用 | **⚠ 更严格，无人背书**：需确认 pipe 在 Windows 上的稳定性，并保留端口回退（spec-02 已写） |
| spec-04 无障碍树 + `@eN` 引用 | agent-browser / Playwright MCP / browser-use / Hermes Agent 全部采用 | **✓ 被验证** |
| spec-05 每 tab 租约 + 接管 | Browserbase per-page live view；Hermes Agent per-task supervisor + 生成号作废 | **✓ 被验证** |
| spec-06 CDP `Page.startScreencast` + ack 门控 | 无一手证据表明 Browserbase 用 screencast（官方文档未披露传输层） | **⚠ 无同行背书，但技术上是 CDP 原生能力** |
| spec-06 帧率上限 10fps、JPEG quality 60 | KasmVNC/neko 走 WebRTC+H.264，1080P <100ms | **⚠ 我们的方案在"用户手动接管"时体验会明显更差** |
| spec-07 自绘 canvas，不用 iframe | **Browserbase 用 iframe**：`<iframe src="{liveViewLink}" sandbox="allow-same-origin allow-scripts">`，只读靠 `pointer-events:none`，断开靠 `postMessage` | **✗ 与最成熟方案分歧**，见 §6.1 |
| spec-09 不改全局 CSP | 同源 iframe 走 `default-src 'self'` 本就允许；难点是**被嵌页面自身**的 `frame-ancestors` | 需按 §6.1 结论调整措辞 |
| spec-09 权限默认拒绝 | Chrome 官方对 `--autoConnect` 设三道闸：默认禁用、**每次请求弹窗授权**、会话期间显示"Chrome 正受到自动测试软件的控制"横幅 | **⚠ 我们缺"可见指示"这一条** |

### 5.1 Browserbase 的两个可借鉴细节 [一手]

- **每 tab 一个 live view URL**：`bb.sessions.debug(session.id)` 返回 `pages` 数组，
  新标签页通过 Playwright 的 new-tab 事件补取 URL。
- **只读 / 读写切换只需一行 CSS**：读写版去掉 `style="pointer-events: none;"` 即可。
  → 我们 spec-08 的状态机（`idle` / `agent-active` / `taking-over`）可以用同样的轻量手法表达。
- 移动端不支持软键盘，需自行转发按键（`page.keyboard.press()`）——与我们对 IME 的处理是同类问题。

---

## 六、建议的 spec 修订

### 6.1 spec-07：iframe 与 canvas 的取舍必须显式化（**需你拍板**）

两种都可行，但代价不同：

| 方案 | 实现 | CSP 影响 | 优势 | 代价 |
|---|---|---|---|---|
| **A. 自绘 canvas**（当前 spec） | Vue 组件 + Socket.IO 帧 + 自写输入层 | **零改动** | 完全可控、与面板 DOM 无隔离问题 | 渲染/输入/DPI 全要自己实现（spec-08 的坐标换算是最大坑） |
| **B. 同源 iframe 承载 live 页**（Browserbase 形态） | `/api/browser/live/<ticket>` 返回独立 HTML 页，页内自连 Socket.IO | 该路径需单独返回 `frame-ancestors 'self'`（**逐路径例外，照 `dsh/ui-gateway.ts:152` 的既有做法**）；主应用侧无需改（`frame-src` 未声明 → `default-src 'self'` 允许同源帧） | 只读/读写切换一行 CSS；输入层天然隔离 | 多一个页面入口 + 一条 CSP 例外 + ticket 鉴权 |

**我的建议**：先按 **A** 做 P3（因为 P3 只需要"看得见"，不需要输入），
到 **P4（输入与接管）时再评估是否切到 B** —— 因为 B 在"输入层隔离 + 只读/读写切换"上的收益
恰好是 P4 才需要的。若届时切 B，spec-09 需增加一条"D1 之外唯一的 CSP 例外"并说明理由。

### 6.2 spec-06：把"流畅度上限"写成已知取舍

当前 10fps JPEG 对"看 Agent 操作"足够，但 P4 让用户手动接管时体验会明显弱于远程桌面流。
**建议在 spec-06 增加一条**：把 WebRTC/H.264（neko / KasmVNC 类）列为**显式后续选项**，
并写清触发条件（若实测接管体验不可接受）。

### 6.3 spec-09：补"可见指示"并记录路线 B 的闸门设计

- 补一条：面板需有明确的"Agent 正在控制"可见指示（我们在 spec-07 acceptance 12 已有，
  但 spec-09 的安全清单里应同步登记，形成"浏览器被自动化时必须对用户可见"的规则）。
- 记录 Chrome 官方对 `--autoConnect` 的三道闸（默认禁用 / 每次弹窗 / 可见横幅），
  作为"若要支持控制用户已有浏览器"时的必备设计。

### 6.4 spec-05：写明与 Hermes Agent `browser connect` 的实例边界

我们的 runtime 与 Hermes Agent 官方的 `/browser connect` **不共享 Chrome 实例**，
除非显式配置指向同一 CDP 端点。descriptor 只服务本机 MCP 发现，不等于共享浏览器。

---

## 七、需要你确认的清单（开发前）

1. **画面承载**：先 A（canvas）后评估 B（iframe），还是直接上 B？→ §6.1
2. **接管流畅度**：接受 CDP screencast 的帧率上限，还是把 WebRTC 流式列为 P4 的硬需求？
3. **是否要支持"操作用户已有浏览器（保留登录态）"**：这是路线 B（Qwen/Claude/Marvis 的选择）。
   若要，它应作为**独立特性**设计（扩展 + 权限闸门），而不是塞进当前 spec。
4. **pipe 的 Windows 稳定性**：是否接受先 pipe、失败则回退 loopback 端口（spec-02 已如此设计）？
5. **是否需要补验**：browser-use / agent-browser / playwright-mcp 的源码级细节（本次网络受限未能读）。

---

## 八、来源

**一手**
- Hermes Agent 官方：《Browser CDP Supervisor — 设计文档》
  https://hermes-agent.nousresearch.com/docs/zh-Hans/developer-guide/browser-supervisor
- Browserbase 官方：《Session live view》
  https://docs.browserbase.com/platform/browser/observability/session-live-view
- Chrome 官方博客：《让编码智能体使用 Chrome DevTools MCP 调试您的浏览器会话》
  https://developer.chrome.google.cn/blog/chrome-devtools-mcp-debug-your-browser-session
- ZCode 官网 https://zcode.z.ai/ ；仓库页 https://gitcode.com/zai-org/ZCode （Apache-2.0，镜像）
- Qwen-Agent 仓库自述与 `browser_qwen_cn.md`（经搜索摘要引用的仓库页面）
- 本机实测：CodeBuddy 预览请求指纹（§2.1）

**二手（仅供定位，不作结论）**
- 腾讯 Marvis：CSDN / 博客园 / 51CTO 的插件安装教程、百度百科词条
- Claude for Chrome：媒体报道与百科
- ChatGPT Atlas 关停、ChatGPT Agent 双浏览器架构、Operator CUA：腾讯云社区 / 百科 / CSDN
- agent-browser（Rust + CDP + 无障碍树）、browser-use、KasmVNC/neko 性能：CSDN / 知乎 / 技术博客
- "Claude Code 操作 Chrome 的技术内幕"（L1 CDP → L2 库 → L3 MCP → L4 扩展 → L5 像素）层次划分

**未验证（网络受限）**
- ~~`github.com/...` 的源码与 README 正文~~ → 见第九节，部分已通过 jsDelivr 补验

---

## 九、补验（第二轮，2026-10-15）

**绕道方式**：`github.com` / `raw.githubusercontent.com` 仍超时，但
**`cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>` 可用**，借此拿到多份一手 README。
`agent-browser` 的内容文件在 jsDelivr 上取不到，但**其官方文档站 `agent-browser.dev` 可访问**（一手）。

### 9.1 ⚠️ 重大发现：agent-browser **已内置**我们要做的画面流与面板 [一手]

来源：`https://agent-browser.dev/streaming`、`https://agent-browser.dev/dashboard`

**Streaming**（原句）：

> "Stream the browser viewport via WebSocket for live preview or **'pair browsing' where a human can
> watch and interact alongside an AI agent**."
> "**Every session automatically starts a WebSocket stream server on an OS-assigned port.**
> The server streams viewport frames and accepts input events (mouse, keyboard, touch)."

我们 spec-06 / spec-08 的每一项，它都已经实现并文档化：

| 我们的 spec 设计 | agent-browser 既有实现 |
|---|---|
| CDP `Page.startScreencast` | ✓ "`screencast_start` / `screencast_stop` … **This mirrors how Chrome paces its own screencast upstream with `Page.screencastFrameAck`**" |
| 帧 metadata 字段（`deviceWidth/pageScaleFactor/scrollOffset*`） | ✓ `frame.metadata` **字段名完全一致** |
| ack 门控 | ✓ "最多一帧在途…`{"type":"ack","seq":41}`…**Acks are cumulative**" |
| 帧率节流 / 丢帧 | ✓ "holds only the newest frame and reads it at send time…**The application never builds a backlog**"；`config {"maxFps":10}`（1–120，per-client） |
| 输入转发（鼠标/键盘/滚轮/触摸） | ✓ `input_mouse` / `input_keyboard` / `input_touch`，`modifiers`：**"1=Alt, 2=Ctrl, 4=Meta, 8=Shift"** |
| 码率预算 | ✓ "1280x720, quality 80 ≈ **54 KB/frame**；quality 20 ≈ 25 KB；quality 20 @640x360 ≈ 9 KB" |
| **自绘 canvas 播放器** | ✓ Dashboard 的 live viewport 就是 **"Real-time JPEG frames from the browser, rendered to a canvas element"** |

**Dashboard**（原句）：

> "Monitor agent-browser sessions in real time with a **local web dashboard showing a live browser
> viewport and command activity feed**." / "**The dashboard is bundled into the binary** and requires
> no separate install." / `agent-browser dashboard start` → **`http://localhost:4848`**

**它的安全边界恰好卡在我们的部署形态上**（原句）：

> "Browser clients must load from **localhost, 127.0.0.1, ::1 or file://**. Any other origin
> gets a **403 on the upgrade and needs a proxy**."
> （Dashboard）"Local loopback origins are allowed automatically over IPv4 and IPv6 **without an
> access token**." / 外部 origin 需 `--allowed-origins`，并"reject cross-origin requests and
> **DNS-rebinding attacks**"，打印 **private tokenized access URL**（token 存 Secure、host-bound、
> same-site cookie）。

**结论（重要）**：我们的 P3/P4 **不需要自己发明协议**。既有现成能力是
"agent-browser 的视图流 + 输入回传 + 一个 canvas 面板"，我们真正需要补的是它**故意不做**的三件事：

1. **同源代理**：它硬性要求 origin ∈ {localhost, 127.0.0.1, ::1, file://}，
   **局域网访问的浏览器一律被 403** —— 这正好是我们的部署形态，必须由我们的服务端反代/转发。
2. **鉴权**：它 loopback 免 token，没有用户体系；我们要接自己的登录态。
3. **封装进我们的 UI**：它的 dashboard 是独立 Next.js 应用（`packages/dashboard/`，
   编译期用 `rust-embed` 嵌进二进制），不能直接当我们面板的一部分。

**风险**：项目锁定 `agent-browser@^0.26.0`，而文档站描述的是 latest（**0.39.1**，经 jsDelivr
版本清单确认，共 ~113 个版本）。**streaming / dashboard 是否在 0.26.0 就存在，未验证**，
这是采用该路线的第一个必查项。

### 9.2 Playwright MCP（微软官方）—— 四处可借鉴 [一手]

`cdn.jsdelivr.net/gh/microsoft/playwright-mcp@main/README.md`

- **官方自己承认 CLI 比 MCP 更省 token**："CLI invocations are more token-efficient: they avoid
  loading large tool schemas and verbose accessibility trees into the model context…MCP remains
  relevant for … persistent state, rich introspection, and iterative reasoning over page structure."
  → **印证本项目"Ekko 用 CLI 工具、Agent 用 MCP 类目入口"的双轨设计是对的。**
- **`browser_find`**：在快照里按文本/正则检索，只返回命中节点及其"从根到节点"的路径，
  "**cheaper than capturing the whole snapshot**" → 我们 spec-04 **没有这个省 token 机制，建议补**。
- **`element` 参数**："Human-readable element description used to obtain **permission to interact
  with the element**" → 印证 spec-09 的"高风险操作需确认"（我们目前标为已知差距）。
- **明确的安全免责**："Playwright MCP is **not a security boundary**"；
  `--allow-unrestricted-file-access` 是"a convenience defense…**not a secure boundary**"；
  `--allowed-origins` / `--blocked-origins` "**does not serve as a security boundary and does not
  affect redirects**" ← **直接印证 spec-04/09 的"重定向后必须复核"**。
- **`--allowed-hosts` 的用途是 DNS rebinding 防护**（"not for CORS, but rather for the
  **DNS rebinding protection**"）→ **spec-09 缺这条，建议补。**
- **持久 profile 只能被一个实例使用**："A persistent profile can only be used by **one browser
  instance at a time**, so concurrent MCP clients sharing the same workspace will conflict."
  → 印证 spec-03 用独立 browser context + spec-05 descriptor 独占的必要性。
- **`browser_run_code_unsafe`** 被明确标注 "**RCE-equivalent**" → 印证 spec-04 的
  "不接受任意 JS"是必要硬规则。
- **截图有 `scale` 概念**（`"css"` 默认 / `"device"`）与 `type: png|jpeg|webp`
  → spec-04 只定义了 png/jpeg，**缺少 `scale`，而它直接决定 spec-08 的坐标换算**。

### 9.3 browser-use —— 一处二手信息被证伪 [一手]

`cdn.jsdelivr.net/gh/browser-use/browser-use@main/README.md`

- 原文只声明 **CDP**："can control a local browser, a Browser Use Cloud browser, or an existing
  remote browser **over CDP**"。
- **README 未出现 Playwright，也未出现"DOM 索引/像素坐标/无障碍树"** →
  本文档 §三 里"browser-use = Playwright + DOM 索引"的表述来自 [二手]，**应降级为未证实**。
- 复用登录态：`Browser.from_system_chrome()`；云端 `cloud_profile_id`，但
  "**Profile sync transfers cookies, not local storage, IndexedDB, or extensions. Some sites may
  require you to sign in again.**" → 印证 spec-09 的凭据隔离立场。
- **README 完全未提 live view / 用户接管** → 可见性不在其开源库层面。

### 9.4 chrome-devtools-mcp —— 用 Puppeteer、默认自启浏览器 [一手]

`cdn.jsdelivr.net/gh/ChromeDevTools/chrome-devtools-mcp@main/README.md`

- "Uses **puppeteer** to automate actions in Chrome"（一手确认，而非直接 CDP 手写）。
- **默认由 MCP 自己启动浏览器**（"will start the browser automatically once the MCP client uses a
  tool that requires a running browser instance"）；"**connecting to a running Chrome instance
  instead of starting a new one**"属于**高级用法**。
- **默认开启使用统计上报**（Google 收集工具调用成功率/延迟/环境信息），`--no-usage-statistics`
  关闭，`CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` / `CI` 亦可关闭 → **值得注意的隐私默认值**。
- 仅官方支持 Chrome 与 **Chrome for Testing** → 与我们的运行时选型一致。
- **`--remote-debugging-pipe` 在该 README 中零命中**（pipe 仍是少数派）。

### 9.5 对方案的影响：出现一个真正的分叉（需你决策）

补验前，我认为"自持 CDP + 自己写 screencast + 自己写输入层"是唯一路径；补验后，
**存在一个明显更省的分叉**：

| | **路线 A'（坚持现 spec）** | **路线 B'（改用 agent-browser 作为运行时）** |
|---|---|---|
| 运行时 | 自持 Chrome + CDP（spec-02/03） | `agent-browser` 的 daemon + `BrowserManager` |
| 快照/交互 | 自己实现（spec-04） | 直接用它的快照与命令（`@eN` 引用同源） |
| 画面流 | 自己实现 screencast + WS（spec-06） | 直接用它的 stream（协议已定，字段与 spec-06 一致） |
| 输入转发 | 自己实现（spec-08） | 用它的 `input_*` 协议（含 modifiers 位掩码） |
| 面板 | 自绘 canvas（spec-07） | 仍需自绘或反代它的 dashboard |
| 与桌面端契约 | 与 Electron Broker 契约一致 | 与桌面端契约**不同**（它是另一套语义） |
| 工作量 | 大 | **小很多** |
| 风险 | 自实现质量与细节（IME、坐标、OOPIF） | 依赖 agent-browser 版本能力；需验证 0.26.0 是否已含 streaming |
| 与 D1 的关系 | 完全符合 D1 | **与 D1 冲突**（D1 说"不经过 agent-browser 做控制"） |

**我的建议**：
- **GPU/资源受限的局域网硬件部署**方向下，B' 的"少写一半代码 + 已被验证的输入协议"优势很大；
- 但 B' 要接受**放弃与 Electron Broker 的契约一致性**（spec-05 的价值随之下降：MCP 层仍需
  `hermes-studio-browser` 的契约，因此 B' 仍需一层"契约适配"把 agent-browser 的语义映射成
  Broker 的 `snapshot` / `interact` / `screenshot`）。
- 折中方案 **A'+B'**：**运行时与流用 agent-browser（B'），对外仍暴露 Electron Broker 契约（A'）**，
  这样 spec-05 与 MCP 层不变，spec-06/08 的"协议设计"改为"对齐并透传 agent-browser 的 stream 协议"，
  只需新增"同源代理 + 鉴权"这一层。

### 9.6-bis RK3566（aarch64）目标形态的硬事实 [实测 + 一手]

**目标形态已确认为 RK3566（4×Cortex-A55，aarch64）+ A 路线（自持 CDP）。**

1. **Chrome for Testing 有 linux-arm64，但项目 pin 的那个版本没有。** HEAD 实测：

   | URL | 结果 |
   |---|---|
   | `149.0.7827.55/linux-arm64/chrome-linux-arm64.zip` | **404** |
   | `149.0.7827.55/linux-arm64/chrome-headless-shell-linux-arm64.zip` | **404** |
   | `149.0.7827.55/linux64/chrome-linux64.zip` | 200（对照组，方法有效） |
   | `155.0.8059.79/linux-arm64/chrome-linux-arm64.zip` | **200** |

   → 项目 pin 的 `149.0.7827.55`（`packages/desktop/scripts/install-hermes.mjs:45-49`）
   **无 arm64**；当前 Stable（155.x）有。官方 availability 页确认 linux-arm64 提供
   chrome / chromedriver / **chrome-headless-shell** 三种产物。

2. **项目代码不支持 arm64**：`chromeForTestingPlatform()`
   （`packages/desktop/scripts/install-hermes.mjs:305-311`）白名单只有
   `win64 / mac-arm64 / mac-x64 / linux64`，其余直接抛
   `Pinned Chrome for Testing is not configured for ${TARGET_OS}-${TARGET_ARCH}`。
   而 `scripts/harness-check.mjs:426-443` 又以**字面串**断言 `'149.0.7827.55'` 与
   `chromeForTestingPlatform` 必须存在于 install-hermes.mjs
   → **改版本或改平台必须同步改断言**，否则 `npm run harness:check` 失败。

3. **设备端当前没有任何浏览器供应**：`scripts/deploy-source-armbian.sh` 只做 Node 架构判定
   （`:254-270`，aarch64→arm64 / x86_64→amd64），全脚本无 Chrome 或 agent-browser 安装；
   浏览器安装逻辑只存在于 desktop 的 `install-hermes.mjs`。
   → 在 RK3566 上，spec-02 的 resolver 第 2 条（`AGENT_BROWSER_HOME/browsers/chrome-*`）
   **必然落空**，会走到"显式失败"分支。
   → 同时也说明：**当前设备上 Ekko 的 `browser_*` 工具（依赖 agent-browser CLI + 浏览器二进制）
   很可能处于不可用状态**；修好供应链会顺带修复它，且可作为"浏览器装对了"的验证手段。

4. **由此新增一项必需工作**：设备端 arm64 浏览器供应（安装 + 校验 + 磁盘/glibc 前置检查）。
   spec-02 只假设"已有 bundle 可解析"，不覆盖这一步，需要独立 spec 或并入 spec-02。

### 9.7 真机实测（6.6.6.50，2026-10-16）[实测]

以**只读**方式 SSH 采集（三份探针，均不安装、不改配置、不重启服务；唯一写操作是删除探针自建的
`/tmp/hermes-probe-profile`）。**密码未落盘、未写入任何文件。**

**规格 —— 全部达标，此前担心的障碍基本消失：**

| 项 | 实测值 | 影响 |
|---|---|---|
| SoC / 内核 | `6.1.115-vendor-rk35xx` aarch64（RK3566 系） | 确认目标架构 |
| 发行版 | **Armbian-unofficial 26.02.0-trunk noble / Ubuntu 24.04 LTS** | 非 Debian bookworm |
| CPU | 4 核 | 与文档假设一致 |
| 内存 | **MemTotal 3.9GB**，实测 available **3.0GB**，swap 1.9GB | **4GB 板 → 可行** |
| glibc | **2.39** | **远高于 Chrome 要求，无障碍** |
| 磁盘 | `/dev/mmcblk2p2` 29G，**可用 20G** | 充足 |

**浏览器供应 —— 与 spec-02 的假设完全不同：**

- **设备已有系统 Chromium：`154.0.8037.92`**，来自
  `chromium 154.0.8037.92-1xtradeb1.2404.1 arm64`（**xtradeb 第三方 PPA 的 arm64 deb，
  不是 snap**），二进制 `/usr/lib/chromium/chromium`，`/usr/bin/chromium` 是 sh 启动器。
- 另装有 **`libv4l-rkmpp`**（RK 平台 V4L2 硬件编解码插件）——**设备具备 RK 硬件视频编解码**。
- **无 Chrome for Testing bundle**：`~/.agent-browser`、`~/.cache/ms-playwright`、
  `~/.hermes-web-ui/desktop-browser` 三个目录**均不存在**。
- **headless 冒烟测试通过**：`chromium --headless=new --no-sandbox --disable-gpu
  --disable-dev-shm-usage --dump-dom about:blank` → 输出正常 HTML，**exit=0**
  （仅一条无害的 UPower D-Bus 报错）。

> **结论：D1 需要修订。** 设备上正确的运行时是**系统 chromium（apt 管理）**，
> 而不是 bundle 的 Chrome for Testing。这一并**绕开了** 9.6-bis 里的两个障碍
> （149 无 arm64、harness 断言锁死 149 字面串），代价是失去版本 pin（接受 apt 漂移）。
> spec-02 的 resolver 需增加"系统 chromium 常见路径"一档。

**设备上已存在的浏览器/kiosk 栈（重要）：**

- 已有一个 **kiosk Chromium 常驻运行**：
  `--kiosk --start-fullscreen --app=http://127.0.0.1:6060/ --window-size=320,200
  --user-data-dir=/tmp/quanthermes-kiosk-chrome --ozone-platform=x11 --disable-gpu`，
  由 `/opt/quanthermes/quanthermes-kiosk.sh` 启动（父进程链：
  `dbus-run-session → quanthermes-kiosk-session.sh → quanthermes-kiosk.sh → Xorg + chromium`）。
- **该脚本不在本仓库**，属于另一项目 `quantclaw_singup/quanthermes/`
  （见 `docs/plans/15_quanthermes_ux_design.md:204`）；本仓库只有
  `scripts/verify-device-image.sh:51-56` 在验证 `quanthermes` / `quanthermes-kiosk` 服务与 80/6060 端口。
- 设备还有：`quanthermes`（:80，Go 服务，static/config/device_state）、`ttyd`（:7681）、
  `dufs`（:5000）、Xorg（:0）。**没有任何 CDP 调试端口**。
- `hermes-agent.service` 当前 **inactive**（按需启动）。
- `docs/work-log.md:900` 记录"设备 6.6.6.47 的 kiosk Chromium 为 **320x200 小屏**"，
  与实测 `--window-size=320,200` 吻合 → **设备自带屏是 320×200 的极小屏**。

**资源现状（这是最紧的一环）：**

- `docs/planning/group-chat-discussion-task-oriented-spec.md:72-74` 记录：
  "4 核 / 3.9GB RAM（**可用 ~2.4GB**）/ 5 个常驻 hermes gateway（~170MB each）+
  Node 服务 + Chromium kiosk，**已占 ~1.6GB**"。
- 实测 `ps` top-RSS：kiosk chromium 家族（多个进程）合计约 **650MB**，Xorg 约 100MB。
- → **再叠一个独立 headless chromium（300–500MB）会把可用内存压到 ~2GB 附近**，
  而设备还有 5 个常驻 gateway。因此必须：单会话单 tab、低分辨率、短空闲回收、
  **绝不复用 kiosk 实例**（它指向 Web UI 自己，被 agent 导航走会把设备屏上的 UI 弄没）。

**两个新的可用性约束（必须写进 spec-07）：**

1. **设备自带屏只有 320×200** —— 在这个宽度里嵌一个"浏览器画面"基本不可用。
   本功能的实际受众是**用户自己电脑上的浏览器**（局域网访问 6060），
   设备屏侧应保持现状或只给一个入口。
2. **`/home/hermesui/.hermes-web-ui/hermes-web-ui.db` 已达 536MB**，
   磁盘虽够，但说明状态目录已有体量，新功能不要往里塞大对象（帧严禁落盘）。

### 9.6 与部署形态相关的一条硬结论

agent-browser 的流服务**硬性拒绝非本机 origin**（403），而本项目的目标形态是
**"局域网内的硬件 + 用户用自己电脑的浏览器访问"** → 直接暴露它的流端口**必然不可用**。
因此无论走哪条路线，都必须有**服务端同源中转**（我们自己的 WS/HTTP 端点转发到它的 loopback 端口）。
这一点把 spec-06 的定位从"实现流"改成"实现同源代理 + 鉴权"，是本次补验最确定的结论。

