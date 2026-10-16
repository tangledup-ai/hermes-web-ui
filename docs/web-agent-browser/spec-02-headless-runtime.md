# Spec 2 — 无头运行时（系统 chromium 优先）

> Status: blocked on spec-01。

## Summary

定位一个可用的 chromium 系可执行文件（**目标设备上直接复用 apt 安装的系统 chromium**，
Chrome for Testing bundle 仅作优先级更高的可选回退），并以
**`--remote-debugging-pipe`** 方式启动一个无头实例；管理其生命周期、user-data-dir 与清理。

本 spec 只负责"把浏览器进程活着地拉起来并交出一个可用的 CDP 句柄"，不理解 CDP
协议内容（那是 spec-03），也不做任何页面操作（spec-04）。

## Dependencies

- spec-01（surface gate）。

## Decisions（已定）

0. **运行时来源：优先系统 chromium（D1 修订）。**
   - 目标设备实测已有 `chromium 154.0.8037.92`（`/usr/bin/chromium`，xtradeb arm64 deb），
     且**不存在** Chrome for Testing bundle。因此 resolver 必须把"系统 chromium"
     作为一等来源，而不是把它当异常回退。
   - 另一条硬事实：项目 pin 的 CfT `149.0.7827.55` **没有 arm64 构建**（HEAD 实测 404），
     所以"只认 bundle"在 aarch64 上根本无法工作。
   - 代价：失去版本 pin（版本随 apt 漂移）。因此在启动时**记录实际版本**并写入
     gate report（spec-01 `browserSurfaceGateReport()`），便于排障。
1. **主方案是 `--remote-debugging-pipe`（真机已验证通过）。**
   - 不开任何 TCP 端口 → 与桌面端"不开放远程调试端口"的原则一致；
   - **零新依赖**：不需要 `ws`（当前只在根 `package.json` 的 devDependencies，见
     `package.json:199`），pipe 上的 CDP 用 `child_process` 的 stdio fd 直接读写。
   - **实现方式必须是 Node 的 stdio 数组**：
     `spawn(bin, args, { stdio: ['ignore','ignore','pipe','pipe','pipe'] })`，
     然后 `child.stdio[3]`（父写→子读）与 `child.stdio[4]`（子写→父读）。
     **不要用 `dup2` + `pass_fds` 那套**：实测在 Python 下会因 `subprocess` 自身的
     `close_fds` 步骤把 fd 3/4 关掉，Chrome 直接报
     `Remote debugging pipe file descriptors are not open.` 并以 13 退出。
     （设备上已实测：改用 Node stdio 数组后 `Browser.getVersion` 正常返回，
     并能在此 pipe 上跑 screencast 达到 24.5 fps。）
   - 注意：**管道消息按 `\0` 分帧**，且事件与响应混在同一条流里（见 spec-03）。
   - `--remote-debugging-port=<loopback 随机端口>` 仅作为**显式回退**，且必须
     绑定 `127.0.0.1`、永不写日志、永不落盘。启用回退需要在该 PR 里写清原因。
     （本次真机实验的 screencast 基准就是先经端口测得，说明回退路径同样可用。）
2. **不自研指纹、不做 stealth。** 使用原生无头模式，不注入反检测脚本
   （那会污染"用户与 Agent 看同一个页面"的语义，也增加不可控面）。
3. **不使用 `agent-browser` CLI 启动。** `agent-browser` 继续服务于 Ekko 在
   **非桌面、且本面板不可用**时的回退路径（`packages/ekko-agent/src/tools/browser.ts`），
   两者互不干扰：本面板存在时，Agent 应走 MCP browser toolset。
4. **不复用设备上已有的 kiosk chromium 实例。** 它的 `--app` 指向 Web UI 自己
   （`/tmp/quanthermes-kiosk-chrome`），本面板必须使用自己的 user-data-dir 与独立进程
   （理由见 README「目标设备实测约束」）。

## Files

### Create

- `packages/server/src/services/browser/executable.ts` — 可执行文件解析
- `packages/server/src/services/browser/runtime.ts` — 进程启动/停止/健康
- `packages/server/src/services/browser/types.ts` — 本目录共享类型
- `tests/server/browser-runtime.test.ts`
- `tests/server/browser-executable.test.ts`

### Modify

- 服务端启动/关闭流程（跟随既有 service 注册与 graceful shutdown 模式）

## Acceptance criteria

1. **解析顺序必须固定且可测试**（`executable.ts`）：

   | 顺序 | 来源 | 说明 |
   |---|---|---|
   | 1 | `AGENT_BROWSER_EXECUTABLE_PATH` | 已存在的透传语义，install 阶段产出 |
   | 2 | `AGENT_BROWSER_HOME/browsers/chrome-*/` 下的可执行文件 | CfT bundle；存在时优先于系统包（版本可控） |
   | 3 | **系统 chromium**：`/usr/bin/chromium`、`/usr/bin/chromium-browser`、`/usr/lib/chromium/chromium`、`/snap/bin/chromium` 依次探测 | **目标设备的实际来源**；每个候选都必须先做可用性校验 |
   | 4 | 显式失败 | 抛出可操作错误，消息需含"缺少浏览器运行时"与实际搜索过的路径列表 |

   - 顺序 3 的可用性校验：候选必须能 `--version` 成功**且**能完成一次 headless 冒烟
     （`--headless=new --dump-dom about:blank`，短超时）；校验失败则继续下一个候选。
   - **不得静默回退到用户本机的 Google Chrome / Edge**（会与用户自己的 Profile 混淆，
     且版本不受控）；顺序 3 只允许上述**系统包管理路径**。
   - 顺序 3 命中 `/usr/bin/chromium` 时注意它通常是 **launcher 脚本**（设备实测为
     5054 字节的 `sh`），真实二进制在 `/usr/lib/chromium/chromium`；启动应使用 launcher
     （它会补齐运行环境），但版本探测必须能穿透脚本拿到真实版本。
   - 不得使用 shell 通配（`dir`、`ls`）：用 `readdirSync` + 过滤。
   - 平台可执行文件名差异（win `chrome.exe`、mac `Google Chrome for Testing.app/Contents/MacOS/...`、
     linux x64 bundle `chrome`、linux aarch64 系统包 `chromium`）必须显式处理并有测试。
2. **启动参数通过参数数组传递**，至少包含：
   `--headless=new`、`--remote-debugging-pipe`、`--user-data-dir=<dir>`、
   `--no-first-run`、`--no-default-browser-check`、`--disable-background-networking`、
   `--disable-sync`、`--disable-extensions`、`--disable-component-update`、
   `--disable-features=Translate,MediaRouter`、`--window-size=<w>,<h>`。
   - **`--disable-dev-shm-usage` 与 `--disable-gpu` 在目标设备上是必需项**
     （真机冒烟测试正是用这两个参数通过的；设备无可用 GPU 加速，`/dev/shm` 也偏小）。
   - `--no-sandbox` 的取舍**已由真机实测确定**：
     - 已部署的 `hermes-web-ui.service` 是 **`User=hermesui`**（不是 root），
       实测以 `hermesui` 身份、**不带** `--no-sandbox` 可以正常 headless 启动
       （`--dump-dom about:blank` → exit=0）⇒ **默认不加 `--no-sandbox` 成立**，
       保持这一更严格的设置；
     - 但**以 root 运行时 Chromium 会直接拒绝启动**：实测报
       `Running as root without --no-sandbox is not supported.`（exit=1）。
       因此若部署形态是 root 运行（部分设备如此，例如 kiosk chromium 就是 root），
       必须通过配置项显式开启 `--no-sandbox` **并在启动日志中告知**（这是安全降级，
       不能静默发生）；
     - 判定依据是**运行期实际 uid**，不要只看环境变量推断。
   - 设备上已有的 kiosk chromium 以 root + `--no-sandbox` 运行，**不得**因此让本面板
     默认继承这一宽松设置。
3. **user-data-dir 位置与权限**：`join(getWebUiHome(), 'web-browser', 'profiles', <profileId>)`；
   目录创建后设置 owner-only 权限（非 win32 时 `0o700`）。第一版 `profileId` 固定为
   一个"默认会话"标识，不做多 Profile 管理（见 Out of scope）。
4. **生命周期**：
   - 启动超时（建议 15s）→ kill 进程 + 抛错；
   - 进程意外退出 → 标记不可用、清理状态，下一次请求时重新拉起；
   - 服务端优雅关闭时 kill 所有浏览器进程，且不得阻塞超过 5s；
   - 所有子进程持有引用并在 `unref` 与否上做明确选择（跟随仓库既有子进程服务模式）。
5. **gate 生效**：`browserSurfaceMode() === 'off'` 时，本模块不得启动任何进程，
   也不得创建 `web-browser` 目录。该行为必须有测试。
6. **日志脱敏**：日志允许出现可执行文件路径与 user-data-dir（本机路径，便于排障），
   **不得**出现 pipe 句柄内容、CDP 消息体、页面 URL 的查询串。

## Implementation steps

1. 阅读 `packages/desktop/scripts/install-hermes.mjs:56-61,296-298,485-499`，抄清
   bundle 目录结构（`AGENT_BROWSER_HOME/browsers/chrome-<version>/...`），
   在服务端按同一约定解析。**不要**调用 desktop 的 `bundledBrowserExecutable()`
   （`packages/desktop/src/main/paths.ts:394`，且 harness 断言禁止其进入
   `webui-server.ts`）。
2. 实现 `resolveBrowserExecutable()`，返回 `{ path, source }`，`source` 用于日志
   与测试断言（`env` / `home`）。
3. 实现 `HeadlessRuntime`：`start()` / `stop()` / `isAlive()` / `cdpStreams()`。
   `cdpStreams()` 返回 pipe 的读写流（spec-03 消费）。
4. 跟随仓库既有模式接入服务端启动与 shutdown（参考同类长驻服务的注册方式）。
5. 测试：
   - `executable`：用临时目录伪造 `browsers/chrome-x/` 结构与 env，断言顺序与失败消息；
   - `runtime`：**不要**在 CI 里真的拉起 Chrome。用注入的 spawn 依赖（把
     `spawn` 作为可注入函数）断言参数数组、超时 kill、shutdown 清理、gate=off 不启动。
   - 真实进程的集成测试放到 spec-10，用 `HERMES_BROWSER_TEST=1` 门控。

## Hard rules

- 不开 TCP 调试端口（主方案）；CDP 句柄永不落盘/进日志/进 RPC。
- 不用 shell 字符串；只用参数数组（AGENTS.md）。
- 不静默回退到系统浏览器；解析失败必须显式报错。
- 不在 `packages/desktop/src/main/webui-server.ts` 里加入任何浏览器启动逻辑
  （spec-01 的 harness 断言 D）。
- `getWebUiHome()` 之外不得出现第二条状态路径来源。

## Suggested commit message

```
feat(web-browser): headless Chrome runtime for the Web UI browser panel

- Resolve the bundled Chrome for Testing via AGENT_BROWSER_EXECUTABLE_PATH
  then AGENT_BROWSER_HOME; explicit failure, no system-browser fallback.
- Start headless with --remote-debugging-pipe (no TCP port, no new deps);
  loopback port only as an explicit, documented fallback.
- Owner-only user-data-dir under getWebUiHome()/web-browser/profiles.
- Lifecycle: startup timeout, crash recovery, shutdown cleanup under 5s.
- Surface gate: no process, no directory when off.

Refs: docs/web-agent-browser/README.md (D1)
Refs: docs/web-agent-browser/spec-02-headless-runtime.md
```

## Out of scope

- CDP 协议实现（spec-03）。
- 多 Profile 管理、下载目录、代理配置（桌面端已有，Web 版第一版不做）。
- 反检测/指纹伪装。
- 云浏览器后端。

## References

- `packages/desktop/scripts/install-hermes.mjs:42-44,56-61,193-221,480-499`
- `packages/desktop/src/main/paths.ts:394`（`bundledBrowserExecutable()`，仅 install 阶段用）
- `scripts/harness-check.mjs:426-443,487-503`
- `packages/desktop/src/main/browser/browser-manager.ts`（桌面端 View 安全配置，取其 webPreferences 语义作为对照）
