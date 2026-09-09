# 会议跑团插件（TRPG）

## 使用

1. 打开或创建会议，在「创建会议」场景选择里直接选「跑团模式」即可。已有跑团会议直接打开，右栏会自动加载角色卡面板。
2. 添加角色，填写角色名称、玩家/发言人/别名、公开外观及角色卡正文。可附一张 PNG/JPEG/WebP 参考图（每角色最多 5 MB），点击「保存角色卡与设定」。最多 20 个角色，名称去除包裹符后必须唯一。
3. AI 角色抄写员接收两类资料（均为可选，至少其一）：文本描述（最多 12000 字符）与图片 / PDF（PNG / JPEG / WebP / application/pdf，最大 5 MB）。PDF 直接以原始字节走多模态通道给 LLM，不在前端做转换；图片走 canvas 缩放 + JPEG 0.88。模型需要支持 image / PDF 多模态输入，否则会在生成草稿时返回 `draftFailed`。
   - **解析路径优先级**：
     1. **跑团面板 LLM 配置**（顶栏「「角色抄写员 LLM」折叠块，baseUrl / apiKey / model 三项；存在 localStorage `hermes.trpg.llmConfig`）→ 直调；最优先，本地最易用
     2. **`meeting-asr/config.json` 的 `llm.api_key`** → 直调
     3. **Hermes Agent bridge**（默认；用请求 `X-Hermes-Profile` profile）→ 复用 agent 的模型 / 系统提示词 / 技能 / 记忆
     4. 都没有 → 503 `llm_not_configured`
   - **手动 LLM 覆盖**：上面 1 和 2 任一即可。面板配置（路径 1）无需 server 配置，刷新后保留在该浏览器。
4. 使用原会议录音/ASR；点击「生成图片 Prompt」读取点击时最新 60 句已确认转写（最多 12000 字符）。临时 ASR 片段不参与。
5. 复制生成的提示词，并下载、另附角色参考图到目标 GPT Image 生图工具。这里生成的是文本提示词，不调用或硬编码任何图像模型 ID，包括用户所称的 GPT image2.5。
6. 保留最近 30 条高光，包含生成时间、可编辑提示词和对应 ASR 原文依据。编辑后点击保存；可删除不需要的高光。

文本生成默认走 Hermes Agent bridge（无需任何密钥配置；profile 自带模型 / 系统提示词 / 记忆 / 技能）。若用户在 `config.json` 里手填 LLM，则自动切到直调。未配置、超时、bridge 不可用、输出校验失败分别提示；不把失败伪装为成功。参考图仅用于本地预览与下载，不发送给文本模型，不自动识别图片内容。

## 跑团设计

- **角色与玩家分开**：稳定角色 ID 关联每次动作，最终名称由程序统一包装成 `【角色名】`。玩家、发言人、别名用于消歧；不确定的第一人称不能自动指派角色。
- **事实与意图区分**：生成指令明确忽略场外闲聊、规则讨论与骰子指令；主持人确认及后续更正优先，不能将行动意图写成成功战果。
- **单镜头高光**：最近叙事中的一个瞬间，加动作、姿态、外观、环境、构图和光线，不拼接整场冒险。
- **公开信息边界**：角色卡作为身份背景资料，模型被要求不泄露未公开秘密；公开外观是独立字段。不要把仅供主持人保密的资料填入公开外观或场景。
- **可核对**：服务端只接受已登记角色 ID 和转写原文中的逐字引句。该检查证明引用存在，不保证模型对原文的语义解读始终正确；生图前仍可编辑提示词。
- **节奏**：手动按钮即时读取最新转写，不轮询 LLM、不自动消耗生成额度。后续若增加自动模式，应按新内容量触发、限频并允许主持人暂停。

## 插件边界

客户端业务位于 `packages/client/src/plugins/trpg/`，经已有 `HermesClientPlugin.install()` 注册：

- 核心新增通用 `PluginContext.addMeetingPanel()` 插槽；MeetingRightPanel 只负责选中插件和传入 `sessionId`、`sentences`。
- 核心新增通用 `PluginContext.addSceneTemplate()` 插槽；SceneTemplatePicker 读取核心 6 个场景 + 插件贡献列表。TRPG 在 install 期间贡献一个 `id='trpg'` 的场景（D20 图标，`trpg.sceneLabel` / `trpg.sceneDesc` i18n 键），所以在「创建会议」picker 里也能直接选「跑团模式」建会。服务端对未知 sceneTemplate 走通用 prompt 回退（`getSceneTemplateOrDefault()`），无需在 server `scene-templates` 注册。
- MeetingRightPanel 增加了 sceneTemplate → 插件面板的自动绑定：活跃会议 `sceneTemplate` 等于某个已注册插件 id 时，右栏直接渲染该插件面板（例如 `sceneTemplate='trpg'` + 插件启用 → 跑团面板直接显示，不走任何下拉框）。其他 scene 统一回退到 standard analysis / agent / realtime 分发。面板不提供手动切换入口；插件被运行时禁用时不入选 meetingPanels，自动回退到通用分发。
- 面板通过 `defineAsyncComponent` 懒加载。主会议视图、会议 store、ASR 音频链路除 picker 多一项可选外不修改。
- 插件管理中的 `trpg` 开关沿用现有机制，刷新后生效。
- 服务端路由 `/api/plugins/trpg/highlight` 位于原鉴权边界内，controller 验证请求，独立 `services/trpg/highlight.ts` 负责生成及输出校验。
- 编译期移除：移除客户端插件清单中的 import/registration，以及服务端路由清单中的 import/registration 后，可删除插件、控制器、路由与服务目录。

角色卡、图片 Blob 与高光存在独立 IndexedDB `hermes-plugin-trpg`；按服务器地址、用户 ID、profile、会议 ID 隔离。不写入会议 localStorage，不增加服务器用户数据目录。图片以 Blob URL 展示并在卸载时释放。生成请求在面板卸载时取消，保存采用顺序队列，等待 IndexedDB transaction 完成后才显示成功。

当前版本资料仅在本浏览器，不跨设备同步；会议删除或插件禁用不自动删除 IndexedDB 资料。可在仍存在的会议中删除角色/高光后保存；彻底清理可删除浏览器的该 IndexedDB 数据库。离开面板前需点击保存。后续可在插件内扩展战役资料库、角色卡文件导入/导出、跨会议复用、场景切换与战役时间线；骰子判定和主持人裁决仍保持人工主导，避免将首版扩展成独立规则引擎。

## 验证

- `npm run test -- tests/server/trpg-highlight.test.ts tests/client/trpg-plugin.test.ts tests/client/plugins-registry.test.ts tests/client/meeting-right-panel.test.ts`
- `npm run test:e2e -- tests/e2e/trpg.spec.ts`
- `npm run harness:check`
- `npm run build`
- `node scripts/guard-no-inline-data-urls.mjs`

仓库 map 引用的 `docs/harness/meeting-asr-safety-audit.md` 在本检出中不存在；本次不修改 ASR、CSP 或音频实现。

本地验证结果：34 项针对性单元测试通过、跑团浏览器流程通过、完整构建与 harness/CSP guard 通过。浏览器测试使用本机 Chromium 和临时 HTTP Vite 配置，绕过本机证书自动开启 HTTPS 与默认 Playwright HTTP 地址不一致的问题；未修改生产配置。模型响应使用 mock，未调用真实付费模型。
