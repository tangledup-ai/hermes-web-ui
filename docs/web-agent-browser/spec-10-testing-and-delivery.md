# Spec 10 — 测试矩阵与交付

> Status: 收口 spec。依赖其余全部 spec。

## Summary

把前面各 spec 的 acceptance 汇总成可执行、可复核的测试矩阵，明确 CI 门禁、
手动验收清单与交付物清单，并提供 **P1→P4 的逐阶段对照表**，便于按步核对进度。

## Dependencies

- 全部。

## Files

### Create

- `tests/server/browser-integration.test.ts` — 真实 Chrome 的集成测试（默认 skip）
- `tests/e2e/browser-panel.spec.ts` — Playwright（mock 后端）
- `docs/web-agent-browser/delivery-checklist.md` — 交付核对清单

### Modify

- `docs/harness/validation.md` — 补充本特性的校验命令
- `scripts/harness-check.mjs` — 若 spec-01 之外的断言还需要补
- `AGENTS.md` — 增加一条指向 `docs/web-agent-browser/` 的入口（保持文件短小）

## Acceptance criteria

### 1. 单元测试（无真实 Chrome，CI 必跑）

| 覆盖点 | 文件 | 来源 spec |
|---|---|---|
| gate 解析、冻结、非法值、开发默认 | `tests/server/browser-surface.test.ts` | S1 |
| 可执行文件解析顺序与失败消息 | `tests/server/browser-executable.test.ts` | S2 |
| 运行时参数数组、超时 kill、shutdown、gate=off 不启动 | `tests/server/browser-runtime.test.ts` | S2 |
| CDP 协议：分片消息、id 匹配、超时、pipe 关闭、事件注销 | `tests/server/cdp-client.test.ts` | S3 |
| 会话：tab 上限、回收、隔离、dispose 幂等、target 双向发现 | `tests/server/browser-session.test.ts` | S3 |
| 自动化：CDP 命令序列、快照失效、text.read 分页、截图字段名 | `tests/server/browser-automation.test.ts` | S4 |
| URL 策略：scheme 白名单、host 类别、重定向复核 | `tests/server/browser-url-policy.test.ts` | S4 |
| Broker：契约一致性 fixture、鉴权、错误码映射、投影字段集合 | `tests/server/browser-broker-contract.test.ts` | S5 |
| Broker：租约冲突文案、stale 接管、generation abort、并发上限 | `tests/server/browser-broker-lease.test.ts` | S5 |
| descriptor：权限位、抢占规则、退出清理 | `tests/server/browser-broker-descriptor.test.ts` | S5 |
| 画面流：off 不注册、ack 门控、多订阅单流、空转停止 | `tests/server/browser-stream.test.ts` | S6 |
| 输入：租约期间拒绝、接管放行、modifiers、insertText | `tests/server/browser-input-relay.test.ts` | S8 |
| 坐标换算：分数缩放、pageScaleFactor、边界夹紧 | `tests/client/browser-coordinates.test.ts` | S8 |
| 面板：探测失败安全、gate 三分支、串行解码、不可见 unsubscribe | `tests/client/browser-panel.test.ts` | S7 |
| 安全：host 拦截穷举、重定向、页面内拦截、权限集合、日志脱敏 | `tests/server/browser-security.test.ts` | S9 |

1. 表中每一项都必须存在且**默认在 CI 执行**（不依赖真实 Chrome）。
2. 任何需要真实浏览器的断言都不得混进上述文件，必须放到 §2。

### 2. 集成测试（真实 Chrome，默认 skip）

3. `tests/server/browser-integration.test.ts` 由 `HERMES_BROWSER_TEST=1` 门控，
   默认 `describe.skip`。**第一条必须最先落地并通过**，因为它是整个方案在真实设备上
   唯一尚未验证的技术前提：
   - **首验项（✅ 已于 2026-10-16 在真机 6.6.6.50 通过，数据见 spec-06 acceptance 10）。**
     实测结论：`Page.startScreencast` 在 RK3566 + 系统 chromium 154 + headless 下
     **可以稳定产帧**（端口 20.8–29 fps；**pipe 24.5 fps / 3.3 KB 每帧**），
     且 `--remote-debugging-pipe` 在 aarch64 上可用（须用 Node stdio 数组方式）。
     ⇒ **spec-06 的路线成立，无需重估。**
     仍保留为集成测试的回归项：**在真实设备上复测帧率与单帧字节数**，
     并在 Agent 高频 DOM 操作叠加时复测，用于校准 spec-06 的默认参数。
   - 真的拉起浏览器（resolver 应命中系统 chromium）、打开 `about:blank`、
     创建/切换/关闭 tab；
   - 打开一个内网 fixture 页面（**仅此测试**通过显式测试开关放行 loopback）
     并在其中登录、断言两个会话互不可见；
   - snapshot → click → type（含中文）→ screenshot 的真实链路；
   - 关闭会话后浏览器进程与 user-data-dir 被清理，且**不影响设备上已有的
     kiosk chromium 实例**（断言其 PID 仍然存活）。
4. 集成测试必须在 CI 之外的显式环境运行（本地或带浏览器的专用 job），
   且失败不得影响主测试套件的可信度。若在 CI 中启用，需先写入
   `docs/harness/validation.md`。

### 3. e2e（Playwright，mock 后端）

5. `tests/e2e/browser-panel.spec.ts` 使用现有的 e2e mock 基建
   （`tests/e2e/fixtures.ts`），断言：
   - surface 为 `off` 时：无 browser Tab、无面板 chunk 加载；
   - surface 为 `local` 时：Tab 出现、面板渲染、canvas 存在；
   - 桌面端形态（有 bridge）行为与改动前一致（回归保护，参见
     `tests/e2e/desktop-window-chrome.spec.ts` 的写法）；
   - 面板不可见时不再订阅（可通过 mock socket 计数断言）。

### 4. CI 门禁

6. `npm run harness:check` 必须包含 spec-01 的断言 D 与 E。
7. `npm run build` 必须通过（含 `vue-tsc` 类型检查与 i18n key 完整性）。
8. 全量测试与 e2e 按 `docs/harness/validation.md` 的矩阵执行；
   本 spec 需在该文件里新增一行说明"浏览器面板"改动应跑哪些命令。

### 5. 手动验收清单（每条必须有人真的做过并留下结论）

9. `delivery-checklist.md` 至少包含：
   - 关闭 gate 时：进程数无变化、descriptor 未写、无 namespace、无 Tab；
   - 打开 gate 时：descriptor 权限正确、MCP `tools/list` 能看到 browser 类目入口；
   - **Agent 侧**：让 Ekko 用 MCP browser 工具打开一个真实站点并完成一次
     搜索（snapshot → type → click），全程可见；
   - **接管**：Agent 操作中断言用户接管后 Agent 收到 409 且能恢复；
   - **中文输入**：在页面输入框里输入中文并提交成功；
   - **SSRF**：尝试访问内网与 metadata 地址被拒且有明确报错；
   - **设备端**：在设备上确认默认值（`local`）的硬门槛实际判定结果，并记录实测值
     （门槛不满足时即"明确不启用"，需留下 gate report 的失败项）；
   - **桌面端回归**：桌面模式下浏览器面板行为与改动前一致。

### 6. 逐阶段对照表（进度核对入口）

10. `delivery-checklist.md` 中提供下表，作为"一步步对照工作"的主入口：

| 阶段 | 完成标志（可观测） | 对应 spec |
|---|---|---|
| **P0** 边界与 gate | `HERMES_BROWSER_SURFACE=off` 时行为与今天完全一致；harness 断言 D/E 通过 | S1 |
| **P1a** 无头运行时 | 能拉起 Chrome 并拿到 CDP 句柄；gate=off 时不启动任何进程 | S2 |
| **P1b** CDP 会话 | 能创建/切换/关闭 tab，会话间 Cookie 隔离 | S3 |
| **P1c** 自动化语义 | 能对页面做 snapshot/click/type/screenshot（无 UI，用测试脚本驱动） | S4 |
| **P2** Broker | **Agent 已能操作浏览器**（MCP 侧可见 toolset），用户看不见 | S5 |
| **P3a** 画面流 | 前端能收到帧（可用最小回显页面验证） | S6 |
| **P3b** 客户端面板 | 用户在对话页能看到面板与画面、能切换 tab | S7 |
| **P4** 输入与接管 | 用户能直接操作页面、能接管、中文输入可用 | S8 |
| **收口** 安全与交付 | S9 全部通过 + 手动清单逐条签字 | S9 / S10 |

### 7. 交付物清单

11. 代码：`packages/server/src/services/browser/**`、
    `packages/client/src/components/hermes/chat/browser/**`、相关 api/composable。
12. 文档：`docs/web-agent-browser/**`（含 `security-notes.md`、`delivery-checklist.md`）、
    修订后的 `docs/planning/desktop-agent-browser.md`、更新后的
    `docs/harness/validation.md`。
13. Locale：10 个文件均含新增 key。
14. `AGENTS.md`：新增一条指向 `docs/web-agent-browser/` 的简短入口
    （保持 AGENTS.md 短小，只放指针与最关键的硬规则）。

## Implementation steps

1. 按 §1 的表格逐文件核对是否已存在；缺失的补齐。
2. 建立 `HERMES_BROWSER_TEST=1` 门控的集成测试骨架与 fixture 页面
   （fixture 放 `tests/fixtures/`，跟随既有约定）。
3. 写 e2e spec，复用 `tests/e2e/fixtures.ts` 的 mock 机制。
4. 更新 `docs/harness/validation.md` 与 `AGENTS.md`。
5. 写 `delivery-checklist.md`，包含 §6 的对照表与 §5 的清单（空白待填，作为执行记录）。
6. 全量跑：`npm run harness:check`、`npm run test`、`npm run test:e2e`、`npm run build`。

## Hard rules

- §1 的测试必须在 CI 默认执行且不得 skip。
- 需要真实浏览器的测试必须与 §1 分离并显式门控。
- 交付清单是**执行记录**，不是愿望清单：未实际验证的条目不得勾选。
- 对照表是进度主入口，实现过程中若发现阶段划分需要调整，改这张表而不是改口径。

## Suggested commit message

```
test(web-browser): matrix, CI gates and delivery checklist

- Unit coverage for gate, runtime, CDP protocol, session, automation, URL
  policy, broker contract/lease/descriptor, streaming, input, coordinates,
  panel and security; all run in CI without a real browser.
- HERMES_BROWSER_TEST-gated integration suite against a real Chrome.
- Playwright e2e for surface off/local and desktop regression.
- validation.md, AGENTS.md pointer, and delivery-checklist.md with the
  P0->P4 verification table and manual acceptance record.

Refs: docs/web-agent-browser/spec-10-testing-and-delivery.md
```

## Out of scope

- 性能基准测试（帧率/延迟）——作为后续增强。
- 多平台（Windows/macOS/Linux）CI 矩阵的浏览器安装自动化。

## References

- `docs/harness/validation.md`（校验矩阵）
- `tests/e2e/fixtures.ts`（e2e mock 基建）
- `tests/server/security-policy.test.ts`（现有安全策略测试范式）
- `docs/harness/pr-review.md`（提交前自检清单）
