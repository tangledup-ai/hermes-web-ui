# Spec 4 — 自动化语义层

> Status: blocked on spec-03。

## Summary

把 CDP 的原始命令封装成 Agent 与客户端都需要的一组**语义化操作**：
紧凑快照 + 稳定元素引用、点击/输入/按键/滚动、文本分页读取、控制台读取、截图。
这一层的输出形状必须与 Electron 端
`packages/desktop/src/main/browser/browser-automation.ts` 的语义一致，
因为 spec-05 要把它原样作为 Broker 的 `result` 返回。

## Dependencies

- spec-03（CDP 客户端与会话）。

## Files

### Create

- `packages/server/src/services/browser/automation.ts`
- `packages/server/src/services/browser/snapshot.ts`
- `packages/server/src/services/browser/element-script.ts` — 固定的页面内脚本（字符串常量）
- `packages/server/src/services/browser/url-policy.ts` — URL 规范化与拒绝（spec-09 复用）
- `tests/server/browser-automation.test.ts`
- `tests/server/browser-snapshot.test.ts`
- `tests/server/browser-url-policy.test.ts`

## Acceptance criteria

### 1. 快照与元素引用

1. `snapshot(tabId)` 返回：

   ```ts
   { tabId, snapshotId, url, title, nodes: BrowserSnapshotNode[], text }
   interface BrowserSnapshotNode { ref, role, name, value?, description?, disabled?, focused? }
   ```

   字段名与 `packages/desktop/src/main/browser/browser-types.ts:89-106`
   完全一致（`snapshotId` 用 camelCase 出现在 `result` 里，注意与 RPC 请求参数
   `snapshot_id` 的下划线风格不同——这是既有契约，必须照抄）。
2. 引用格式为 `@e1`、`@e2`…（与 `packages/ekko-agent/src/tools/browser.ts:68-70`
   的描述一致），指向该次快照内的元素。
3. `snapshotId` 每次生成新值；**页面结构变化后旧 ref 必须失效**：使用旧
   `snapshot_id` 的 `interact` 必须返回明确错误（文案需说明需重新快照），
   不得"尽力猜一个元素"。
4. 快照只包含可交互/可读节点，`text` 为页面可见文本的**截断**版本（给模型看），
   Agent 需要完整文本时用 `text.read`。
5. 节点元数据**禁止**包含：input 的 value（若为密码或其他敏感输入）、隐藏文本、
   `dataset`、事件处理源码、Cookie/Header/Storage。与
   `desktop-agent-browser.md:743-751` 的限制一致。

### 2. 交互

6. `interact` 支持四种动作，参数形状与 `browser-types.ts:192-197` 一致：

   | action | 参数 | 实现要点 |
   |---|---|---|
   | `click` | `ref`, `snapshot_id` | 解析 ref → 元素中心坐标 → `Input.dispatchMouseEvent`（move + down + up），并处理元素在视口外时先 `scrollIntoView` |
   | `type` | `ref`, `snapshot_id`, `text` | 聚焦元素 → **清空原值** → `Input.insertText`（而非逐字符 `dispatchKeyEvent`，以正确处理中文/emoji 输入法） |
   | `press` | `key` | 支持单键（`Enter`）与组合（`Meta+K`、`Control+Shift+A`）→ 解析修饰键 → `Input.dispatchKeyEvent`（`keyDown`/`keyUp`，必要时 `rawKeyDown`） |
   | `scroll` | `direction`（`up`/`down`/`left`/`right`），`pixels?` | `Input.dispatchMouseEvent({ type:'mouseWheel' })`；缺省 `pixels` = 500（对齐 `browser.ts:33` 的 `SCROLL_PIXELS`） |

7. 所有交互成功返回更新后的 `publicTab`（见 spec-05 §投影）。
8. 元素解析必须用 spec-03 的固定脚本机制（`element-script.ts`），
   **不接受任何来自调用方的选择器或 JavaScript**。

### 3. 文本读取

9. `text.read` 返回（与 `browser-types.ts:121-133` 一致）：

   ```ts
   { tabId, snapshotId, ref, mode: 'innerText'|'textContent', offset, limit,
     text, totalLength, returnedLength, hasMore, nextOffset? }
   ```

   - `mode` 默认 `innerText`；`offset` 默认 0；`limit` 默认 4000，上限 20000；
   - 越界 `offset` → 返回空 `text` 且 `hasMore:false`，不抛错；
   - `nextOffset` 仅在 `hasMore` 为真时出现。

### 4. 控制台

10. `console.read` 返回 `BrowserConsoleEntry[]`：
    `{ level, message, sourceId, line, timestamp }`，与 `browser-types.ts:145-151` 一致。
    - 数据来源：`Runtime.consoleAPICalled` + `Runtime.exceptionThrown`；
    - `message` 截断 2000 字符；
    - `sourceId` 必须经 URL 脱敏（`url-policy.ts` 的 public 投影），不得泄漏查询串中的敏感参数；
    - 缓冲区有上限（建议 500 条），超出丢弃最旧。
11. `console.clear` 返回 `{ ok: true }`。

### 5. 截图

12. `screenshot(tabId, fullPage)` 返回（与 `browser-types.ts:135-143` 一致）：

    ```ts
    { tabId, url, title, mediaType: 'image/png'|'image/jpeg', data: <base64>, width, height }
    ```

    - `fullPage === true` 时用 `Page.captureScreenshot({ captureBeyondViewport: true })`；
    - **`mediaType` 字段名不能改**：MCP 层 `bin/hermes-studio-mcp.mjs:645-656`
      直接读 `screenshot.mediaType` 并映射为 MCP 的 `mimeType`；
    - 截图不落盘；base64 不得进日志、Socket.IO 事件或消息正文
      （`desktop-agent-browser.md:779`）。

### 6. URL 策略

13. `url-policy.ts` 提供两个纯函数（无 IO，便于完整单测）：
    - `normalizeBrowserUrl(input)`：仅允许 `http:` / `https:`，以及内部明确的
      `about:blank`；拒绝 `file:`、`data:`、`javascript:`、`blob:`、`chrome:`、
      `devtools:`、以及任何非标准 scheme；
    - `isBlockedHost(host)`：拒绝 loopback、私网段、link-local、云 metadata
      （完整清单与理由见 spec-09）。
14. 所有导航入口（`navigate`、`tabs.create` 的 `url`、页面内跳转后的复核）
    必须经过这两个函数。**页面重定向后必须再次校验**（防止 302 绕过）。

## Implementation steps

1. 先写 `element-script.ts`：把"在页面里定位节点、读取其矩形、读取可访问性属性"
   做成**代码内固定的字符串脚本**，通过 `Runtime.callFunctionOn` /
   `Accessibility.getFullAXTree` 执行。脚本不得接受外部传入的 JS 源码。
2. 实现 `snapshot.ts`：把 AX tree + DOM 合并成紧凑节点数组，分配 `@eN` 引用，
   生成 `snapshotId`（如 `randomUUID()`），并保存"该 snapshot 的 ref→后端节点句柄"
   映射；页面导航/结构变化时作废映射。
3. 实现 `automation.ts` 的 `click/type/press/scroll/text.read/screenshot/console`。
   参考 `packages/desktop/src/main/browser/browser-automation.ts` 的语义与
   `desktop-agent-browser.md:610-633`（只通过该 tab 自己的会话发命令）。
4. 实现 `url-policy.ts` 与配套单测（含所有被拒 scheme 与 host 类别）。
5. 单测：对自动化层注入假 CDP 客户端，断言发出的 CDP 命令序列
   （例如 `click` 必须发出 move→down→up 且坐标正确）。
6. 快照失效测试：`snapshot` → 导航 → 用旧 `snapshot_id` 的 `interact` 必须失败。

## Hard rules

- **不接受任意 JS**：任何执行链路都不得把调用方传入的字符串当作 JS 求值。
- 不向 Agent 暴露 CDP URL、pipe 句柄、target 细节。
- 敏感元素元数据禁列（见 acceptance 5）。
- 截图 base64 只在内存与 RPC 响应中传递，不落盘、不进日志。
- `mediaType` / `snapshotId` / `snapshot_id` 这些字段名与下划线/驼峰风格必须
  与既有契约逐字一致——这是 MCP 层与桌面端共享的接口。
- 所有导航经过 `url-policy.ts`，重定向后复核。

## Suggested commit message

```
feat(web-browser): automation semantics (snapshot, interact, text, console, screenshot)

- Compact accessibility snapshot with @eN refs and snapshot_id invalidation.
- click/type/press/scroll via CDP Input; type uses Input.insertText for IME.
- text.read pagination, console buffer with URL redaction, screenshot with
  the existing mediaType contract consumed by the MCP layer.
- URL policy: http/https/about:blank only, host blocking, post-redirect check.
- No arbitrary JS execution anywhere in the chain.

Refs: docs/web-agent-browser/spec-04-automation-semantics.md
```

## Out of scope

- 元素框选批注与截图标注（桌面端 §13，Web 版第一版不做）。
- 视觉模型的多 Provider 图片载荷适配（沿用现有 MCP 层逻辑）。
- 下载与文件上传。

## References

- `packages/desktop/src/main/browser/browser-automation.ts`
- `packages/desktop/src/main/browser/browser-types.ts:89-197`
- `bin/hermes-studio-mcp.mjs:645-656,890-952`（工具定义与截图 → MCP Image Content）
- `packages/ekko-agent/src/tools/browser.ts:31-52,68-70,678-708`（超时、ref 语义、安全护栏）
- `docs/planning/desktop-agent-browser.md:610-633,743-751,775-781`
