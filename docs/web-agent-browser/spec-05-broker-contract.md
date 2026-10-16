# Spec 5 — Web Broker（RPC 契约 + 租约 + descriptor）

> Status: blocked on spec-04。**这是分水岭**：本 spec 完成时 Agent 已经能操作浏览器，
> 只是用户还看不见（画面流是 spec-06）。

## Summary

实现一个与 Electron Browser Broker **契约完全一致**的 HTTP RPC 服务，但后端是
spec-03/04 的服务端会话；并向 MCP 层期望的位置写出 descriptor，使
`bin/hermes-studio-mcp.mjs` 无需任何改动即可发现并使用它。

契约来源：`packages/desktop/src/main/browser/browser-broker.ts` 与
`packages/desktop/src/main/browser/browser-types.ts`。**本 spec 的 acceptance 表
就是契约的逐条抄录**，实现时不要"改进"字段名或状态码。

## Dependencies

- spec-04（自动化语义）。
- 不依赖 MCP 层改动——**MCP 层不需要改**。

## Decisions（已定）

1. **descriptor 抢占规则**（唯一的共享资源冲突）：
   - 服务端**仅在 `HERMES_DESKTOP !== 'true'` 时**写
     `join(getWebUiHome(), 'desktop-browser', 'broker.json')`；
   - 桌面模式让 Electron 独占该文件，服务端不写、不删、不覆盖；
   - 若文件已存在且其中的 `desktopPid` 指向一个**存活的非本进程**，服务端**不覆盖**
     并记录一条告警（视为"另一宿主正在提供浏览器"）；
   - 服务端退出时只删除"自己写的"那一份（用 `instanceId` 比对）。
   - 这样做的原因：MCP 层只认这一个路径且不做优先级选择
     （`bin/hermes-studio-mcp.mjs:589`），任何"写第二个文件名"的方案都要改 MCP 层。
2. **不修改 `bin/hermes-studio-mcp.mjs`。** 若实现过程中发现必须改，先回到本 spec
   更新决策记录，不要顺手改。
3. **不抽取与桌面端的共享协议模块**（desktop 与 server 是不同 package，且 desktop
   依赖 electron）。第一版各自实现同一契约，用契约一致性测试守住（acceptance 21）。

## Files

### Create

- `packages/server/src/services/browser/broker-server.ts`
- `packages/server/src/services/browser/broker-lease.ts`
- `packages/server/src/services/browser/broker-descriptor.ts`
- `packages/server/src/services/browser/broker-projections.ts` — `publicTab` / `publicState`
- `tests/server/browser-broker-contract.test.ts`
- `tests/server/browser-broker-lease.test.ts`
- `tests/server/browser-broker-descriptor.test.ts`

### Modify

- 服务端启动/关闭流程（注册 broker 启停，与 spec-02 的 runtime 生命周期协调）

## Acceptance criteria

### 1. HTTP 面

1. `server.listen(0, '127.0.0.1')`（随机端口），endpoint 形如
   `http://127.0.0.1:<port>/v1`。
2. 仅接受 `POST`；仅允许路径 `/v1` 与 `/v1/session`；其他 → `404 { error: 'Not found' }`。
3. 请求带 `origin` 头 → `403 { error: 'Browser origins are not accepted' }`。
4. 响应头 `Content-Type: application/json; charset=utf-8` + `Cache-Control: no-store`。
5. body 上限 1 MB；超限报 `'Request body exceeds 1 MB'`；非对象 body 报
   `'Request body must be an object'`。

### 2. 鉴权

6. `POST /v1/session`：header `Authorization: Bearer <descriptor.token>`；
   校验失败 → `401 { error: 'Unauthorized' }`；成功 → `{ client_id, session_token }`。
   - `client_id = randomUUID()`；`session_token = randomBytes(32).toString('base64url')`；
   - 可选 body 字段 `client_pid`（正整数校验）与 `client`（MCP 传入的客户端标识）。
7. `POST /v1`：必须同时满足 `Authorization: Bearer <session_token>` **和**
   header `X-Hermes-Browser-Client: <client_id>`（`x-hermes-browser-client`，
   截取前 200 字符）；否则 `401`。
8. 常量时间字符串比较（`timingSafeEqual`，长度先比）。

### 3. 请求/响应体

9. 请求体：`{ method, params, operation_id, run_metadata?, client_pid? }`
   （`client_pid` 仅注册时使用）。
10. 成功响应：`{ operation_id, result }`；错误响应：`{ error: <string> }`。
11. 状态码映射：错误消息匹配 `/lease|control|cancel|takeover/i` → **409**；
    其余业务错误 → **400**；另有 401/403/404（见上）。

### 4. RPC method 清单（必须全部实现，命名逐字一致）

| method | params | result |
|---|---|---|
| `state` | — | `publicState()` |
| `tabs.list` | — | `publicState()` |
| `tabs.create` | `url`(默认 `about:blank`), `activate`(默认 true) | `publicTab` |
| `tabs.activate` | `tab_id`(required) | `publicState()` |
| `tabs.close` | `tab_id`(required) | `publicState()`（并清理该 tab 租约） |
| `navigate` | `tab_id`, `url`(required) | `publicTab` |
| `navigation.action` | `tab_id`, `action` ∈ `back\|forward\|reload\|stop` | `publicTab` |
| `snapshot` | `tab_id`(required) | `BrowserSnapshot` |
| `text.read` | `tab_id`, `snapshot_id`, `ref`, `mode`, `offset`, `limit` | `BrowserReadTextResult` |
| `interact` | `tab_id`, `action`(对象) | `publicTab` |
| `screenshot` | `tab_id`, `full_page`(`=== true` 才为真) | `BrowserScreenshot` |
| `console.read` | `tab_id` | `BrowserConsoleEntry[]` |
| `console.clear` | `tab_id` | `{ ok: true }` |
| `lease.release` | `tab_id` | `{ ok: true }` |
| 其他 | — | throw `Unknown Browser Broker method: ${method}` |

12. 参数校验风格与桌面端一致：手写校验（`asObject` / `requiredString` /
    `boundedInteger`），**不引入 zod 或 JSON Schema**。
    - 必填字符串：trim 后非空且 ≤ 4096，否则 `${name} is required`；
    - 有界整数：非安全整数或越界 → `${name} must be an integer between ${min} and ${max}`。

### 5. 投影（不得泄漏）

13. `publicTab` 只返回：
    `{ id, title, url, loading, canGoBack, canGoForward, crashed, agentControl }`
    - `title` 截断 500；
    - `url` 必须经过 `publicBrowserUrl()` 脱敏；
    - **禁止**返回 `faviconUrl`、`profileId`、`agentLabel`、`agentAction`、
      `sessionPath`、`downloadPath`、任何 CDP/DevTools URL。
14. `publicState` 返回 `{ activeTabId, maxTabs, tabs: publicTab[] }`；`maxTabs` = 8。

### 6. 租约

15. 租约表 `Map<tabId, { clientId, expiresAt }>`；`LEASE_TTL_MS = 60_000`；
    到期回收定时器在 `LEASE_TTL_MS + 25` 后触发，并撤销 `agentControl`。
16. **mutating 判定**：`!['state','tabs.list','console.read'].includes(method)`。
    仅当命令为 mutating 且带 `tab_id` 时才 claim 租约，并把该 tab 的
    `agentControl` 置为 `active`（`agentLabel` 取 `clientId.slice(0,24)`）。
17. claim 冲突：若存在未过期租约且属于其他 client →
    原 owner 进程仍存活则抛错，错误文案逐字为
    `Browser tab is controlled by another MCP client; user takeover is required before ${method}`
    （该文案会被状态码映射为 409；MCP 侧依赖它可以给出可操作的提示）；
    原 owner 进程已死则视为 stale 并接管。
18. 进程存活判定：`process.kill(pid, 0)`，`EPERM` 视为存活，无 pid 视为存活。
19. `lease.release`：非本人租约 → 抛
    `Browser tab lease belongs to another MCP client`。
20. client 清理：24 小时未活跃的 client 记录删除（含其租约）。
21. **abort / 接管**：`revokeTab(tabId)` 递增该 tab 的 generation、清理租约与定时器、
    取消其进行中的自动化操作；`execute` 前后比对 generation，一旦变化抛
    `Browser operation was cancelled by user takeover`（同样映射 409）。

### 7. 并发

22. 全局并发上限 4（`activeOperations >= 4` 时排队）；同一 tab 串行执行，
    不同 tab 可并发。

### 8. descriptor

23. 写入 `join(getWebUiHome(), 'desktop-browser', 'broker.json')`
    （目录不存在则创建），内容：

    ```json
    { "schema": 1, "protocol": "http:", "endpoint": "http://127.0.0.1:<port>/v1",
      "token": "<base64url>", "desktopPid": <服务端 pid>,
      "instanceId": "<random>", "createdAt": "<iso>" }
    ```

    - 文件权限 owner-only（非 win32 时 `0o600`，目录 `0o700`）——
      MCP 侧会校验 `(mode & 0o077) !== 0` 并抛 `unsafe descriptor permissions`
      （`bin/hermes-studio-mcp.mjs:592-594`）；
    - `token` 每次启动重新生成（`randomBytes(32).toString('base64url')`）；
    - 抢占规则见 §Decisions 1；
    - 退出时删除自己写的那一份。

### 9. 契约一致性测试

24. `browser-broker-contract.test.ts` 必须对**同一组 fixture 请求**断言
    Web Broker 与桌面 Broker 的响应形状一致：
    - 至少覆盖：鉴权失败、未知 method、`state` 投影字段集合、
      `snapshot` 字段名（尤其 `snapshotId` 驼峰）、`screenshot.mediaType`、
      lease 冲突文案与 409。
    - fixture 以共享的 JSON 期望文件形式存在，两个 broker 的测试都读它，
      这样桌面端契约变化时会立刻打破 Web 端测试（这是本 spec 唯一能防"契约漂移"
      的手段）。

## Implementation steps

1. 通读 `browser-broker.ts`（214-277 的 method switch、288-308 的投影、
    310-372 的租约、143-207 的 takeover/abort、38-60 的校验工具、390-416 的并发与 body 限制），
    **逐条对照**写实现；不要用"更现代"的写法替换手写校验。
2. 先实现 `broker-projections.ts` 与校验工具，再实现 lease，最后接 HTTP 层
   （HTTP 层只做解析/鉴权/分发）。
3. 接 spec-04 的自动化层，注意 `execute` 前后 generation 比对的位置。
4. 实现 descriptor 读写与抢占规则，并写权限测试（非 win32 断言 `0o600`）。
5. 写契约一致性 fixture，让桌面端与 Web 端测试都消费它。
   - 桌面端已有测试若不存在对应文件，新增一个**只读 fixture 的测试**即可，
     不改动桌面端实现。
6. 端到端自测（本机，手动）：写入 descriptor → 运行
   `node bin/hermes-studio-mcp.mjs browser` → 通过 MCP 协议调 `tools/list`，
   确认能看到 `hermes_studio_browser_toolset`；调 `tabs.create` 打开
   `about:blank` 并 `snapshot`。**这是本 spec 最重要的手动验收**。

## Hard rules

- 契约字段名、状态码、错误文案逐字一致；不要"优化"成更规范的名字。
- 不改 `bin/hermes-studio-mcp.mjs`。
- 不返回任何 CDP/DevTools/路径类字段。
- descriptor 只在非桌面模式写；不覆盖他人存活的 descriptor。
- 租约必须真正串行化：同一 tab 不允许两个 client 同时 mutating。
- HTTP 层保持薄：解析、鉴权、分发，业务在 service。

## Suggested commit message

```
feat(web-browser): Web Browser Broker implementing the desktop RPC contract

- Same HTTP surface as the Electron broker: POST /v1 and /v1/session,
  Bearer + X-Hermes-Browser-Client auth, { operation_id, result } and
  { error } envelopes, 409 mapping for lease/control/cancel/takeover.
- Full method set: state, tabs.*, navigate, navigation.action, snapshot,
  text.read, interact, screenshot, console.*, lease.release.
- Lease lifecycle with TTL, stale-owner takeover, generation-based abort.
- Projections drop favicon/profile/agent/CDP fields.
- Writes the browser broker descriptor only outside HERMES_DESKTOP, owner-only,
  never overwriting a live foreign descriptor.
- Contract-parity fixtures shared with the desktop broker tests.

Refs: docs/web-agent-browser/spec-05-broker-contract.md
```

## Out of scope

- 画面流与客户端面板（spec-06 / spec-07）。
- 用户接管的具体 UI 动作（spec-08），但本 spec 必须提供 `revokeTab` 入口供其调用。
- 把协议层抽成 desktop/server 共享模块（见 §Decisions 3）。

## References

- `packages/desktop/src/main/browser/browser-broker.ts`（契约全文）
- `packages/desktop/src/main/browser/browser-types.ts:89-197`
- `bin/hermes-studio-mcp.mjs:587-643,890-952,1764-1776`
- `packages/server/src/services/ekko-agent/mcp.ts:7-12,95-104`（browser 已无条件注入）
- `docs/planning/desktop-agent-browser.md:290-306`（租约与调用者身份设计）
