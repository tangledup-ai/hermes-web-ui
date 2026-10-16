# Spec 1 — 平台边界修订与 surface gate

> Status: 必须先落地。后续所有 spec 依赖本 spec 固定的 gate 语义。

## Summary

本方案与已定稿的桌面端设计正面冲突：`docs/planning/desktop-agent-browser.md:65`
写着"普通 Web UI 和 VPS Web UI 永久不提供内置浏览器功能"，第 126-133 行的平台边界
要求"普通 Web UI Server 不注册浏览器 Koa 路由、OpenAPI、Socket.IO namespace、
CDP Relay 或截图流"。本 spec 正式修订该文档，并新增一个显式的部署形态 gate。

**这不是一个"顺手放宽限制"的改动，是一次有记录的架构决策变更。** 修订后必须让
下一个读文档的 Agent 能直接看到新边界，而不是同时读到互相矛盾的两套说法。

## Dependencies

- 无。但必须在 spec-02 之前完成。

## Files

### Create

- `docs/web-agent-browser/README.md`（本套 spec 索引，已随本 spec 提交）
- `packages/server/src/config/browser-surface.ts` — gate 解析
- `tests/server/browser-surface.test.ts`

### Modify

- `docs/planning/desktop-agent-browser.md` — 修订 §三（不做的内容）与 §五（平台边界）
- `scripts/harness-check.mjs` — 新增两条断言（见 acceptance 3）
- 发布/部署脚本中与本 gate 相关的一处（见 acceptance 4）

## Acceptance criteria

1. `docs/planning/desktop-agent-browser.md` 中不再存在"永久不提供"这类绝对表述。
   修订后的措辞必须：
   - 明确"桌面端仍是唯一提供**原生内置**浏览器的形态"；
   - 明确"Web/设备端提供一个**服务端托管、契约与桌面端一致的**浏览器面板，
     由 `HERMES_BROWSER_SURFACE` 控制，**目标设备形态默认开启**（受硬门槛约束）"；
   - 指向 `docs/web-agent-browser/README.md` 作为 Web 版的设计来源；
   - 保留仍然有效的桌面端约束（CDP 不暴露给 Agent、不开放远程调试端口、
     Broker Token 不进模型上下文等）。
2. `browser-surface.ts` 导出唯一的判定入口，语义固定：

   | 取值 | 行为 |
   |---|---|
   | `off` | 不启动任何浏览器进程；不注册 `/api/browser*`；不注册 Socket.IO `/browser`；不写 descriptor |
   | `local` | 允许上述全部能力（仍受硬门槛与 spec-09 的安全项约束） |

   - 解析顺序：`HERMES_BROWSER_SURFACE` > 默认值。
   - **默认值：`local`**（D3：目标设备是本功能的唯一落点，默认关闭等于默认没有）。
   - **硬门槛（默认 `local` 的必要配套）**：启动时逐项检查，任一项不满足则**不启用**
     并在启动日志输出一条说明原因与实测值的告警。缺失项一律按"不启用"处理，
     **不得半开**：
     | 门槛 | 阈值 | 依据 |
     |---|---|---|
     | `MemTotal` | ≥ 3 GB | 真机 3.9 GB |
     | `MemAvailable`（判定时实测） | ≥ 1.2 GB | 真机常驻服务已占约 1.6 GB，需给浏览器留余量 |
     | 浏览器可执行文件 | 能被 spec-02 的 resolver 解析到 | 解析不到就别开 |
     | 可用磁盘（`getWebUiHome()` 所在卷） | ≥ 1 GB | 真机可用 20 GB |
   - 非法 `HERMES_BROWSER_SURFACE` 取值 → 视为 `off` 并输出明确告警
     （不得静默降级为 `local`）。
   - 判定结果必须在启动时**一次性计算并冻结**，运行期不重新读取 env
     （避免"改 env 生效一半"的中间态）。
   - 提供 `isBrowserSurfaceEnabled()` 与 `browserSurfaceMode()` 两个只读访问器，
     并额外提供 `browserSurfaceGateReport()` 返回各门槛的实测值，供 `/api/browser/surface`
     与排障日志使用。
3. `scripts/harness-check.mjs` 新增/修订断言：
   - **断言 D（防回归，保留）**：若 `packages/desktop/src/main/webui-server.ts` 出现
     `bundledBrowserExecutable()` 或任何服务端自持浏览器启动逻辑，构建失败。
     现有断言（`:501-503`）只禁止字面串 `bundledBrowserExecutable()`，需补上
     "桌面 webui-server 不得成为浏览器运行时宿主"这一层语义。
   - **断言 E'（桌面不启用，替代原"防误开"断言）**：`browser-surface.ts` 必须在
     `HERMES_DESKTOP=true` 时返回 `off` —— 桌面端已有原生内置浏览器面板，
     两套共存会争抢同一 `descriptor` 路径（见 spec-05）。该行为必须有测试。
   - **断言 F（门槛不可绕过）**：`browser-surface.ts` 必须包含内存门槛判定；
     服务端启动路径不得存在绕过门槛直接启用 surface 的调用点。
4. 目标设备侧**不需要**任何 env 配置（走默认 `local` + 硬门槛）。因此：
   - 设备部署脚本与 `build-device-package.mjs` 的 manifest **不得写
     `HERMES_BROWSER_SURFACE=local`**（让"默认值 + 门槛"成为唯一来源，
     避免出现第二处生效点）；
   - 允许为特定低配型号显式写 `off`，但必须在脚本里写明原因。
5. `tests/server/browser-surface.test.ts` 覆盖：
   - 未设置且门槛通过 → `local`；
   - 未设置但门槛不满足（mock `MemTotal`/`MemAvailable`/磁盘/可执行文件任一项）→ `off`
     + 告警，且 `browserSurfaceGateReport()` 指出是哪一项；
   - `HERMES_DESKTOP=true` → `off`（断言 E'）；
   - 显式 `off` → `off`；`HERMES_BROWSER_SURFACE` 大小写（`LOCAL`/`Local`）→ 正确解析；
   - 非法值（`yes`、`1`、空串、`auto`）→ `off` + 告警（不得降级为 `local`）；
   - 判定冻结：设置后再改 `process.env` 不改变结果。

## Implementation steps

1. **先改文档，再改代码。** 在 `desktop-agent-browser.md` 里以"修订记录"小节
   记录本次决策变更（日期 + 决策 + 指向本目录），然后改写 §三/§五的措辞。
   不要删除仍然有效的安全条款。
2. 新建 `browser-surface.ts`，实现 acceptance 2 的表。注意它必须放在
   `packages/server/src/config/` 下而不是 service 里，因为 spec-02/05/06 都要
   在启动早期读取它。
3. 在服务端启动流程中调用一次并冻结（找到 `packages/server/src/index.ts` 里
   现有早期初始化位置，跟随既有模式）。
4. 按 acceptance 3 扩展 `scripts/harness-check.mjs`。**在改动前后各跑一次
   `npm run harness:check`**，确认新断言失败时确实失败（用临时反向改动验证一次），
   避免写出永远为真的断言。
5. 检查设备侧脚本与 manifest 构建，确认没有把 gate 打开。
6. 写 `tests/server/browser-surface.test.ts`。
7. 运行 `npm run harness:check` 与 `npm run test -- browser-surface`。

## Hard rules

- 默认值必须是 `local`（D3：目标设备是本功能的唯一落点），**且必须由硬门槛兜底**。
  任何绕过硬门槛直接启用、或把非法值静默降级为 `local` 的实现都算失败。
  （2026-10-16 修订：此处原写"默认值必须是 `off`"，与 acceptance 2 / acceptance 5
  的测试契约及 README D3 互相矛盾；按"acceptance block 即测试契约"（README rule 9）
  统一为 `local`，并保留原意中"不得未配置就无条件放行"的部分——由硬门槛承担。）
- 不得让 `off` 成为"半开"状态：`off` 时必须**完全不注册**路由与
  Socket.IO namespace，而不是注册后返回 403。
- 不得静默降级。非法值 → `off` + 告警日志。
- 修订文档时保留桌面端仍然有效的安全约束，不要顺手删掉。

## Suggested commit message

```
docs(web-browser): revise Web UI browser platform boundary, add surface gate

- Revise desktop-agent-browser.md §3/§5: Web/VPS may host a
  server-side browser panel behind HERMES_BROWSER_SURFACE; keep the
  desktop-only constraints that still apply.
- Add browser-surface.ts with a frozen off|local gate, default local (D3),
  backed by the startup hard gate, no silent downgrade.
- harness-check: desktop webui-server must not become the browser
  runtime host; device scripts and manifests must not enable surface.
- Tests for gate parsing, frozen evaluation, and invalid values.

Refs: docs/web-agent-browser/README.md (D3)
Refs: docs/planning/desktop-agent-browser.md
```

## Out of scope

- 浏览器运行时本身（spec-02）。
- 任何路由、namespace、descriptor 的实现——本 spec 只固定 gate 语义。

## References

- `docs/planning/desktop-agent-browser.md:60-69`（不做的内容）、`:117-133`（平台边界）
- `scripts/harness-check.mjs:487-503`（现有 AGENT_BROWSER_HOME 相关断言）
- `packages/server/src/config.ts`（`getWebUiHome()`，本 spec 不直接用它，但后续 spec 依赖）
