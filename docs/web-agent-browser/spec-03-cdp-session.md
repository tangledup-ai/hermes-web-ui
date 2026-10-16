# Spec 3 — CDP 客户端与会话模型

> Status: blocked on spec-02。

## Summary

实现一个最小、自持的 CDP（Chrome DevTools Protocol）客户端，运行在 spec-02 交付的
pipe 流之上；在其上建立 **BrowserSession** 对象模型（tab / target / 会话隔离 / 回收），
供 spec-04 做页面操作、spec-05 暴露为 Broker、spec-06 取画面帧。

## Dependencies

- spec-02（pipe 流与进程生命周期）。

## Decisions（已定）

1. **零新依赖**：不引入 `chrome-remote-interface`、`ws`、`puppeteer-core`。
   pipe 上的 CDP 是 `\0` 分隔的 JSON 消息，用 `node:stream` 手写即可。
2. **不使用扁平化以外的 session 模型**：统一采用
   `Target.attachToTarget({ flatten: true })`，所有命令带上 `sessionId`。
3. **一个 BrowserSession 对应一个独立 browser context**（
   `Target.createBrowserContext`），从而天然获得 Cookie/存储隔离，不需要额外的
   Profile 概念。

## Files

### Create

- `packages/server/src/services/browser/cdp-client.ts` — 协议层
- `packages/server/src/services/browser/cdp-types.ts` — 用到的 CDP 命令/事件类型
- `packages/server/src/services/browser/session.ts` — BrowserSession / BrowserTab
- `tests/server/cdp-client.test.ts`
- `tests/server/browser-session.test.ts`

## Acceptance criteria

### 协议层（`cdp-client.ts`）

1. **消息帧**：写入 pipe 的每条消息为 `JSON.stringify(payload) + '\0'`；读取时按
   `\0` 切分（**必须处理跨 chunk 的部分消息**，即维护缓冲，不能假设一条 chunk
   等于一条消息）。该行为有专门测试。
2. **请求/响应**：`send(method, params, sessionId?)` 返回 Promise；内部维护自增
   `id`，用 `id` 匹配响应；CDP 返回的 `error` 必须**拒绝**该 Promise 并保留
   `code` / `message`（不要吞掉）。
3. **事件**：`on(eventName, handler)` 订阅 CDP 事件，事件需按 `sessionId` 归属；
   提供 `off`/`dispose`，dispose 后不得残留监听与定时器。
4. **超时**：每个命令有超时（建议 30s，可通过参数覆盖），超时后 reject 并清理
   pending 记录；不得泄漏 `id` 映射。
5. **管道关闭/进程退出**：所有 pending 请求必须以明确错误 reject（而非挂死）。
6. 不得在日志中输出 CDP 原始消息体（只允许 method 名与耗时）。

### 会话层（`session.ts`）

7. `BrowserSession` 生命周期：`create()` → `Target.createBrowserContext` →
   `dispose()` → `Target.disposeBrowserContext`，并确保 context 内的所有 target 被关闭。
8. `BrowserTab` 对象模型，字段至少包含（与桌面端 `DesktopBrowserTab` 语义对齐，
   `packages/desktop/src/main/browser/browser-types.ts`）：

   | 字段 | 来源 |
   |---|---|
   | `id` | `Target.targetId`（对外即 `tab_id`） |
   | `url` / `title` | `Page.frameNavigated` / `Target.targetInfoChanged` |
   | `loading` | `Page.frameStartedLoading` / `Page.loadEventFired` |
   | `canGoBack` / `canGoForward` | `Page.getNavigationHistory` |
   | `crashed` | `Inspector.targetCrashed` / target destroyed |

9. **tab 上限**：单会话最多 8 个（对齐 `desktop-agent-browser.md:410`）。
   超限时返回明确错误，文案需与桌面端一致以免客户端分支分叉。
10. **会话回收**：空闲 TTL（建议 30 min，可配置）+ 全局并发上限（建议 4，
    对齐 Electron Broker 的硬编码 4）。回收必须 kill 对应 browser context，
    且不得影响其他会话。
11. **会话隔离测试**：两个会话登录/写入 localStorage 后，断言互不可见
    （该测试可用 `document.cookie` / `localStorage` 通过 spec-04 暴露的固定脚本完成，
    或在 spec-10 的集成测试里做）。
12. **target 发现**：必须处理"新开 tab 产生的 target"与"target 被页面关闭"两个方向，
    保证 tab 列表不挂死、不残留。

## Implementation steps

1. 先写 `cdp-client.ts` 的协议层并配单测：用一个内存 duplex 流（
   `new Duplex({ read, write })`）模拟 pipe，断言对象/乱序/分片/超时/错误路径。
   **这一步不需要真实 Chrome**，应当是纯单测。
2. 定义 `cdp-types.ts` 中实际用到的 CDP 域：`Target`、`Page`、`Runtime`、
   `DOM`、`Accessibility`、`Input`、`Network`、`Inspector`（只声明用到的字段，
   不要全文照抄 schema）。
3. 实现 `session.ts`，在上层暴露 `createTab` / `closeTab` / `listTabs` /
   `activeTab` / `dispose`。注意 `tab_id` 对外必须是 `Target.targetId` 字符串，
   不做额外映射（便于与桌面端契约一致）。
4. 接入 spec-02 的 `HeadlessRuntime.cdpStreams()`，把协议层与进程层解耦
   （协议层只依赖两个流，便于测试）。
5. 写 `tests/server/browser-session.test.ts`，用注入的假 CDP 客户端断言：
   tab 上限、回收、隔离、dispose 幂等。
6. 真实 Chrome 的会话测试放 spec-10，用 `HERMES_BROWSER_TEST=1` 门控。

## Hard rules

- 不依赖任何 CDP/浏览器库（D1）。
- 不暴露 `Runtime.evaluate` 的任意表达式入口（spec-04 会用固定脚本，见其 hard rules）。
- 所有 `id` 映射、监听器、定时器必须在错误与 dispose 路径上清理干净。
- 会话隔离必须靠 browser context，不得靠"清 Cookie"这类软隔离。
- 对外 `tab_id` 直接使用 CDP `targetId`，不自造映射表。

## Suggested commit message

```
feat(web-browser): minimal CDP client and browser session model

- CDP over --remote-debugging-pipe: null-delimited JSON, request/response
  id matching, per-session events, command timeouts, clean disposal.
- BrowserSession per browser context (real cookie/storage isolation),
  BrowserTab model aligned with the desktop DesktopBrowserTab semantics.
- 8-tab cap, idle TTL and global concurrency caps, target discovery both ways.
- Zero new dependencies: no ws, no puppeteer, no CDP library.

Refs: docs/web-agent-browser/spec-03-cdp-session.md
```

## Out of scope

- 页面操作语义（snapshot / interact / screenshot）：spec-04。
- RPC 契约与租约：spec-05。
- 画面帧：spec-06。

## References

- `packages/desktop/src/main/browser/browser-manager.ts`（tab 模型与 target 管理对照）
- `packages/desktop/src/main/browser/browser-types.ts:89-197`（快照/交互类型形状）
- `docs/planning/desktop-agent-browser.md:393-418`（标签页模型与上限）
- CDP 域：`Target`、`Page`、`Runtime`、`DOM`、`Accessibility`、`Input`、`Network`
