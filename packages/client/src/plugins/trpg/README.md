# 会议跑团插件（TRPG 0.1.2）

创建会议时选择跑团场景，右栏自动加载独立、懒加载的 TRPG 面板。

## 角色卡与高光

- 角色卡按 D&D 5E 的身份、六项属性、战斗、技能、背景与法术分组，可折叠。玩家/发言者与角色名分开，输出名称统一为【角色名】。
- AI 抄写员接收文字、图片或 PDF。图片以 image_url、PDF 以 file/file_data 发送；上游拒绝 PDF 时可回退到 Hermes Agent 临时文件读取。模型需要支持对应输入。
- 草稿兼容 Markdown JSON、外围说明、嵌套 character/data/sheet、中文字段及属性缩写。Agent 最终答复优先于推理流。空结果仍明确报错，同一错误只显示一次。审阅后只应用非空字段。
- 角色草稿配置顺序：请求显式配置 → 服务端会议 LLM → 当前 profile 模型凭证 → Hermes bridge。界面可选草稿模型。
- 「生成图片 Prompt」直接调用会议分析 LLM：优先采用会议设置当前的 API Key/base URL/model，否则用服务端会议 LLM 配置。缺少配置明确提示，不悄悄切换 Agent。
- 高光只取点击时最近 60 句确认转写（上限 12000 字符），保留动作证据；未确认的尝试不能写成战果，不确定的“我”不能猜角色。
- 开启直接生图后，提示词和最多 4 张实际出场角色头像送到现有 profile 图像 API；返回图片在图库显示，点击放大后查看/编辑提示词。失败保留提示词可重试。provider/model 留空使用 profile 图像配置，不硬编码图像模型名称。
- 角色、头像、高光与设置存在独立 IndexedDB，按服务器、用户、profile、会议隔离；最近保留 30 张高光。离开前保存。
- 骰子区仅保留摄像头枚举、设备选择与禁用的检测按钮。没有启动摄像头、加载 ONNX 或连接 yolo 推理服务。

## 编年史

选小说化 / 记录体 / 日志体和语气（默认史诗），可指定 2–8 章；自动通常 3–6 章，短素材允许更少。

1. POST `/api/plugins/trpg/recap` 保存点击时完整转写快照和公开角色信息，不带头像、角色卡秘密。
2. 创建服务端 Hermes 会话（source=trpg_recap），进入正常 ChatView 并发送 `trpg-recap` Skill 指令。
3. Agent 使用新增的 meetings MCP 工具集逐页读取快照、切章、扩写、回写；不另造一套聊天执行器。
4. 返回会议后加载服务端编年史列表，可展开章节、证据、时间线，也可刷新或删除。

Skill：`packages/skills/trpg-recap/SKILL.md`，随现有 bundled skill 同步机制安装。MCP：`hermes_studio_meetings_toolset` 的 list/describe/call 暴露 meetings_list/get/transcript_get/recap_save。

存储在 `getWebUiHome()/meetings/<meetingId>/recaps.json`，快照在同目录 `recap-requests/`。按 profile 过滤；原子写入、会议级串行队列；同一 requestId 的保存重试覆盖原结果。章节正文最多 1800 字符，引句和角色动作证据必须在快照中逐字出现。语义上的剧情一致性仍需读者审阅。

相关 API：GET/PUT `/api/meeting-storage/:meetingId/recaps`、DELETE `.../recaps/:recapId`、GET `.../transcript?requestId=...&cursor=...`。

## 边界与验证

前端业务位于本目录；服务端位于 `services/trpg/`，控制器和路由保持薄层。共享字段定义不依赖 Vue/Koa。聊天核心仅增加 recap 来源与现有 Hermes 执行路径衔接。

定向验证涵盖角色草稿解析、PDF 请求形状、会议 LLM 调用、编年史证据/并发/隔离、客户端会话跳转、MCP 协议、角色/图片浏览器流程及生产构建。模型/生图响应使用 mock，不消耗真实模型额度。服务重启后，新 Skill 与 MCP 配置由现有同步机制加载。
