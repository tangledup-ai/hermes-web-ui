# Spec 7 — 客户端浏览器面板

> Status: blocked on spec-06。

## Summary

在 Web UI 里提供用户可见的浏览器面板：地址栏、标签条、画面区、导航按钮、状态指示。
形态复用桌面端 `DesktopBrowserPanel.vue` 的结构，但渲染层换成 **canvas 播放器**
（消费 spec-06 的帧），并放开 `ChatPanel.vue` 里那个把 browser Tab 挡在桌面端之后的 gate。

## Dependencies

- spec-06（帧通道与 `state` 事件）。
- spec-01（`/api/browser/*` 的 gate 查询接口，用于前端判断是否显示 Tab）。

## Decisions（已定）

1. **不用 iframe 承载网页。** 画面是自绘 canvas，因此不需要 `frame-src` /
   `frame-ancestors` 例外，`packages/server/src/security.ts` 保持不变。
   任何"用 iframe 显示网页"的改动都属于本 spec 的失败。
2. **UI 结构复用而非复制**：优先把 `DesktopBrowserPanel.vue` 里的
   "标签条 + 地址栏 + 画面占位 + 状态区"抽成共享子组件或统一 surface adapter；
   若抽取代价过高，允许新建 `WebBrowserPanel.vue` 但**必须保持 DOM 结构与类名一致**，
   以便后续统一。
3. **第一版不做**：Profile 选择器、下载入口、权限面板、批注（见 Out of scope）。
   这些控件在 Web 面板里不渲染，而不是渲染成禁用态。
4. **受众是用户 PC 侧，不是设备小屏。** 目标设备自带屏只有 **320×200**
   （实测 kiosk chromium `--window-size=320,200`），在这个宽度里嵌一个浏览器画面
   没有可用性可言。因此：
   - 面板必须在**窄容器（建议 ≤ 400px）下自动退化**为"不渲染画面，只显示状态与
     '请在电脑上打开以查看画面' 提示"，而不是硬挤出一个几十像素宽的画面；
   - 退化判定用**容器宽度**（`ResizeObserver`），不要用 `window.innerWidth`
     （用户 PC 上可能只是把面板拖窄了）；
   - 设备 kiosk 侧**不新增入口**，保持现状（kiosk 仍指向 Web UI 业务页）。

## Files

### Create

- `packages/client/src/components/hermes/chat/WebBrowserPanel.vue`（或等价的 surface 化改造）
- `packages/client/src/components/hermes/chat/browser/BrowserCanvas.vue` — 帧渲染
- `packages/client/src/components/hermes/chat/browser/BrowserToolbar.vue` — 地址栏 + 导航
- `packages/client/src/components/hermes/chat/browser/BrowserTabStrip.vue`
- `packages/client/src/composables/useBrowserSurface.ts` — 能力探测 + socket 生命周期
- `packages/client/src/api/browser.ts` — HTTP 侧（tab 列表/创建/关闭/导航）
- `tests/client/browser-panel.test.ts`

### Modify

- `packages/client/src/components/hermes/chat/ChatPanel.vue:165-166,3948-3982`
  （gate 与 Tab 渲染）
- `packages/client/src/utils/desktop-bridge.ts` 或新增
  `packages/client/src/utils/browser-surface.ts`（Web 侧能力探测）
- 全部 10 个 locale：`packages/client/src/i18n/locales/{en,zh,zh-TW,ja,ko,pt,es,ru,de,fr}.ts`

## Acceptance criteria

### 1. 能力探测与 gate

1. 新增 `webBrowserSurfaceAvailable()`：仅当服务端 `/api/browser/surface`
   （或等价的启动期注入值）返回 `local` 时为真。
   - 探测必须**失败安全**：请求失败 / 超时 / 未登录 → 视为不可用，不显示 Tab。
   - 不得用环境变量、URL 参数或 localStorage 判断（与
     `desktop-agent-browser.md:129` 的原则一致）。
2. `ChatPanel.vue` 的 browser Tab 显示条件从
   `v-if="desktopBrowserAvailable"` 改为
   `v-if="desktopBrowserAvailable || webBrowserSurfaceAvailable"`。
3. 面板组件：

   | 形态 | 渲染 |
   |---|---|
   | 桌面 bridge 可用 | 现有 `DesktopBrowserPanel.vue`（不改行为） |
   | 仅 Web surface 可用 | 新的 Web 面板 |
   | 都不可用 | 不渲染 Tab，也不加载任何面板 chunk |

### 2. 播放器

4. 帧渲染在 `<canvas>` 上：
   - 用 `createImageBitmap` / `Image` 解码 base64；
   - canvas 尺寸按帧的 `deviceWidth`/`deviceHeight` 设置，CSS 尺寸按容器宽度等比缩放；
   - 帧到达时只重绘，不重建 canvas；
   - 连续帧解码必须**串行化**（上一帧解码完成前丢弃新帧），避免小屏设备解码队列堆积。
5. 容器 `ResizeObserver` 检测尺寸变化后重新 `subscribe`（携带新的显示区尺寸），
   以更新 `maxWidth`/`maxHeight`。
6. 面板不可见时（Tab 切走、抽屉关闭、窗口隐藏）必须 `unsubscribe`，
   恢复可见时重新 `subscribe`。**不得在后台持续接收帧**。
7. 断线重连：socket 断开后按退避重连，重连成功后重新 `subscribe` 并拉一次 `state`。

### 3. 工具栏与标签条

8. 地址栏输入 URL 后 Enter → 导航；非法 scheme 或服务端拒绝 → 在面板内显示
   本地化错误（不要静默失败、不要 `alert`）。
9. 导航按钮：后退、前进、刷新、停止；禁用态依据 `canGoBack` / `canGoForward` / `loading`。
10. 标签条：新建、切换、关闭；关闭最后一个 tab 后保持空标签条（与
    `desktop-agent-browser.md:418` 一致）。达到 `maxTabs` 时新建按钮禁用并给出提示。
11. 标题显示 tab 的 `title`（截断），`crashed` 状态要有明确视觉与可恢复动作。

### 4. Agent 活动指示

12. 当 `agentControl === 'active'` 时，在面板上显示"Agent 正在控制"指示
    （形态与桌面端一致），并在 spec-08 提供的"接管"按钮旁给出当前动作占位。
13. `state` 事件驱动的 UI 更新必须走统一的 store/composable，不要在多个组件里
    各自订阅。

### 5. i18n 与样式

14. 所有新增可见文案补齐 10 个 locale 文件；`zh` 为基准，其他文件至少要有
    对应 key（允许先英文兜底，但 key 必须存在——`npm run build` 与既有 i18n
    检查必须通过）。
15. 样式与既有工具面板保持一致：scoped style、跟随主题变量、不引入新的 UI 框架约定
    （AGENTS.md：优先复用 Naive UI 与既有模式）。

## Implementation steps

1. 先读 `DesktopBrowserPanel.vue` 全量结构（尤其 435-470 的模板与
   `syncViewport()` 123-158），判断哪些能直接复用。
   - `syncViewport()` 是给 Electron 原生 View 算 bounds 用的，Web 侧不需要；
     不要在新面板里模拟它。
2. 实现 `useBrowserSurface.ts`：socket 连接、`state` 订阅、`subscribe`/`unsubscribe`
   生命周期、重连退避。把它作为唯一 socket 拥有者。
3. 实现 `BrowserCanvas.vue`，注意 acceptance 4 的串行解码与 acceptance 6 的
   可见性联动。
4. 实现工具栏与标签条（HTTP 调用走 `api/browser.ts`，跟随
   `packages/client/src/api/client.ts` 的既有封装）。
5. 改 `ChatPanel.vue` 的 gate，注意三个形态的分支不要互相干扰，
   并确保桌面端行为零变化（这是回归风险最高的一处）。
6. 补 10 个 locale。
7. 测试（`tests/client/browser-panel.test.ts`）：探测失败安全、gate 三分支、
   canvas 串行解码、不可见时 unsubscribe。e2e 覆盖见 spec-10。

## Hard rules

- **不得使用 iframe/webview 渲染网页内容**。
- 不得修改 `packages/server/src/security.ts`。
- 桌面端面板行为不得改变（回归风险最高点）。
- 探测失败必须安全降级为"不可用"。
- 后台不得持续接收帧。
- 新增文案必须进全部 10 个 locale 文件。

## Suggested commit message

```
feat(web-browser): client browser panel with canvas screencast player

- New Web browser panel: canvas frame player, toolbar, tab strip, agent
  activity indicator; reuses the desktop panel structure and classes.
- ChatPanel gate widened to desktop bridge OR web surface; probe fails safe
  and nothing loads when unavailable.
- Socket lifecycle: subscribe only while visible, serialized frame decoding,
  backoff reconnect, unsubscribe on hide.
- Locale entries for all ten locales.

Refs: docs/web-agent-browser/spec-07-client-panel.md
```

## Out of scope

- 输入转发与接管按钮的实际行为（spec-08）。
- Profile / 下载 / 站点权限面板。
- 元素框选批注与截图标注。
- 把桌面面板与 Web 面板彻底合并为一个组件（本 spec 只要求结构一致）。

## References

- `packages/client/src/components/hermes/chat/DesktopBrowserPanel.vue`
- `packages/client/src/components/hermes/chat/ChatPanel.vue:165-166,3948-3982`
- `packages/client/src/utils/desktop-bridge.ts:141-155`（能力探测范式）
- `packages/client/src/components/hermes/files/HtmlFilePreview.vue`（对照：为什么本方案不用 iframe）
- `docs/planning/desktop-agent-browser.md:511-546`（桌面端的 Tab 与 gate 写法）
