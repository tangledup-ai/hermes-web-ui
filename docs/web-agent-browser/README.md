# Web 端可见 Agent 浏览器 — implementation specs

> One spec per task. Each spec is self-contained: an agent that has read only
> this file plus its own spec should be able to execute it without re-debating
> the design.

目标：在 **普通 Web UI**（浏览器打开的 Web UI、VPS Web UI）里提供一个
**用户可见、Agent 可操作、用户可接管**的浏览器面板，形态对齐 Electron 桌面端
已有的内置浏览器，但控制面走服务端自持的 CDP 连接。

## 决策记录（已定，不再讨论）

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | 浏览器运行时 | **自持 CDP**；**优先复用设备上由 apt 管理的系统 chromium**（`/usr/bin/chromium`），Chrome for Testing bundle 仅作可选回退；**不引入 Playwright / Puppeteer，不经过 `agent-browser` CLI 做控制** | 与桌面端决策一致（`desktop-agent-browser.md:5-7`）；**真机实测**（见「目标设备实测约束」）显示设备已有 chromium 154，且项目 pin 的 CfT `149.0.7827.55` **没有 arm64 构建** |
| D2 | 实现范围 | **一路做到 P4**（无头运行时 → CDP 会话 → 自动化语义 → Broker → 画面流 → 客户端面板 → 输入转发与接管） | 用户明确要求"agent 可以操作它" |
| D3 | 开放范围 | 目标设备（RK3566 / Armbian）**默认开启**——它是本功能的唯一落点；启动时做**硬门槛检查**（内存/磁盘/可执行文件），任一不满足则**不启用**并写明确日志。`off` 仍可显式设置 | 真机 3.9GB RAM / 可用 3.0GB，但常驻服务已占约 1.6GB，因此不能无条件开 |
| D4 | 画面承载 | **自绘 canvas**，**不用 iframe** | 避免任何 CSP 例外，`security.ts` 全程不动。（Browserbase 用 iframe，但那需要给 live 页单独开 `frame-ancestors 'self'`） |
| D5 | 画面传输 | **CDP `Page.startScreencast` + ack 门控**，不用 WebRTC | 用户明确选择 CDP；接受其在"用户手动接管"时的帧率上限（spec-06 记为已知取舍） |
| D6 | CDP 传输 | **`--remote-debugging-pipe`**，不开 TCP 调试端口；loopback 随机端口仅作显式回退 | 与桌面端"不开放远程调试端口"原则一致；零新依赖（`ws` 仅在根 `package.json` 的 devDependencies） |

## 关键前置事实（已核实，实现时不要重新假设）

1. **MCP 层零改动即可复用。** `hermes-studio-browser` 在 Web 模式**已经注入**
   （`packages/server/src/services/ekko-agent/mcp.ts:7-12` 的 `MANAGED_SERVERS`
   无条件包含 browser，门控只有 `shouldIncludeManagedMcpServers()`），
   `bin/hermes-studio-mcp.mjs:1764-1776` 的 `visibleTools()` 只在
   `browserDescriptor()` 抛错时隐藏整个 toolset。
   → **只要 Web Broker 写出合法 descriptor，MCP 立刻可见。**
2. **descriptor 路径是唯一的共享契约，也是唯一的冲突点。**
   `bin/hermes-studio-mcp.mjs:589` 读 `join(appHome(),'desktop-browser','broker.json')`，
   桌面端也写同一路径 → 必须解决"谁写"（见 spec-05）。
3. **新 Broker 必须完全兼容 Electron Broker 的 RPC 契约**，否则 MCP 层与
   客户端面板都要改。契约以
   `packages/desktop/src/main/browser/browser-broker.ts` 与
   `packages/desktop/src/main/browser/browser-types.ts` 为准（spec-05 已逐条抄录）。
4. **Chrome 可执行文件的解析有 harness 约束。**
   `scripts/harness-check.mjs:501-503` 禁止 `packages/desktop/src/main/webui-server.ts`
   出现 `bundledBrowserExecutable()`，设计意图是"由 `AGENT_BROWSER_HOME` 解析浏览器"。
   服务端自持 CDP 必然要自己定位可执行文件，因此 spec-01 新增一条 harness 断言把
   新语义固化，spec-02 的 resolver 顺序必须尊重 `AGENT_BROWSER_EXECUTABLE_PATH`。
5. **`--remote-debugging-pipe` 是主方案**：不开端口、零新依赖
   （`ws` 目前只在根 `package.json` 的 devDependencies，见 spec-02 §决策）。
6. **Socket.IO 已可用于长连接**，且 `/socket.io/` 前缀已在
   `packages/server/src/index.ts:620-633` 的 upgrade 白名单内
   → 画面流用 Socket.IO namespace，不要把原生 WS 路径塞进白名单。

## 目标设备实测约束（唯一落点，2026-10-16 实测）

> 完整证据见 [prior-art-research.md](./prior-art-research.md) §9.7。下面每条都是实测值，
> 实现时不要按"通用 Linux 假设"重新推断。

| 项 | 实测 | 对实现的约束 |
|---|---|---|
| SoC / 内核 | `6.1.115-vendor-rk35xx` aarch64（RK3566 系） | ARM64 |
| 发行版 | Armbian-unofficial 26.02.0-trunk noble / **Ubuntu 24.04 LTS** | 走 `apt` 生态，不是 Debian bookworm |
| 内存 | **3.9 GB**（实测 available 3.0 GB）+ 1.9 GB swap | spec-01 硬门槛的依据 |
| glibc | **2.39** | 无障碍 |
| 磁盘 | `/` 可用 **20 GB** | 无障碍 |
| 浏览器 | **系统 chromium `154.0.8037.92`**（xtradeb arm64 deb，非 snap）+ `libv4l-rkmpp` | **D1：优先复用它** |
| 浏览器 bundle | `~/.agent-browser`、`~/.cache/ms-playwright`、`~/.hermes-web-ui/desktop-browser` **均不存在** | 没有 CfT bundle；resolver 必须能落到系统 chromium |
| headless | `chromium --headless=new --dump-dom about:blank` → **exit=0**（以 `hermesui` 用户，免 sandbox） | 运行时可行 |
| **screencast** | 实测可达 **29 fps**（800×600/q60，端口）与 **24.5 fps**（800×600→800/q50，**pipe**），单帧 3.3–5.9 KB | spec-06 默认参数已按此校准 |
| **pipe 模式** | `--remote-debugging-pipe` 在 aarch64 **可用**，但**必须用 Node `stdio` 数组**建 fd 3/4 | spec-02 D6 成立，实现方式已固定 |
| 服务运行身份 | `hermes-web-ui.service` 为 **`User=hermesui`**（kiosk chromium 为 root） | 默认**不需要** `--no-sandbox`；root 形态必须显式开启 |
| 常驻占用 | 5 个 hermes gateway（~170MB each）+ Node + kiosk chromium（约 650MB）+ Xorg（约 100MB），**已占约 1.6 GB** | spec-09 资源上限的依据 |
| 设备自带屏 | **320×200**（kiosk chromium `--window-size=320,200`） | spec-07 受众定位：面板主要给用户 PC 浏览器用 |
| 部署版本 | `@quanthermes/hermes-web-ui 0.8.9`，`PORT=6060` / `BIND_HOST=0.0.0.0` | 局域网访问 |

**已存在的 kiosk 栈（不要碰）：**

- 常驻 kiosk chromium：`--kiosk --app=http://127.0.0.1:6060/ --user-data-dir=/tmp/quanthermes-kiosk-chrome`，
  启动链 `dbus-run-session → quanthermes-kiosk-session.sh → quanthermes-kiosk.sh → Xorg + chromium`。
- **该脚本不在本仓库**，属于另一个项目 `quantclaw_singup/quanthermes/`；本仓库只有
  `scripts/verify-device-image.sh:51-56` 在验证 `quanthermes` / `quanthermes-kiosk` 服务与 80/6060 端口。
- **绝不复用 kiosk 实例**：它的 `--app` 指向 Web UI 自己，agent 一旦导航，设备屏上的 UI 就会消失。
- `hermes-web-ui.db` 已达 **536 MB**：新功能不要往状态目录塞大对象（帧严禁落盘）。

**已排除的复用可能**：设备上 `/home/hermesui/.hermes-web-ui/hermes-web-ui-pereview` 是
**预览部署**（更新前的影子实例，`packages/server/src/controllers/update.ts:93-100` 定义独立端口
8650/8651/18650/19650），**不是网页预览能力**，本方案无可复用的既有实现。

## 架构

```text
Agent（Ekko / Hermes / Codex / Claude Code）
  → MCP stdio：hermes-studio-mcp browser          ← 不改
  → Browser Broker（Web 版，实现相同 RPC 契约）    ← spec-05
  → BrowserSession → CdpClient（pipe）            ← spec-03
  → HeadlessRuntime（系统 chromium 优先，CfT 回退） ← spec-02
  → Automation（snapshot / interact / …）         ← spec-04

用户看 / 接管
  → Vue 面板（canvas 播放器）                      ← spec-07
  → Socket.IO namespace /browser：帧下行 + 输入上行 ← spec-06 / spec-08
  → 同一个 BrowserSession、同一个 tab
```

**关键：播放器是自绘 Vue 组件，不是 iframe。** 因此不需要 `frame-src`
或 `frame-ancestors` 例外，`packages/server/src/security.ts` 全程不动。

## 依赖图

```
 spec-01 boundary & gate
      │
 spec-02 headless runtime
      │
 spec-03 cdp session ──── spec-04 automation semantics
      │                        │
      └────────┬───────────────┘
               │
          spec-05 broker ──────────── spec-06 screencast ── spec-07 client panel
               │                                                │
               └──────────────────────────────────── spec-08 input & takeover

 spec-09 security hardening ── 横切，从 spec-02 起每个 spec 的 acceptance 都含安全项，
                               最终收口在 spec-09
 spec-10 testing & delivery ── 收口
```

并行泳道（spec-03 落地后）：

- **Lane A**：spec-04（自动化语义）
- **Lane B**：spec-05 → spec-06 → spec-07（Broker → 画面 → 面板）
- **Lane C**：spec-08（输入与接管），依赖 spec-06 的通道
- **Lane D**：spec-09 / spec-10 随时可起，不阻塞主链

## Spec files

| File | Task | Depends on | Phase | Est. size |
|---|---|---|---|---|
| [spec-01-boundary-and-gate.md](./spec-01-boundary-and-gate.md) | 平台边界修订 + `HERMES_BROWSER_SURFACE` gate + harness 断言 | — | P0 | ~150 LOC |
| [spec-02-headless-runtime.md](./spec-02-headless-runtime.md) | Chrome 可执行文件定位 + pipe 模式启动 + 生命周期 | S1 | P1 | ~350 LOC |
| [spec-03-cdp-session.md](./spec-03-cdp-session.md) | 最小 CDP 客户端（pipe/null 分隔 JSON-RPC）+ 会话与 target 模型 | S2 | P1 | ~450 LOC |
| [spec-04-automation-semantics.md](./spec-04-automation-semantics.md) | snapshot/ref、interact、text.read、console、screenshot | S3 | P1 | ~600 LOC |
| [spec-05-broker-contract.md](./spec-05-broker-contract.md) | Web Broker：RPC 契约 + 租约 + descriptor 写入 | S4 | P2 | ~500 LOC |
| [spec-06-screencast-stream.md](./spec-06-screencast-stream.md) | `Page.startScreencast` + Socket.IO `/browser` | S5 | P3 | ~300 LOC |
| [spec-07-client-panel.md](./spec-07-client-panel.md) | Vue 浏览器面板 + Tab gate 放宽 + i18n | S6 | P3 | ~700 LOC |
| [spec-08-input-and-takeover.md](./spec-08-input-and-takeover.md) | 输入转发（含输入法）+ 接管与租约互斥 | S6 | P4 | ~450 LOC |
| [spec-09-security-hardening.md](./spec-09-security-hardening.md) | SSRF/CSRF 封堵、权限默认拒绝、资源上限、日志脱敏 | S2 起横切 | 全程 | ~400 LOC |
| [spec-10-testing-and-delivery.md](./spec-10-testing-and-delivery.md) | 测试矩阵、CI gate、交付清单 | 全部 | 收口 | ~250 LOC |

## Cross-cutting rules（适用于每个 spec）

继承 `AGENTS.md` 与 `ARCHITECTURE.md`，外加本方案特有条款：

1. **Routes before proxy catch-all.** 所有新 `/api/browser*` 路由必须注册在
   proxy 中间件之前（`packages/server/src/routes/index.ts`）。
2. **状态路径一律走 `getWebUiHome()`**，不得直接读 `process.env.HERMES_WEB_UI_HOME`，
   不得使用 `process.cwd()`。
3. **不使用 shell 字符串**：启动 Chrome 用 `execFile` / `spawn` + 参数数组。
4. **不开远程调试端口**（主方案）。CDP URL / pipe 句柄永不落盘、永不进日志、
   永不进 RPC 响应、永不进模型上下文。
5. **不接受任意 JS**：不得向 Agent 暴露 `Runtime.evaluate` 的任意表达式入口；
   元素选择与快照只允许 `Accessibility` / `DOM` / `Runtime.callFunctionOn`
   执行代码内固定的脚本。
6. **页面文本是不可信 Agent Context**：不得把页面文字当作指令执行。
7. **用户可见字符串补齐全部 10 个 locale**：`en/zh/zh-TW/ja/ko/pt/es/ru/de/fr`。
8. **`security.ts` 不改**。若某个实现步骤看起来必须放宽全局 CSP，停下来重新设计。
9. **每个 spec 的 acceptance block 就是测试契约**：全部通过才算该 spec 完成。
10. **不要一次性打开 surface**：默认值已按 D3 定为 `local`（受硬门槛约束），
    但"默认 `local`"不等于"已放行"——在 spec-09 全部安全项通过之前，
    设备脚本与 manifest **不得再添加任何显式启用**（默认值 + 硬门槛是唯一生效点）；
    如需阶段性保守，只在设备脚本里显式写 `off` 并写明原因（spec-01 §4）。

## Source of truth

- 业界与开源方案调研（两家一手对照 + 与 spec 的逐条比对 + 待确认清单）：
  [prior-art-research.md](./prior-art-research.md)
- 桌面端既有设计与平台边界：`docs/planning/desktop-agent-browser.md`
  （**注意**：其第 65 行"普通 Web UI 和 VPS Web UI 永久不提供内置浏览器功能"
  与第 126-133 行平台边界由 spec-01 正式修订）
- Electron Broker 契约：`packages/desktop/src/main/browser/browser-broker.ts`、
  `browser-types.ts`
- MCP 侧消费方式：`bin/hermes-studio-mcp.mjs`（`browserDescriptor` 587-608、
  `browserSession` 610-624、`browserRequest` 626-643、工具定义 890-952、
  `visibleTools` 1764-1776）
- 架构与包边界：`ARCHITECTURE.md`
- 校验矩阵：`docs/harness/validation.md`

## Assignment guidelines

- **S1 必须先落地**：它固定 gate 语义与 harness 断言，后续 spec 都依赖它。
- **S2 → S3 → S4 严格串行**：每一层都依赖上一层的对象模型。
- **S5 是分水岭**：S5 完成时 Agent 已经能操作浏览器（只是用户看不见），
  这是 D2 的最小达成点，可独立验收。
- **S6/S7/S8 可在 S5 后并行**：画面流、面板、输入各自文件集不同；
  S8 依赖 S6 的通道，需等 S6 的 namespace 契约冻结。
- **S9 不是最后一步**：它的条目从 S2 起就要随每个 spec 一起满足，S9 只做收口与回归。
- 每个 spec 都有独立 `Suggested commit message`，按 spec 粒度提交，不要合并无关改动。

## 不做（全方案范围内）

- 浏览器 Profile 管理（多 Profile 创建/切换/代理）、下载管理、站点权限面板 —
  桌面端已有，Web 版第一版不做（见各 spec 的 Out of scope）。
- 元素框选批注（桌面端 `desktop-agent-browser.md` §13）。
- 云浏览器后端（Browserbase / Firecrawl）。
- 向局域网或互联网提供画面流。
