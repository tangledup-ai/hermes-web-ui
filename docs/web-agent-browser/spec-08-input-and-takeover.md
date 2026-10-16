# Spec 8 — 输入转发与接管

> Status: blocked on spec-06（帧通道与 metadata 契约冻结后）。

## Summary

让用户能在 Web 面板里直接操作页面（鼠标、键盘、滚轮、输入法），并实现"接管"：
用户点击接管会中止 Agent 当前操作、释放租约，之后用户输入为权威输入。

## Dependencies

- spec-06（帧与 metadata；坐标换算依赖帧上携带的
  `deviceWidth/deviceHeight/pageScaleFactor/scrollOffset*`）。
- spec-05 的 `revokeTab` 入口（接管的服务端动作）。

## Decisions（已定）

1. **接管必须是显式动作**，不做"用户一碰页面就自动接管"（桌面端
   `desktop-agent-browser.md:648-655` 第一版同样是显式接管）。
2. **不允许 Agent 输入与用户输入静默竞争**：同一 tab 一旦处于 Agent 租约中，
   用户输入要么先接管、要么被拒绝并提示。
3. **输入走 Socket.IO 上行**（与 spec-06 同一 namespace），不新开 HTTP 轮询。

## Files

### Create

- `packages/server/src/services/browser/input-relay.ts` — 上行事件 → CDP Input 命令
- `packages/client/src/components/hermes/chat/browser/BrowserInputLayer.vue` — 透明输入层
- `packages/client/src/utils/browser-coordinates.ts` — 坐标换算（纯函数，可单测）
- `tests/server/browser-input-relay.test.ts`
- `tests/client/browser-coordinates.test.ts`

### Modify

- `packages/server/src/services/browser/stream-server.ts`（新增上行事件处理）
- `packages/client/src/components/hermes/chat/browser/BrowserCanvas.vue`（挂载输入层）
- locale 文件（接管相关文案，"接管"按钮与状态提示）

## Acceptance criteria

### 1. 坐标换算（纯函数）

1. `browser-coordinates.ts` 导出 `toViewportPoint(input, frameMeta, displaySize)`，
   完成三段换算：**显示区 CSS 像素 → 帧像素 → 页面视口 CSS 像素**，
   考虑：帧与视口的尺寸差（`deviceWidth/deviceHeight` 是视口尺寸）、
   `pageScaleFactor`、canvas CSS 缩放比。
2. 该函数必须有针对性单测，至少覆盖：
   - 非整数缩放（如容器宽度 / 视口宽度 = 0.7321）；
   - `pageScaleFactor !== 1`；
   - 边界点击（0,0 与右下角）；
   - 输入坐标为负或超出容器 → 夹紧到合法范围而不是发出非法坐标。
   **这是最容易出"点歪"的地方，测试必须真实存在。**

### 2. 鼠标与滚轮

3. 上行事件（Socket.IO，与 spec-06 同 namespace）：

   | 事件 | payload |
   |---|---|
   | `input.mouse` | `{ tabId, type: 'move'\|'down'\|'up', x, y, button: 'left'\|'right'\|'middle', clickCount?, modifiers?, buttons? }` |
   | `input.wheel` | `{ tabId, x, y, deltaX, deltaY }` |

4. 服务端转成 `Input.dispatchMouseEvent`：
   - `move` 需要正确的 `buttons` 位掩码（拖拽时必须非 0，否则拖不动）；
   - `down`/`up` 需要 `clickCount`（双击/三击行为依赖它）；
   - `wheel` 用 `type:'mouseWheel'` 并透传 `deltaX`/`deltaY`。
5. `modifiers` 位掩码（Alt/Ctrl/Meta/Shift）必须正确传递，否则快捷键全部失效。

### 3. 键盘与输入法

6. 上行事件：

   | 事件 | payload |
   |---|---|
   | `input.key` | `{ tabId, type: 'down'\|'up', key, code, text? , modifiers? }` |
   | `input.insertText` | `{ tabId, text }` |

7. 实现要求：
   - 常规字符走 `Input.dispatchKeyEvent`（`keyDown`/`keyUp` + `text`）；
   - **中文/日文/emoji 等通过输入法产出的文本必须走 `Input.insertText`**，
     直接发 key 事件会丢字（与 spec-04 的 `type` 动作同一策略）；
   - 组合键（Ctrl/Cmd + 键）必须带 `modifiers`；
   - 特殊键（`Enter`、`Tab`、方向键、`Escape`）需要正确的 `code`/`windowsVirtualKeyCode`。
8. 前端在 `BrowserInputLayer` 上监听 `keydown`/`keyup`/`compositionstart`/`compositionend`，
   组合输入期间不得逐字发 key 事件，`compositionend` 后发一次 `insertText`。
9. **前端键盘焦点**：面板获得焦点时，`Enter`/`Tab`/`Space` 等不得冒泡触发 Chat 面板的
   发送/切换行为（这是实际使用中最容易被发现的回归）。

### 4. 接管

10. 前端"接管"按钮 → 上行 `takeover { tabId }`。
11. 服务端处理顺序（严格）：
    1. 调 spec-05 的 `revokeTab(tabId)`：递增 generation、清租约、取消 Agent 进行中的操作；
    2. 向该 tab 的所有订阅者广播 `state`（`agentControl` 变为 `idle`）；
    3. 回执成功。
12. 接管后：
    - Agent 的下一次 mutating 调用得到 409 + 既有文案
      （`Browser tab is controlled by another MCP client; ...`）——
      这对 Agent 是**可恢复**的：它可以提示用户或换 tab；
    - 用户输入成为权威输入。
13. **未接管时的用户输入**：若该 tab 存在活跃 Agent 租约，用户输入**不得**静默生效。
    行为二选一，必须固定并在 UI 上可见：
    - (a) 拒绝并把面板切到"Agent 控制中，点击接管以操作"的状态；**（推荐，本 spec 采用）**
    - (b) 自动接管。
    采用 (a)：服务端对 `input.*` 在存在他人租约时返回 `error`，前端据此显示接管提示。
14. 前端状态机：`idle`（用户可操作）/ `agent-active`（只读，显示接管按钮）/
    `taking-over`（过渡）。三个状态都要有可见 UI，不得出现"说不清谁在控制"的中间态。

### 5. 安全与限流

15. `input.*` 属于 mutating 行为：必须经过租约判定（acceptance 13），
    并受 spec-05 的全局并发限制约束。
16. 上行事件做基本校验：坐标必须是有限数、`tabId` 必须属于当前会话、
    `text` 长度设上限（建议 10 000 字符）。
17. **不得**通过输入层提供剪贴板读取、文件选择或任何非输入类能力。

## Implementation steps

1. 先写 `browser-coordinates.ts` + 单测。**在写 UI 之前完成**，因为这是错误的唯一来源。
2. 服务端在 `stream-server.ts` 里加入 `input.*` 与 `takeover` 处理，
   租约判定复用 spec-05 的逻辑（不要在 UI 层做权限判断）。
3. 实现 `BrowserInputLayer.vue`：
   - 绝对定位覆盖 canvas 的透明层，`tabindex="0"`；
   - 捕获 `mousedown/mousemove/mouseup/wheel/keydown/keyup/composition*`；
   - 阻止会冒泡到外层的快捷键（acceptance 9）；
   - 高 DPI 下用 `getBoundingClientRect()` 而非固定尺寸做换算。
4. 在 `BrowserCanvas.vue` 里挂载输入层，并绑定"接管"按钮到状态机。
5. 测试：
   - 坐标换算单测（acceptance 2）；
   - 服务端：租约存在时 `input.*` 被拒、接管后放行、组合键 modifiers 正确、
     `insertText` 被正确转发；
   - 前端：键盘事件不冒泡、状态机三分支。
6. 手动验收：接管后拖动滚动条、输入中文搜索、按 Ctrl+A、打开下拉菜单（验证
   `buttons` 掩码与 `clickCount`）。

## Hard rules

- 显式接管，不自动抢占。
- 同一 tab 不允许用户与 Agent 静默竞争输入。
- 组合输入必须走 `insertText`，不得逐字发 key 事件。
- 坐标换算必须是独立纯函数并带单测；不得在组件里内联手算。
- 不通过输入层暴露剪贴板/文件/其它非输入能力。
- 键盘事件不得冒泡到 Chat 面板导致误发送。

## Suggested commit message

```
feat(web-browser): input forwarding and explicit takeover

- Coordinate mapping as a tested pure function (display -> frame -> viewport)
  including pageScaleFactor and fractional scaling.
- Mouse/wheel/key events relayed to CDP Input with correct buttons/modifiers/
  clickCount; IME text via Input.insertText.
- Explicit takeover: revoke the agent lease, cancel the in-flight operation,
  broadcast state; user input is refused (and surfaced) while an agent holds
  the lease.
- Keyboard events do not bubble into the chat composer.

Refs: docs/web-agent-browser/spec-08-input-and-takeover.md
```

## Out of scope

- 元素框选批注与"点击页面元素进行批注"（桌面端 §13）。
- 移动端触控手势（第一版按桌面视口与鼠标键盘处理）。
- 剪贴板双向同步。

## References

- `docs/planning/desktop-agent-browser.md:635-655`（接管流程）、`:290-306`（租约）
- `packages/desktop/src/main/browser/browser-takeover` 相关逻辑（`browser-broker.ts:143-207`）
- spec-06（帧 metadata 字段名）、spec-04（`interact` 的输入策略）
