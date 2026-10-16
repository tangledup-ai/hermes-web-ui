# Spec 6 — 画面流（screencast）

> Status: blocked on spec-05。

## Summary

把 BrowserSession 里活动 tab 的画面以帧的形式推给已认证的前端，并提供 tab 列表、
状态与"停止流"等控制面。使用 CDP 原生 `Page.startScreencast` + Socket.IO namespace。

## Dependencies

- spec-05（Broker 与会话；画面流复用同一个 `BrowserSession`，不是第二个浏览器）。

## Decisions（已定）

1. **通道用 Socket.IO，不用原生 WS 路径。**
   `/socket.io/` 前缀已在 `packages/server/src/index.ts:620-633` 的 upgrade 白名单内，
   原生路径（如 `/ws/browser`）需要改那份白名单，属于多余风险。
2. **namespace 命名 `/browser`**，注册风格照
   `packages/server/src/services/hermes/run-chat/index.ts:233-253`：
   构造函数里 `io.of('/browser')`，`init()` 里 `nsp.use(authMiddleware)` +
   `nsp.on('connection', ...)`；IO 实例来自既有的共享来源
   （`packages/server/src/index.ts` 里 `groupChatServer.getIO()` 的用法）。
3. **帧协议用 CDP 原生格式**，不转码、不二次压缩：
   `Page.startScreencast({ format:'jpeg', quality:60, maxWidth, maxHeight, everyNthFrame:1 })`，
   `screencastFrame` 事件带 base64 + metadata；前端 ack 后服务端调
   `Page.screencastFrameAck`。
4. **观看权限**：任何已认证用户可观看（读操作）；**接管**需要显式动作（spec-08）。
   这与"Agent 与用户看同一个页面"的目标一致，且不引入额外的授权模型。

## Files

### Create

- `packages/server/src/services/browser/stream-server.ts` — Socket.IO namespace
- `packages/server/src/services/browser/screencast.ts` — CDP 侧封装（启停/ack/节流）
- `tests/server/browser-stream.test.ts`

### Modify

- 服务端启动/关闭流程（注册 stream server；跟随 spec-02/05 的注册位置）

## Acceptance criteria

### 1. namespace 与鉴权

1. namespace 为 `/browser`；连接时必须经过与现有 namespace 相同的鉴权中间件
   （复用既有实现，不要另写一套 token 解析）。
2. 鉴权失败 → 拒绝连接并给出明确 error；不得建立"半连接"再去校验。
3. `browserSurfaceMode() === 'off'` 时**不注册**该 namespace（spec-01 的 gate 语义：
   不是注册后返回 403）。

### 2. 订阅与帧下发

4. 客户端事件：

   | 事件 | payload | 说明 |
   |---|---|---|
   | `subscribe` | `{ tabId }` | 开始接收该 tab 的帧 |
   | `unsubscribe` | `{ tabId }` | 停止接收 |
   | `frameAck` | `{ tabId, sessionId }` | 对应 CDP 的 screencast ack |

5. 服务端事件：

   | 事件 | payload |
   |---|---|
   | `frame` | `{ tabId, data(base64 jpeg), metadata: { offsetTop, pageScaleFactor, deviceWidth, deviceHeight, scrollOffsetX, scrollOffsetY, timestamp? } }` |
   | `state` | `publicState()`（复用 spec-05 的投影函数，不要另写一份） |
   | `error` | `{ message }` |

6. **必须 ack 后才会收到下一帧**（CDP 语义）；服务端在客户端未 ack 时不得继续发送，
   以防内存堆积。未收到 ack 超过 2s 视为客户端掉线，停止该 tab 的只读流。
7. **每帧都必须经过 metadata**：spec-07/08 要用 `deviceWidth/deviceHeight` 与
   `pageScaleFactor` 做坐标换算，缺字段会导致点击偏移。
8. **多订阅者**：同一 tab 允许多个 socket 订阅；服务端只对该 tab 维持**一条**
   `startScreencast`，帧扇出给所有订阅者（避免 N 倍 CDP 负载）。
9. **无订阅者即停**：最后一个订阅者离开（或掉线）后必须
   `Page.stopScreencast`，不得空转。

### 3. 帧参数与节流（目标设备**已实测**）

10. **默认值依据下表实测数据设定**（RK3566 真机、系统 chromium 154、软件光栅、
    kiosk chromium 同时常驻的真实负载下测得；页面为整屏持续动画，属偏重负载）：

    | # | 传输 | 视口 → 帧 | quality | 帧数/5s | **实测 fps** | 单帧 | 首帧 |
    |---|---|---|---|---|---|---|---|
    | A | 端口 | 800×600 | 60 | 144 | **29.0** | 5.9 KB | 95 ms |
    | B | 端口 | 1280×720 | 60 | 103 | **20.8** | 9.3 KB | 84 ms |
    | C | 端口 | 1280×720 → 640×360 | 40 | 112 | **22.5** | 2.7 KB | 58 ms |
    | D | **pipe** | 800×600 → maxWidth 800 | 50 | 122 | **24.5** | 3.3 KB | — |

    > 变化源是 25 fps（40 ms 间隔），A/D 轮几乎顶到变化源上限 ⇒ **CPU 编码不是瓶颈**。

11. **据此设定默认值**（预留约 40% 余量给 Agent 的 DOM 操作、WS 转发与页面渲染）：

    | 参数 | 通用默认 | **目标设备默认** | 依据 |
    |---|---|---|---|
    | `format` | `jpeg` | `jpeg` | — |
    | `quality` | 60 | **50** | 实测 q50 单帧 3.3 KB |
    | `maxWidth` | ≤ 1280 | **800** | 实测 800 宽可跑 29 fps |
    | `maxHeight` | 视口 | **600** | 同上 |
    | 每 socket 帧率上限 | 10 fps | **15 fps** | 实测上限 24.5 fps，留 ~40% 余量 |

    - 这比最初版本（q40 / 640×360 / 4 fps）**宽松得多**，因为实测推翻了保守估计。
    - 仍然**不得突破上表上限**（客户端报大值时不放行）；客户端尺寸变化时重新协商。
    - 若将来实测发现与 Agent 高频 DOM 操作叠加时会掉帧，再按 `spec-10` 的复测流程下调。
11. `maxWidth`/`maxHeight` 由客户端上报的显示区尺寸派生，但**不得突破上表上限**
    （客户端报大值时不放行）；客户端尺寸变化时重新协商。
12. 推送给单 socket 的帧率上限通过**丢弃中间帧（保留最新帧）**实现；
    **不得用"降低 quality 到不可读"来节流**。
13. 页面无变化时 CDP 天然不产帧，不得用定时器强制刷新。
14. **内存联动（设备侧硬性要求）**：帧缓冲只保留最新一帧、不排队；最后一个订阅者
    离开立即 `Page.stopScreencast`。这条与 spec-09 的设备上限共同构成内存防线。

### 4. 生命周期

13. tab 关闭 / 导航到被拒 URL / 会话被回收 / 浏览器进程退出
    → 向订阅者发 `error` 或 `state`，并停止该 tab 的流；不得让 socket 挂死。
14. 服务关闭时：停止所有 screencast、断开所有 socket、清理定时器。
15. **帧不落盘**：任何环节都不得把 base64 帧写入文件；
    帧内容不得进日志（只允许记录 fps / 字节数量级）。

### 5. 可见边界

16. 帧只推给**已认证的 socket**。不得向局域网或互联网提供画面流
    （与 `desktop-agent-browser.md:69` 的约束一致：不提供浏览器画面流给网络）。
17. 若将来要支持"多用户同时观看"，需在 spec-09 里补威胁建模；第一版按"单实例、
    已认证用户"处理即可，但不得把帧广播到未认证连接。

## Implementation steps

1. 阅读 `packages/server/src/services/hermes/run-chat/index.ts:233-253` 与
   `packages/server/src/index.ts:488-528`（共享 IO 实例的获得方式），
   照同一模式接入 `/browser`。
2. 实现 `screencast.ts`：`start(tabId, opts)` / `stop(tabId)` / `ack(tabId, sessionId)`，
   内部持有"每 tab 一条流 + 订阅者集合 + 上一帧是否已 ack"。
3. 实现 `stream-server.ts`：连接鉴权、订阅管理、帧扇出、节流、掉线清理。
4. 帧 payload 直接复用 CDP metadata 字段名（不要重命名），并在注释里写明
   spec-08 依赖它。
5. 测试（`browser-stream.test.ts`）：注入假 session 与假 socket，断言
   - `off` 时不注册 namespace；
   - 未 ack 不发下一帧、ack 后继续；
   - 多订阅者只触发一次 `startScreencast`；
   - 最后订阅者离开触发 `stopScreencast`；
   - tab 关闭时推送 error 并清理。

## Hard rules

- 不对每个订阅者各开一条 screencast。
- 帧不落盘、不进日志、不广播给未认证连接。
- 不重命名 CDP metadata 字段（spec-08 的坐标换算依赖其原名）。
- 不用原生 WS 路径（避免改 upgrade 白名单）。
- gate 为 `off` 时不注册 namespace。

## Suggested commit message

```
feat(web-browser): screencast streaming over a /browser Socket.IO namespace

- CDP Page.startScreencast with jpeg/quality caps; ack-gated frame delivery,
  one screencast per tab fanned out to all subscribers, auto-stop when idle.
- Frame metadata passed through unchanged for client-side coordinate mapping.
- Auth via the shared namespace middleware; namespace not registered when the
  surface gate is off.
- No frames on disk, no frame content in logs, no unauthenticated delivery.

Refs: docs/web-agent-browser/spec-06-screencast-stream.md
```

## Out of scope

- 客户端渲染（spec-07）。
- 输入事件上行（spec-08）。
- WebRTC / 视频编码优化（当前帧率下无需）。

## References

- `packages/server/src/services/hermes/run-chat/index.ts:233-253`（namespace 注册范式）
- `packages/server/src/index.ts:488-528,620-633`（共享 IO 实例与 upgrade 白名单）
- `packages/desktop/src/main/browser/browser-manager.ts`（桌面端不需要画面流的原因对照）
- `docs/planning/desktop-agent-browser.md:69`（不向网络提供画面流）
