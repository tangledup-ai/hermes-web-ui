# 工作日志 2026-10-16 — Web 端可见 Agent 浏览器（spec-01 → spec-05 施工）

方案：`docs/web-agent-browser/`（README + spec-01 … spec-10）。
本次范围：**S1–S5**，每个 spec 均按其 acceptance 写测试并全绿。

## 进度

| Spec | 内容 | 状态 | 验证 |
|---|---|---|---|
| S1 | 平台边界修订 + `HERMES_BROWSER_SURFACE` gate + harness 断言 | 完成 | 28 测试；断言 D/E'/F 已做反向改动验证 |
| S2 | 无头运行时（chromium 解析 + pipe 启动 + 生命周期） | 完成 | 28 测试 |
| S3 | 最小 CDP 客户端 + 会话/tab 模型 | 完成 | 27 测试 |
| S4 | 自动化语义（snapshot/interact/text/console/screenshot + url-policy） | 完成 | 57 测试 |
| S5 | Web Broker（RPC 契约 + 租约 + descriptor） | 完成 | 与桌面 broker 共用 `tests/fixtures/browser-broker-contract.json` 逐字校验契约 |
| S6 | `Page.startScreencast` + Socket.IO `/browser` | 未开始 | — |
| S7 | Vue 浏览器面板（canvas + i18n + Tab gate） | 未开始 | — |
| S8 | 输入转发与接管 | 未开始 | — |
| S9 | 安全收口（SSRF/CSRF、权限默认拒绝、资源上限、脱敏） | 未开始（部分条目已随 S2/S4 满足） | — |
| S10 | 测试矩阵与交付清单 | 未开始 | — |

回归结果：`180 passed / 1 skipped`（linux-only 用例；口径 `tests/server/browser-*.test.ts` + `tests/server/cdp-client.test.ts`），
`npx tsc --noEmit -p packages/server/tsconfig.json` 无错误，`npm run harness:check` 通过。

```bash
npx vitest run tests/server/browser-*.test.ts tests/server/cdp-client.test.ts
npx tsc --noEmit -p packages/server/tsconfig.json
npm run harness:check
```

## 新增

服务端：

- `packages/server/src/config/browser-surface.ts` — gate：`off|local`，默认 `local` + 硬门槛（MemTotal ≥ 3 GiB、MemAvailable ≥ 1.2 GiB、
  可解析的浏览器可执行文件、Web UI home 卷 ≥ 1 GiB），启动一次性判定并冻结；非法值 → `off` + 告警；`HERMES_DESKTOP=true` → `off`。
- `packages/server/src/services/browser/{types,executable,runtime,surface-probe}.ts` —
  解析顺序 `AGENT_BROWSER_EXECUTABLE_PATH` → `AGENT_BROWSER_HOME/browsers/chrome-*` → 系统 chromium（`/usr/bin/chromium` 等）
  → 显式失败（错误含"缺少浏览器运行时"与已搜索路径）；`--version` + headless 冒烟校验；`spawn` 参数数组 +
  `stdio: ['ignore','ignore','pipe','pipe','pipe']`；root 运行时才加 `--no-sandbox` 并告警。
- `packages/server/src/services/browser/{cdp-types,cdp-client}.ts` — `\0` 分帧（跨 chunk/多消息/多字节安全）、id 匹配、
  按 `sessionId` 路由事件、命令超时（默认 30s）、管道关闭/崩溃时明确 reject、dispose 清理监听与定时器。
- `packages/server/src/services/browser/session.ts` — 一会话一 browser context（真隔离）、`BrowserTab` 字段对齐桌面端、
  8 tab 上限（错误文案同桌面端）、4 会话上限 + 空闲 TTL，target 双向发现（页面自开 tab 超限则拒绝）。
- `packages/server/src/services/browser/snapshot.ts` — AX 快照 + `@eN` 引用 + `snapshotId` 失效（文案同桌面端）、
  密码等 protected value 不进快照、节点上限 300 / 文本 24000。
- `packages/server/src/services/browser/element-script.ts` — 固定页面脚本常量（不接受任何外部 JS）。
- `packages/server/src/services/browser/automation.ts` — click（move/pressed/released 坐标点击）、type（清空 + `Input.insertText`）、
  press（修饰键解析）、scroll（mouseWheel，默认 500px）、text.read 分页（默认 4000 / 上限 20000）、console 缓冲（500 条 / 2000 字 / URL 脱敏）、
  screenshot（`captureBeyondViewport`、12 MB 上限、不落盘）。
- `packages/server/src/services/browser/url-policy.ts` — `normalizeBrowserUrl`、`isBlockedHost`（loopback/私网/link-local/云 metadata）、
  `publicBrowserUrl`、`redactBrowserText`。

- `packages/server/src/services/browser/{connect,surface-probe,broker-descriptor,broker-lease,broker-projections,broker-server,broker-instance,web-browser-service}.ts`（S5）—
  与 Electron Broker 契约一致的 loopback HTTP RPC（`POST /v1`、`POST /v1/session`，
  Bearer + `X-Hermes-Browser-Client` 双鉴权，`{operation_id,result}` / `{error}` 信封，
  lease/control/cancel/takeover → 409）；投影按 `broker-projections.ts` 剔除
  favicon/profile/agent/CDP 字段；descriptor 写 `<webUiHome>/desktop-browser/broker.json`
  （与桌面端同路径，靠 `HERMES_DESKTOP=true → off` 避免两套争抢）；service 由单会话
  支撑，`maxTabs = 8`（spec-09 把设备并发会话收敛为 1）。

测试：`tests/server/{browser-surface,browser-executable,browser-runtime,cdp-client,browser-session,browser-snapshot,browser-automation,browser-url-policy}.test.ts`（S1–S4）；
`tests/server/{browser-broker-descriptor,browser-broker-lease,browser-broker-contract,browser-web-service}.test.ts` 与 `tests/desktop/browser-broker-contract.test.ts`（共用 `tests/fixtures/browser-broker-contract.json`）（S5）。

## 修改

- `docs/planning/desktop-agent-browser.md`：加"修订记录"，重写 §一/§三/§五，删除"永久不提供"等绝对表述，
  指向 `docs/web-agent-browser/README.md`，保留桌面端仍有效的安全约束。
- `packages/server/src/index.ts`：bootstrap 早期 `initializeBrowserSurfaceGate({ probe: createBrowserSurfaceProbe() })`（一次性冻结 + 记录版本）；
  随后 `await startWebBrowserBroker()`（gate 关闭时直接返回 `null`，连监听 socket 都不建）。
- `packages/server/src/services/shutdown.ts`：优雅关停时依次 `stopWebBrowserBroker()` 与
  `stopHeadlessBrowserRuntime()`（各自独立 try/catch，失败只告警、不阻断关停）。
- `scripts/harness-check.mjs`：断言 D（桌面 webui-server 不得承载浏览器运行时）、E'（`HERMES_DESKTOP` → off 且有测试）、
  F（硬门槛不可绕过、启动路径不得直接读 env）+ 设备脚本/manifest 不得写 `HERMES_BROWSER_SURFACE=local`。
- `scripts/deploy-source-armbian.sh`：不写该 env（默认值 + 门槛是唯一生效点），附说明与非法值告警守卫。

## 方案内部冲突（已按 acceptance 处理）

1. **spec-01 默认值**：acceptance 2 + README D3 说默认 `local`（配硬门槛），同文件 Hard rules 说默认必须 `off`。
   采信 **acceptance（测试契约）+ D3**；`off`/非法/门槛不满足时完全不注册（不是注册后 403）。
2. **spec-02 来源顺序**：README D1 说系统 chromium 优先、CfT 仅作回退；acceptance 1 的顺序是 env → CfT → 系统 chromium。
   采信 **acceptance 表**：bundle 存在时优先（版本可控），设备上无 bundle，实际落到 apt chromium，并在 gate report 记录真实版本。

3. **spec-01 默认值：文本已对齐（2026-10-16）**。第 1 条裁决只改了文档、未改代码。
   `spec-01` Hard rules（原"默认值必须是 `off`"）、其 Suggested commit message
   （原"default off"）、README cross-cutting rule 10（原"默认 `off`"）三处旧稿文字
   已统一改写为"默认 `local` + 硬门槛兜底"；`spec-10` 的"设备端确认默认关闭"同步改为
   "确认默认值与硬门槛实测值"。代码仍为 `BROWSER_SURFACE_DEFAULT_MODE = 'local'`。
   未对齐前的现象：同一 spec 内 3 处说 `local`、3 处说 `off`，无法判断哪处是最终决策。

## 后续约定（S6 起沿用）

- gate 唯一生效点 `initializeBrowserSurfaceGate()`；运行期只读访问器。
- 不开 TCP 调试端口；pipe 句柄/消息体/页面查询串不进日志（日志只有 method/sessionId/耗时）。
- 所有导航过 `normalizeBrowserUrl()`，重定向后再校验（S9 收口）。
- `tab_id` = CDP `targetId`；`mediaType`/`snapshotId`/`snapshot_id` 逐字沿用桌面契约。
- descriptor 路径与桌面端相同（`app/home/desktop-browser/broker.json`），靠 `HERMES_DESKTOP=true → off` 避免两套争抢（S5）。
- 帧严禁落盘（`hermes-web-ui.db` 已 536 MB）；真实 Chrome 集成测试用 `HERMES_BROWSER_TEST=1` 门控（S10）。
