<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed, nextTick, defineAsyncComponent } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NSpin, NTag, NTooltip, NInput, NPopconfirm, NSelect, NTabs, NTabPane } from 'naive-ui'
import MeetingAgentPanel from '@/components/hermes/meeting/MeetingAgentPanel.vue'
import SceneTemplatePicker from '@/components/hermes/meeting/SceneTemplatePicker.vue'
import WaveformCanvas from '@/components/hermes/meeting/WaveformCanvas.vue'
import MeetingSidebar, { type SidebarSession } from '@/components/hermes/meeting/MeetingSidebar.vue'
import CreateMeetingDialog from '@/components/hermes/meeting/CreateMeetingDialog.vue'
import DirectTranscribeForm from '@/components/hermes/meeting/DirectTranscribeForm.vue'
import DiarizeWholeFileDialog, { type DiarizeEngine } from '@/components/hermes/meeting/DiarizeWholeFileDialog.vue'
import { SCENE_UI } from '@/components/hermes/meeting/scene-ui-registry'
import { normalizeSceneId } from '@/components/hermes/meeting/scene-templates'
import MeetingTopBar from '@/components/hermes/meeting/MeetingTopBar.vue'
import MeetingRightPanel from '@/components/hermes/meeting/MeetingRightPanel.vue'
import TranscriptList from '@/components/hermes/meeting/TranscriptList.vue'
import type { SceneId } from '@/components/hermes/meeting/scene-templates'
import { useMeetingStore } from '@/stores/hermes/meeting'
import type { MeetingSession, TranscriptSentence, AgentConfig, SpeechEvalState } from '@/stores/hermes/meeting'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { DEFAULT_EVAL, provideSpeechTimer } from '@/components/hermes/meeting/speech/speechTimerContext'
import type { MeetingTranscriptionSetting } from '@/api/studio/meeting-transcription'
import { loadMeetingTranscriptionSetting } from '@/utils/meeting-transcription-settings'
import { resolveMeetingAgent } from '@/utils/meeting-agent-config'
import { meetingASRApi } from '@/utils/meeting-asr-api'
import { request } from '@/api/client'
import { useMessage } from '@/composables/useAppMessage'
import { meetingStorageApi } from '@/utils/meeting-storage-api'
import { extractMeetingTitleFromReport, requestAiMeetingTitle, formatTranscriptForTitle, canAutoRenameMeeting } from '@/utils/meeting-title'
import { getProfileDisplayName } from '@/utils/hermes/profile-display'
import { useMeetingAudio } from '@/composables/useMeetingAudio'
import { useDraggableWidth } from '@/composables/useDraggableWidth'
import { useDiarizeMerge } from '@/composables/useDiarizeMerge'
import { useMeetingDownloads } from '@/composables/useMeetingDownloads'
import { useFileTranscription } from '@/composables/useFileTranscription'
import { buildSegmentRanges, resolveActiveSegmentSpeaker } from '@/utils/speech-segments'

const MarkdownRenderer = defineAsyncComponent(() => import('@/components/hermes/chat/MarkdownRenderer.vue'))
const { t } = useI18n()
const message = useMessage()
const meetingStore = useMeetingStore()
const profilesStore = useProfilesStore()
const router = useRouter()

// --- 侧边栏状态 ---
const showSidebar = ref(true)

// 把 store 数据压扁成 MeetingSidebar 期望的最小结构（避免组件依赖 store 内部类型）
const sidebarSessions = computed<SidebarSession[]>(() =>
  meetingStore.sortedSessions.map((s) => ({
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    sentencesCount: s.sentences.length,
    hasAnalysis: Boolean(s.analysisResult || s.htmlContent),
  })),
)

// --- 创建会议对话框 ---
const showCreateModal = ref(false)
const newMeetingTitle = ref('')
const newMeetingAgentType = ref<'ekko' | 'hermes'>('ekko')
const newMeetingAgentProfile = ref('')
const newMeetingSceneTemplate = ref<SceneId>('general')
const agentTypeOptions = [
  { label: 'Ekko Agent', value: 'ekko' },
  { label: 'Hermes Agent', value: 'hermes' },
]

const activeProfile = computed(() => profilesStore.activeProfileName || 'default')
const transcriptionSetting = ref<MeetingTranscriptionSetting | null>(null)
const transcriptionSettingError = ref(false)
let transcriptionLoadId = 0
let transcriptionLoad: Promise<void> = Promise.resolve()

function refreshTranscriptionSetting(profile: string) {
  const loadId = ++transcriptionLoadId
  transcriptionSetting.value = null
  transcriptionSettingError.value = false
  transcriptionLoad = loadMeetingTranscriptionSetting(profile, activeProfile.value).then((setting) => {
    if (loadId === transcriptionLoadId) transcriptionSetting.value = setting
  }).catch((error) => {
    if (loadId !== transcriptionLoadId) return
    transcriptionSettingError.value = true
    console.error('[meeting] failed to load transcription settings:', error)
  })
  return transcriptionLoad
}

watch(activeProfile, profile => void refreshTranscriptionSetting(profile), { immediate: true })

function openTranscriptionSettings() {
  void router.push({
    name: 'hermes.models',
    query: { tab: 'stt', modelProfile: activeProfile.value },
  })
}

// --- 当前会议状态 ---
const partialText = ref('')
const finalSentences = ref<TranscriptSentence[]>([])
const speakerMap = ref<Record<string, string>>({})
/** 隐藏说话人分离功能（产品需求：会议只显示 agent 对话，不展示说话人分离）。
 *  置 true 时：工具栏不显示 diarize 开关/节省模式/说话人数选择，且强制关闭
 *  说话人分离（转写不再带说话人标签）。改回 false 可恢复。 */
const HIDE_SPEAKER_DIARIZATION = true
/** 转写列表里的说话人标签始终显示：「拆分人声」/「直接音频转录」得到的结果
 *  必须可见、可点击重命名。实时工具栏的说话人分离控件仍由
 *  HIDE_SPEAKER_DIARIZATION 关闭——两者是独立的关注点。 */
const HIDE_TRANSCRIPT_SPEAKERS = false
const useDiarize = ref(false)
const saveMode = ref(true)  // 节省模式：只走说话人分离，不走实时ASR
const speakerCount = ref(0) // 0 = auto

const sentences = computed(() => finalSentences.value)

// --- 说话人数选项 ---
const speakerCountOptions = computed(() => [
  { label: t('meeting.speakerCountAuto'), value: 0 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 },
  { label: '5', value: 5 },
  { label: '6', value: 6 },
  { label: '7', value: 7 },
  { label: '8', value: 8 },
])

// --- 说话人重命名 ---

// --- ASR 服务状态 ---
const asrServiceStatus = ref({
  isRunning: false,
  asrPort: null as number | null,
  diarizePort: null as number | null,
  pid: null as number | null,
  uptime: null as number | null,
  error: null as string | null,
})
const isStartingASR = ref(false)
const asrServiceError = ref('')

// --- 分析相关 ---
const analysisResult = ref<any>(null)
const htmlContent = ref('')
const isHtmlReport = computed(() => /^\s*(<!doctype\b|<html[\s>])/i.test(htmlContent.value))
const showReport = ref(false)

// --- Agent 分析相关 ---
const showAgentPanel = ref(true)
const pendingMeetingWrites = new Map<string, Promise<void>>()
const assistPanelRef = ref<InstanceType<typeof MeetingAgentPanel> | null>(null)

// --- 新建会议：采集方式选项卡（实时语音 / 直接音频转录） ---
// 「直接音频转录」不上麦克风，创建后把选中的整段音频交给 ASR 一次性识别。
const newMeetingCaptureMode = ref<'realtime' | 'file'>('realtime')
const directEngine = ref<'minimax' | 'qwen'>('minimax')
const directDiarize = ref(true)
const directSpeakerCount = ref(0)
const directFile = ref<File | null>(null)

// 「拆分人声」对话框（选择识别模型 / 说话人数 / Qwen 所需 OSS）
const showDiarizeDialog = ref(false)

// --- 音频录制/播放（拆分至 useMeetingAudio，行为保持不变） ---
const {
  isRecording,
  isConnecting,
  statusText,
  errorMessage,
  analyser,
  audioBlob,
  audioUrl,
  startRecording,
  stopRecording,
  isPlaying,
  playbackTime,
  playbackDuration,
  progressPercent,
  highlightedSentenceIndex,
  togglePlayPause,
  seekToSentence,
  seekToPosition,
  startProgressDrag,
  stopAudio,
} = useMeetingAudio({
  useDiarize,
  saveMode,
  speakerCount,
  asrServiceStatus,
  asrServiceError,
  openCreateModal,
  getTranscriptionProfile: () => activeProfile.value,
  startASRService: startRealtimeTranscription,
  handleWsMessage,
  saveCurrentMeeting,
  assistPanelRef,
  sentences: finalSentences,
})

// --- 说话人分离结果合并（拆分至 useDiarizeMerge，行为保持不变） ---
const { addDiarizeResultDirectly, matchAndMergeDiarizeResult, applyFileTranscriptionResult } = useDiarizeMerge({
  finalSentences,
  speakerMap,
  pushSentenceToAssist,
})

// --- 产物下载（拆分至 useMeetingDownloads，行为保持不变） ---
const { downloadAudio, downloadTranscript, downloadTranscriptMarkdown, downloadJson, downloadReport, formatDuration } = useMeetingDownloads({
  audioBlob,
  htmlContent,
})

// --- 整段音频转录（「拆分人声」按钮 / 直接音频转录 tab） ---
// 两个入口共用一个上传 + 轮询 + 合并流程：录音完成后按发言人重新标注，
// 或把上传的整段音频直接识别成会议转写。
const lastTranscribeWasDiarize = ref(true)
const { isTranscribing, progress: transcribeProgress, transcribe } = useFileTranscription({
  onComplete: async (result, options) => {
    const session = meetingStore.sessions.find(item => item.id === options.sessionId)
    if (!session) return
    const { changed, ...updated } = applyFileTranscriptionResult(session, result.sentences, !!options.diarize)
    meetingStore.updateSession(session.id, {
      ...updated,
      audioDuration: result.duration_sec || session.audioDuration,
      status: 'completed',
    })
    if (meetingStore.activeSessionId === session.id) {
      finalSentences.value = [...updated.sentences]
      speakerMap.value = { ...updated.speakerMap }
    }
    await persistMeeting(session.id)
    if (changed > 0) {
      message.success(t(options.diarize ? 'meeting.diarizeDone' : 'meeting.directTranscribeDone'))
    } else {
      message.warning(t('meeting.diarizeNoNewSentences'))
    }
  },
  onError: (msg, status) => {
    const title = lastTranscribeWasDiarize.value
      ? t('meeting.diarizeFailed')
      : t('meeting.directTranscribeFailed')
    // 后端 502/503/任务丢失都来自「服务在识别过程中被重启」，给出可操作提示
    // 而不是甩一个裸 HTTP 码；原始细节留在控制台便于排查（含服务端 error/phase）。
    if (status === 503 || status === 502) {
      console.error('[meeting] transcribe backend unavailable:', msg)
      message.error(`${title}：${t('meeting.transcribeBackendUnavailable')}`)
      return
    }
    if (status === 404) {
      console.error('[meeting] transcribe job lost:', msg)
      message.error(`${title}：${t('meeting.transcribeJobLost')}`)
      return
    }
    message.error(`${title}：${msg}`)
  },
})

const transcriptionProviderLabel = computed(() => t(
  transcriptionSetting.value?.asrProvider === 'minimax'
    ? 'meeting.asrProviderMinimax'
    : 'meeting.asrProviderDashscope',
))
const transcriptionModel = computed(() => transcriptionSetting.value?.asrProvider === 'minimax'
  ? transcriptionSetting.value.minimaxAsrModel
  : transcriptionSetting.value?.paraformerModel,
)
const realtimeConfigured = computed(() => transcriptionSetting.value?.asrProvider === 'minimax'
  ? transcriptionSetting.value.minimaxKeyConfigured
  : transcriptionSetting.value?.dashscopeKeyConfigured,
)
const fileEngineConfigured = computed(() => directEngine.value === 'minimax'
  ? transcriptionSetting.value?.minimaxKeyConfigured
  : transcriptionSetting.value?.dashscopeKeyConfigured,
)
const captureConfigured = computed(() => newMeetingCaptureMode.value === 'file'
  ? fileEngineConfigured.value
  : realtimeConfigured.value,
)
const createMeetingDisabled = computed(() => !newMeetingTitle.value.trim() || !captureConfigured.value
  || (newMeetingCaptureMode.value === 'file' && (!directFile.value || transcriptionBusy.value)),
)

function defaultFileEngine(): DiarizeEngine {
  const config = transcriptionSetting.value
  return config?.minimaxKeyConfigured && (config.asrProvider === 'minimax' || !config.dashscopeKeyConfigured)
    ? 'minimax'
    : 'qwen'
}

const isPreparingTranscription = ref(false)
const transcriptionBusy = computed(() => isPreparingTranscription.value || isTranscribing.value)

function openDiarizeDialog() {
  if (!audioBlob.value || !meetingStore.activeSessionId) {
    message.warning(t('meeting.diarizeNoAudio'))
    return
  }
  showDiarizeDialog.value = true
}

async function transcribeMeetingFile(file: Blob, options: Parameters<typeof transcribe>[1]) {
  if (transcriptionBusy.value) return
  isPreparingTranscription.value = true
  try {
    if (await startASRService(options.profile)) await transcribe(file, options)
  } finally {
    isPreparingTranscription.value = false
  }
}

function onDiarizeStart(payload: { engine: DiarizeEngine; speakerCount: number }) {
  const sessionId = meetingStore.activeSessionId
  if (!audioBlob.value || !sessionId) return
  showDiarizeDialog.value = false
  lastTranscribeWasDiarize.value = true
  void transcribeMeetingFile(audioBlob.value, {
    engine: payload.engine,
    diarize: true,
    speakerCount: payload.speakerCount,
    sessionId,
    profile: activeProfile.value,
  })
}

function runDirectTranscription(sessionId: string, file: File) {
  void meetingStorageApi.uploadAudio(sessionId, file).catch((err) => {
    console.warn('[meeting] failed to persist uploaded audio:', err)
    message.error(t('meeting.errorUploadAudioFailed'))
  })
  void meetingStore.saveAudioData(sessionId, file).catch((err) => {
    console.warn('[meeting] failed to back up uploaded audio:', err)
  })
  audioBlob.value = file
  audioUrl.value = URL.createObjectURL(file)
  lastTranscribeWasDiarize.value = false
  void transcribeMeetingFile(file, {
    engine: directEngine.value,
    diarize: directDiarize.value,
    speakerCount: directSpeakerCount.value,
    sessionId,
    profile: activeProfile.value,
  })
}

/**
 * 顶栏「导出会议文字」：把当前会议的 ASR 逐字稿导出为排版美观的 Markdown
 * （会议信息 / 说话人 / 带时间戳逐字稿 / 全文 / AI 分析 / 实时分析记录）。
 */
function exportMeetingTranscript() {
  if (!downloadTranscriptMarkdown()) {
    message.warning(t('meeting.noTranscript'))
  }
}

// 当前活动会议
const activeSession = computed(() => meetingStore.activeSession)

// 演讲评分场景：右侧面板切换为专用评估面板（计时员/赘语记录员/语法官）
const isSpeechScene = computed(() => activeSession.value?.sceneTemplate === 'speech')
const isLegalScene = computed(() => activeSession.value?.sceneTemplate === 'legal')
const isInterviewScene = computed(() => activeSession.value?.sceneTemplate === 'interview')

// 场景 UI 注册表：舞台浮层/状态条按 sceneTemplate 声明式渲染（演讲场景的
// 计时器浮层与状态条已组件化至 scene-ui-registry）
const sceneUI = computed(() => SCENE_UI[normalizeSceneId(activeSession.value?.sceneTemplate)])

// 共享计时器（与右侧演讲评估面板/场景组件同步——单例状态）。
// 视图侧只保留生命周期职责：阈值同步、切会话重置、页面卸载停表；
// 展示（浮层/状态条）由注册表组件自行从单例读取。
const activeSpeechEval = computed<SpeechEvalState>(() => ({
  ...DEFAULT_EVAL,
  ...(activeSession.value?.speechEval || {}),
}))

function persistSpeechEval(patch: Partial<SpeechEvalState>) {
  const id = activeSession.value?.id
  if (id) meetingStore.updateSession(id, { speechEval: { ...activeSpeechEval.value, ...patch } })
}

// 计时器唯一实例由 MeetingView 创建并向下 provide：
// 舞台浮层（唯一操控面）与右栏记录面板共享同一份状态与副作用。
// 注意：provideSpeechTimer 返回 reactive 包装，不能解构 timerRunning（会丢失响应性）；
// 必须保留对象引用，通过 speechTimer.timerRunning 访问。
const speechTimer = provideSpeechTimer({
  evalState: activeSpeechEval,
  persist: persistSpeechEval,
  // 计时器启动前必须先确认录音已就绪（录音启动需要数秒：麦克风检测、ASR 服务、WebSocket 握手）
  // 返回 false 则中止计时器启动；录音失败时用户会看到 errorMessage
  onBeforeStart: async () => {
    if (isRecording.value) return true // 已在录音，直接放行
    if (isConnecting.value) return false // 正在连接中，等待用户手动重试
    await startRecording()
    return isRecording.value
  },
})
const speechPhase = computed(() => speechTimer.phase)
const setSpeechTimerThresholds = speechTimer.setThresholds
const resetSpeechTimer = speechTimer.reset
const stopSpeechTimer = speechTimer.stop

const speechEval = activeSpeechEval

// 演讲会话的计时阈值变更时同步共享计时器
watch(speechEval, (st) => {
  if (st) {
    setSpeechTimerThresholds({
      durationSec: st.timerDurationSec,
      yellowAtSec: st.yellowAtSec,
      redAtSec: st.redAtSec,
    })
  }
}, { deep: true, immediate: true })

// 切换到演讲会话时重置计时器（与右侧面板一致）
watch(() => activeSession.value?.id, (id) => {
  if (id) resetSpeechTimer()
})

// --- AI 自动命名会议标题 ---
// 触发两次：1) 录音中首个实时分析轮次到达（先用当前转写取个初步标题）；
// 2) 最终 AI 分析/报告生成完成（用报告开头 AI 输出的一级标题定稿）。
// 只覆盖“会议 + 时间”这类占位标题；用户手动命名的会议一律不被覆盖。
const aiAutoNamedSessions = new Set<string>()

async function autoNameOnFirstAnalysis(sessionId: string) {
  const session = meetingStore.sessions.find(s => s.id === sessionId)
  if (!session) return
  if (!canAutoRenameMeeting(session)) return
  if (!session.sentences.length) return
  const title = await requestAiMeetingTitle(formatTranscriptForTitle(session.sentences), resolveMeetingAgent(session))
  if (!title) return
  // 等待网络期间用户可能切走/删除了该会议，回来时再校验一次
  const cur = meetingStore.sessions.find(s => s.id === sessionId)
  if (!cur || cur.htmlContent || !canAutoRenameMeeting(cur)) return
  meetingStore.updateSession(sessionId, { title, titleAutoNamed: true })
  void persistMeeting(sessionId)
}

// 首个实时分析轮次（analysisRounds 0 → >0）到达即触发初步命名；每个会议至多触发一次。
// 用数组作为 watch 源，只在 sessionId 或轮次数变化时回调，避免对每句转写都触发。
watch(
  () => [meetingStore.activeSessionId, meetingStore.activeSession?.analysisRounds?.length ?? 0] as [string | null, number],
  ([id, rounds], [prevId, prevRounds]) => {
    if (!id || prevId !== id) return // 会话切换/首次挂载：只建立基线，不触发
    if (rounds > 0 && (prevRounds ?? 0) === 0 && !aiAutoNamedSessions.has(id)) {
      aiAutoNamedSessions.add(id)
      void autoNameOnFirstAnalysis(id)
    }
  },
)

// 报告生成完成回调
function onReportGenerated(markdown: string) {
  const sessionId = meetingStore.activeSessionId
  if (!sessionId) return
  htmlContent.value = markdown
  meetingStore.updateSession(sessionId, { htmlContent: markdown })
  // 最终 AI 分析完成：若标题仍是占位/此前由 AI 命名，则用报告标题定稿
  const session = meetingStore.sessions.find(s => s.id === sessionId)
  if (session && canAutoRenameMeeting(session)) {
    const title = extractMeetingTitleFromReport(markdown)
    if (title) meetingStore.updateSession(sessionId, { title, titleAutoNamed: true })
  }
  void persistMeeting(sessionId)
}

// --- 右侧面板 ---
const showRightPanel = ref(true)
// 拖拽调宽逻辑（拆分至 useDraggableWidth，行为保持不变）
const { style: rightPanelStyle, startResize: startRightPanelResize } = useDraggableWidth({
  storageKey: 'hermes.meeting.rightPanelWidth',
  minWidth: 280,
  maxWidth: 600,
  defaultWidth: 360,
})

// --- 模型选择相关 ---
const profileOptions = computed(() => {
  return profilesStore.profiles.map(p => ({
    label: getProfileDisplayName(p),
    value: p.name,
  }))
})

// --- 会议管理 ---
function openCreateModal() {
  if (isConnecting.value || isRecording.value) return
  newMeetingTitle.value = `会议 ${new Date().toLocaleString('zh-CN')}`
  newMeetingAgentType.value = 'ekko'
  newMeetingAgentProfile.value = activeProfile.value
  newMeetingSceneTemplate.value = 'general'
  newMeetingCaptureMode.value = 'realtime'
  directEngine.value = defaultFileEngine()
  directDiarize.value = directEngine.value === 'minimax'
  directSpeakerCount.value = 0
  directFile.value = null
  showCreateModal.value = true
}

watch(transcriptionSetting, () => {
  if (!showCreateModal.value || newMeetingCaptureMode.value !== 'realtime') return
  directEngine.value = defaultFileEngine()
  directDiarize.value = directEngine.value === 'minimax'
})

function handleCreateMeeting() {
  if (createMeetingDisabled.value) return
  const agentConfig: AgentConfig = {
    agentType: newMeetingAgentType.value,
    profile: newMeetingAgentProfile.value || activeProfile.value,
  }
  const session = meetingStore.createSession({
    title: newMeetingTitle.value.trim(),
    analysisMode: agentConfig.agentType === 'hermes' ? 'hermes' : 'ekko',
    hermesProfile: agentConfig.agentType === 'hermes' ? agentConfig.profile : undefined,
    agentConfig,
    sceneTemplate: newMeetingSceneTemplate.value,
  })

  resetMeetingState()
  showAgentPanel.value = true
  showCreateModal.value = false
  void persistMeeting(session.id)
  if (newMeetingCaptureMode.value === 'file' && directFile.value) {
    runDirectTranscription(session.id, directFile.value)
  }
}

// MeetingSidebar 只传 sessionId；这里把它查回 store 中的完整 session，再走原 loadMeeting。
function selectMeetingById(sessionId: string) {
  const session = meetingStore.sortedSessions.find((s) => s.id === sessionId)
  if (session) loadMeeting(session)
}

async function loadMeeting(session: MeetingSession) {
  if (isConnecting.value) return
  if (isRecording.value) await stopRecording()
  meetingStore.setActiveSession(session.id)
  await pendingMeetingWrites.get(session.id)
  if (meetingStore.activeSessionId !== session.id) return
  session = meetingStore.sessions.find(item => item.id === session.id) || session
  
  // 从服务器加载数据
  try {
    const serverData = await meetingStorageApi.getMeeting(session.id)
    if (meetingStore.activeSessionId !== session.id) return
    if (serverData) {
      finalSentences.value = serverData.sentences || []
      analysisResult.value = serverData.analysisResult
      htmlContent.value = serverData.htmlContent || ''
      speakerMap.value = serverData.speakerMap || {}
      useDiarize.value = HIDE_SPEAKER_DIARIZATION ? false : (serverData.useDiarize || false)
    } else {
      // 如果服务器没有数据，使用本地数据
      finalSentences.value = [...session.sentences]
      analysisResult.value = session.analysisResult
      htmlContent.value = session.htmlContent
      speakerMap.value = { ...session.speakerMap }
      useDiarize.value = HIDE_SPEAKER_DIARIZATION ? false : session.useDiarize
    }
  } catch (err) {
    if (meetingStore.activeSessionId !== session.id) return
    console.error('Failed to load meeting from server:', err)
    // 回退到本地数据
    finalSentences.value = [...session.sentences]
    analysisResult.value = session.analysisResult
    htmlContent.value = session.htmlContent
    speakerMap.value = { ...session.speakerMap }
    useDiarize.value = HIDE_SPEAKER_DIARIZATION ? false : session.useDiarize
  }
  
  // 同步句子到 store（供 Agent 面板读取）
  meetingStore.updateSession(session.id, {
    sentences: [...finalSentences.value],
    analysisResult: analysisResult.value,
    htmlContent: htmlContent.value,
    speakerMap: { ...speakerMap.value },
    useDiarize: useDiarize.value,
  })
  
  partialText.value = ''
  errorMessage.value = ''
  highlightedSentenceIndex.value = -1
  stopAudio()
  
  // 加载音频数据
  await loadAudioForSession(session.id)
}

async function loadAudioForSession(sessionId: string) {
  try {
    // 从服务器加载音频
    const blob = await meetingStorageApi.downloadAudio(sessionId)
    if (meetingStore.activeSessionId !== sessionId) return
    if (blob) {
      audioBlob.value = blob
      audioUrl.value = URL.createObjectURL(blob)
      return
    }
  } catch (err) {
    console.error('Failed to load audio from server:', err)
  }
  
  // 回退到 IndexedDB
  const blob = await meetingStore.getAudioBlob(sessionId)
  if (meetingStore.activeSessionId !== sessionId) return
  if (blob) {
    audioBlob.value = blob
    audioUrl.value = URL.createObjectURL(blob)
  } else {
    audioBlob.value = null
    audioUrl.value = ''
  }
}

async function deleteMeeting(id: string) {
  const wasActive = meetingStore.activeSessionId === id
  if (wasActive && isConnecting.value) return
  if (wasActive && isRecording.value) await stopRecording()
  meetingStore.deleteSession(id)
  if (wasActive) resetMeetingState()
  try {
    await pendingMeetingWrites.get(id)
    await meetingStorageApi.deleteMeeting(id)
  } catch (err) {
    console.error('Failed to delete meeting from server:', err)
  }

}

function resetMeetingState() {
  finalSentences.value = []
  analysisResult.value = null
  htmlContent.value = ''
  speakerMap.value = {}
  partialText.value = ''
  errorMessage.value = ''
  isRecording.value = false
  isConnecting.value = false
  statusText.value = ''
  highlightedSentenceIndex.value = -1
  stopAudio()
}

async function saveCurrentMeeting() {
  if (!meetingStore.activeSessionId) return
  
  const sessionData = {
    sentences: [...finalSentences.value],
    analysisResult: analysisResult.value,
    htmlContent: htmlContent.value,
    speakerMap: { ...speakerMap.value },
    useDiarize: useDiarize.value,
    status: isRecording.value ? 'recording' as const : 'completed' as const,
  }
  
  // 保存到本地 store
  meetingStore.updateSession(meetingStore.activeSessionId, sessionData)
  
  await persistMeeting(meetingStore.activeSessionId)
}

async function persistMeeting(meetingId: string) {
  const meeting = meetingStore.sessions.find(session => session.id === meetingId)
  if (!meeting) return
  const previous = pendingMeetingWrites.get(meetingId) || Promise.resolve()
  const pending = previous.then(async () => {
    await meetingStorageApi.saveMeeting(meetingId, meeting)
    await meetingStorageApi.saveTranscript(meetingId, meeting.sentences)
  }).catch((err) => {
    console.error('[meeting] failed to save meeting:', err)
    message.error(t('meeting.errorSaveMeetingFailed'))
  })
  pendingMeetingWrites.set(meetingId, pending)
  await pending
  if (pendingMeetingWrites.get(meetingId) === pending) pendingMeetingWrites.delete(meetingId)
}

// --- 说话人重命名 ---
// TranscriptList 负责 UI state（弹窗开合/输入框），这里只做持久化。
function onTranscriptRename(speakerId: string, name: string) {
  if (!meetingStore.activeSessionId) return
  meetingStore.renameSpeaker(meetingStore.activeSessionId, speakerId, name)
  const session = meetingStore.activeSession
  if (session) {
    finalSentences.value = [...session.sentences]
    speakerMap.value = { ...session.speakerMap }
  }
  // 必须同步到服务端：loadMeeting 优先读服务端数据，只改 localStorage 的话
  // 刷新页面就会把重命名回滚掉。
  void saveCurrentMeeting()
}

// --- ASR 服务管理 ---
async function checkASRServiceStatus() {
  try {
    const status = await meetingASRApi.getStatus()
    asrServiceStatus.value = status
    return status
  } catch (err) {
    console.error('Failed to check ASR service status:', err)
    return null
  }
}

async function startASRService(profile = activeProfile.value) {
  isStartingASR.value = true
  asrServiceError.value = ''
  statusText.value = t('meeting.startup.starting')

  try {
    await transcriptionLoad
    const result = await meetingASRApi.start({}, profile)
    if (result.status !== 'started' && result.status !== 'already_running') {
      throw new Error(result.error || t('meeting.startup.error'))
    }
    asrServiceStatus.value = { ...result, isRunning: true }
    return true
  } catch (err) {
    asrServiceError.value = err instanceof Error ? err.message : t('meeting.startup.error')
    console.error('[meeting] ASR service start error:', err)
    message.error(asrServiceError.value)
    return false
  } finally {
    isStartingASR.value = false
  }
}

async function startRealtimeTranscription(profile: string) {
  if (profile === activeProfile.value) {
    await transcriptionLoad
    if (!realtimeConfigured.value) {
      asrServiceError.value = t('models.meetingTranscription.notConfigured')
      return false
    }
  }
  return startASRService(profile)
}

// --- 生命周期 ---
onMounted(async () => {
  await Promise.all([
    profilesStore.fetchProfiles(),
    checkASRServiceStatus(),
    meetingStore.syncSessionsFromServer(),
  ])
  
  // 如果有活跃会议，加载它
  if (meetingStore.activeSession) {
    loadMeeting(meetingStore.activeSession)
  }
  // 不再默认打开新建会议弹窗，用户需要点击"新建会议"按钮
})

onUnmounted(() => {
  stopRecording()
  stopSpeechTimer()
  // Note: We don't stop the ASR service on unmount as it should persist across page navigations
})

// 推送句子到实时辅助服务（fire-and-forget）
function pushSentenceToAssist(sessionId: string, sentence: TranscriptSentence) {
  request('/api/studio/meeting-asr/assist/sentence', {
    method: 'POST',
    body: JSON.stringify({
      sessionId,
      speaker: sentence.speaker,
      text: sentence.text,
      timestamp: sentence.timestamp,
    }),
  }).catch(() => { /* best effort */ })
}

function handleWsMessage(data: any, source: 'asr' | 'diarize' = 'asr') {
  switch (data.type) {
    case 'ready':
      console.log(`[${source}] Session ready:`, data.session_id || data.task_id)
      break
    case 'started':
      if (source === 'asr') {
        statusText.value = t('meeting.recording')
      }
      break
    case 'partial':
      if (source === 'asr') {
        partialText.value = data.text || ''
      }
      break
    case 'final':
      // ASR实时转写结果 - 无说话人标签
      if (source === 'asr' && data.text) {
        const nowMs = Date.now()
        // 演讲场景：按当前 timerLabel / 已记录环节用时反查 speaker；
        // 非演讲场景 / 计时器停止 / 标签空：speaker 留空（保持原行为）
        let activeSpeaker = ''
        if (isSpeechScene.value && speechTimer.timerRunning) {
          const ranges = buildSegmentRanges(activeSpeechEval.value.timerRecords || [])
          activeSpeaker = resolveActiveSegmentSpeaker(
            speechTimer.timerLabel,
            ranges,
            nowMs,
            '',
          )
        }
        const sentence: TranscriptSentence = {
          text: data.text,
          timestamp: nowMs,
          startTime: data.begin_time,
          endTime: data.end_time,
          ...(activeSpeaker ? { speaker: activeSpeaker } : {}),
        }
        finalSentences.value.push(sentence)
        partialText.value = ''
        
        // 保存到 store
        if (meetingStore.activeSessionId) {
          meetingStore.addSentence(meetingStore.activeSessionId, sentence)
        }
        
        // 推送到实时辅助服务
        // 演讲场景：仅在计时器走表时推送（计时器停止 = 演讲者间隙，不做分析）
        // 其他场景：始终推送
        if (meetingStore.activeSessionId) {
          if (!isSpeechScene.value || speechTimer.timerRunning) {
            pushSentenceToAssist(meetingStore.activeSessionId, sentence)
          }
        }
        
        // 自动滚动到底部
        nextTick(() => {
          const container = document.getElementById('transcript-container')
          if (container) container.scrollTop = container.scrollHeight
        })
      }
      break
    case 'transcript':
      // 说话人分离结果
      if (source === 'diarize' && data.sentences) {
        const offsetSec = data.offset_sec || 0
        const isSaveMode = useDiarize.value && saveMode.value
        
        if (isSaveMode) {
          // 节省模式：直接添加结果（带说话人标签）
          addDiarizeResultDirectly(data.sentences, offsetSec)
        } else {
          // 正常模式：匹配回填到已有ASR句子
          matchAndMergeDiarizeResult(data.sentences, offsetSec)
        }
      }
      break
    case 'chunk_queued':
    case 'chunk_submitted':
      // 说话人分离进度提示（可选显示）
      if (source === 'diarize') {
        console.log(`[diarize] Chunk ${data.chunk_index} processing...`)
      }
      break
    case 'error':
      if (source === 'asr') {
        // 后端 ASR 服务目前只 emit 错误文本（realtime-assist.ts:200），所以 data
        // 经常是字符串而不是对象；这里三种形态都兼容：字符串本身、空字符串、
        // { message: '' }。空 message 多半是 ASR 进程崩溃 / 未启动，此时让用户看到
        // 'service not ready' 比 'unknown error' 更可操作。
        const rawMessage =
          typeof data === 'string'
            ? data
            : (data?.message as string | undefined) ?? ''
        const trimmed = rawMessage.trim()
        errorMessage.value = trimmed || t('meeting.errorServiceNotReady')
        stopRecording()
      } else {
        // Diarize错误只记录日志，不中断录音
        console.error('[diarize] Error:', data.message)
      }
      break
    case 'stopped':
      if (source === 'asr') {
        stopRecording()
      }
      break
  }
}

async function triggerAnalysis() {
  const session = meetingStore.activeSession
  if (!session) return
  const transcript = formatTranscriptForTitle(session.sentences)
  if (!transcript.trim()) {
    errorMessage.value = t('meeting.noTranscript')
    return
  }

  // 切换到 Agent 面板并触发报告生成
  showRightPanel.value = true
  showAgentPanel.value = true
  await nextTick()
  if (assistPanelRef.value) {
    assistPanelRef.value.generateReport(transcript)
  }
}

// --- Action item formatters (support both string and object forms) ---
function formatActionItem(item: any): string {
  if (item == null) return ''
  if (typeof item === 'string') return item
  return item.task || item.text || ''
}

function formatActionAssignee(item: any): string {
  if (item && typeof item === 'object') return item.assignee || ''
  return ''
}

function formatActionDeadline(item: any): string {
  if (item && typeof item === 'object') return item.deadline || ''
  return ''
}

// 声浪可视化已迁移到 <WaveformCanvas>，本组件只保留 analyser ref 与录音控制。

// --- 分析功能 ---
async function clearTranscript() {
  finalSentences.value = []
  partialText.value = ''
  analysisResult.value = null
  htmlContent.value = ''
  showReport.value = false
  highlightedSentenceIndex.value = -1
  stopAudio()
  
  // 清空 store 中的数据
  if (meetingStore.activeSessionId) {
    meetingStore.clearSession(meetingStore.activeSessionId)
    await persistMeeting(meetingStore.activeSessionId)
  }
}
</script>

<template>
  <div class="meeting-view">
    <!-- 左侧边栏（拆分自 MeetingView 主体） -->
    <MeetingSidebar
      v-model:expanded="showSidebar"
      :sessions="sidebarSessions"
      :active-id="meetingStore.activeSessionId"
      @create="openCreateModal"
      @select="selectMeetingById"
    >
      <template #item-actions="{ session }">
        <NPopconfirm @positive-click.stop="deleteMeeting(session.id)">
          <template #trigger>
            <button
              class="meeting-item-delete"
              @click.stop
              :title="t('common.delete')"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </template>
          {{ t('meeting.deleteConfirm') }}
        </NPopconfirm>
      </template>
    </MeetingSidebar>

    <!-- 主内容区 -->
    <div class="meeting-main">
      <!-- 顶部标题栏 -->
      <!-- 顶部控制条（拆分自 MeetingView 主体） -->
      <MeetingTopBar
        :sidebar-expanded="showSidebar"
        :show-agent-panel="showAgentPanel"
        :use-diarize="useDiarize"
        :save-mode="saveMode"
        :speaker-count="speakerCount"
        :speaker-count-options="speakerCountOptions"
        :is-recording="isRecording"
        :has-sentences="sentences.length > 0"
        :hide-speaker-diarization="HIDE_SPEAKER_DIARIZATION"
        @toggle-sidebar="showSidebar = !showSidebar"
        @toggle-agent-panel="showAgentPanel = !showAgentPanel"
        @export-transcript="exportMeetingTranscript"
        @toggle-diarize="useDiarize = !useDiarize"
        @toggle-save-mode="saveMode = !saveMode"
        @update:speaker-count="speakerCount = $event"
        @clear-transcript="clearTranscript"
      />

      <!-- 主内容区 -->
      <div class="meeting-content">
      <!-- 左侧：转写区域 -->
      <div class="transcript-panel" :class="{ 'speech-scene': isSpeechScene, 'legal-scene': isLegalScene, 'interview-scene': isInterviewScene }">
        <!-- 可视化区域（场景浮层经 scene-ui-registry 声明式渲染） -->
        <div class="waveform-stage" :class="`phase-${speechPhase}`">
          <WaveformCanvas :analyser="analyser" :connecting="isConnecting" />
          <component v-if="sceneUI.stageOverlay" :is="sceneUI.stageOverlay" />
        </div>

        <component v-if="sceneUI.transcriptStrip" :is="sceneUI.transcriptStrip" />

        <!-- 状态栏（演讲场景：状态由上方状态条承载，这里只留面板开关与错误） -->
        <div class="status-bar">
          <div v-if="!sceneUI.transcriptStrip" class="status-indicator" :class="{ active: isRecording }">
            <span class="status-dot"></span>
            <span>{{ statusText || t('meeting.idle') }}</span>
          </div>
          <div v-if="errorMessage" class="error-message">
            {{ errorMessage }}
            <NButton v-if="transcriptionSetting && !realtimeConfigured" text type="primary" @click="openTranscriptionSettings">
              {{ t('models.meetingTranscription.openSettings') }}
            </NButton>
          </div>
          <div class="status-actions">
            <NTooltip trigger="hover">
              <template #trigger>
                <button
                  class="panel-toggle-btn"
                  :class="{ active: showRightPanel }"
                  @click="showRightPanel = !showRightPanel"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <line x1="15" y1="3" x2="15" y2="21"/>
                  </svg>
                </button>
              </template>
              {{ showRightPanel ? t('meeting.hidePanel') : t('meeting.showPanel') }}
            </NTooltip>
          </div>
        </div>

        <!-- 整段音频转录进度（「拆分人声」/ 直接音频转录共用） -->
        <div v-if="isTranscribing" class="transcribe-progress">
          <div class="transcribe-progress-label">
            {{ t('meeting.directTranscribing') }} · {{ Math.round(transcribeProgress * 100) }}%
          </div>
          <div class="transcribe-progress-track">
            <div class="transcribe-progress-fill" :style="{ width: `${Math.round(transcribeProgress * 100)}%` }" />
          </div>
        </div>

        <!-- 转写内容（拆分自 MeetingView 主体） -->
        <TranscriptList
          :sentences="sentences"
          :partial-text="partialText"
          :highlighted-index="highlightedSentenceIndex"
          :is-recording="isRecording"
          :hide-speaker-diarization="HIDE_TRANSCRIPT_SPEAKERS"
          @seek="seekToSentence"
          @rename="onTranscriptRename"
        />

        <!-- 录音按钮 -->
        <div class="record-button-container">
          <button
            class="record-button"
            :class="{ recording: isRecording, connecting: isConnecting }"
            :aria-label="isRecording ? t('meeting.stop') : (isConnecting ? t('meeting.connecting') : t('meeting.start'))"
            @click="isRecording ? stopRecording() : startRecording()"
            :disabled="isConnecting"
          >
            <svg v-if="!isRecording && !isConnecting" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
              <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
            </svg>
            <svg v-else-if="isRecording" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
            <NSpin v-else size="small" />
          </button>
          <span class="record-label">
            {{ isRecording ? t('meeting.stop') : (isConnecting ? t('meeting.connecting') : t('meeting.start')) }}
          </span>
        </div>
      </div>

      <!-- 右侧：分析面板（壳已拆出 MeetingRightPanel） -->
      <MeetingRightPanel
        :visible="showRightPanel"
        :is-speech-scene="isSpeechScene"
        :is-legal-scene="isLegalScene"
        :is-interview-scene="isInterviewScene"
        :show-agent-panel="showAgentPanel"
        :can-download-audio="!isRecording && !!audioUrl"
        :can-diarize="!isRecording && !!audioBlob"
        :is-diarizing="transcriptionBusy"
        :resize-style="rightPanelStyle"
        @close="showRightPanel = false"
        @download-audio="downloadAudio"
        @diarize="openDiarizeDialog"
        @resize-start="startRightPanelResize"
      >
        <template #toolbar>
          <div class="toolbar-actions">
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  type="primary"
                  :disabled="sentences.length === 0"
                  @click="triggerAnalysis"
                >
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                  </template>
                  {{ t('meeting.triggerAnalysis') }}
                </NButton>
              </template>
              {{ sentences.length === 0 ? t('meeting.noTranscript') : '' }}
            </NTooltip>

            <NButton
              size="tiny"
              type="primary"
              @click="triggerAnalysis"
              :disabled="sentences.length === 0"
            >
              {{ t('meeting.generateReport') }}
            </NButton>

            <!-- Agent 切换：靠右 -->
            <NTooltip trigger="hover">
              <template #trigger>
                <NButton
                  size="tiny"
                  :type="showAgentPanel ? 'primary' : 'default'"
                  @click="showAgentPanel = !showAgentPanel"
                >
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 2a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/>
                      <path d="M16 14H8a4 4 0 0 0-4 4v2h16v-2a4 4 0 0 0-4-4z"/>
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ showAgentPanel ? t('meeting.showAnalysis') : t('meeting.showAgentChat') }}
            </NTooltip>
          </div>
        </template>

        <template #interview>
          <component
            v-if="sceneUI.rightPanel && meetingStore.activeSessionId"
            :is="sceneUI.rightPanel"
            :key="meetingStore.activeSessionId"
            :session-id="meetingStore.activeSessionId"
            :is-recording="isRecording"
            @report-generated="onReportGenerated"
          />
        </template>

        <template #legal>
          <component
            v-if="sceneUI.rightPanel && meetingStore.activeSessionId"
            :is="sceneUI.rightPanel"
            :key="meetingStore.activeSessionId"
            :session-id="meetingStore.activeSessionId"
            :is-recording="isRecording"
            @report-generated="onReportGenerated"
          />
        </template>

        <template #speech>
          <component
            v-if="sceneUI.rightPanel && meetingStore.activeSessionId"
            :is="sceneUI.rightPanel"
            :key="meetingStore.activeSessionId"
            :session-id="meetingStore.activeSessionId"
            :is-recording="isRecording"
            @report-generated="onReportGenerated"
          />
        </template>

        <template #agent>
          <MeetingAgentPanel
            v-if="meetingStore.activeSessionId"
            :key="meetingStore.activeSessionId"
            ref="assistPanelRef"
            :session-id="meetingStore.activeSessionId"
            :scene-template="activeSession?.sceneTemplate || 'general'"
            :is-recording="isRecording"
            @report-generated="onReportGenerated"
            @request-report="triggerAnalysis"
          />
        </template>

        <template #analysis>
          <div class="right-panel-content">
            <!-- 下载区域 - 始终显示 -->
            <div class="download-section">
              <h3>{{ t('meeting.downloads') }}</h3>
              <!-- 音频播放器 -->
              <div v-if="audioUrl" class="audio-section">
                <div class="audio-player">
                  <button class="audio-play-btn" @click="togglePlayPause()">
                    <svg v-if="!isPlaying" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M8 5v14l11-7z"/>
                    </svg>
                    <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="4" width="4" height="16"/>
                      <rect x="14" y="4" width="4" height="16"/>
                    </svg>
                  </button>
                  <div class="audio-info">
                    <span class="audio-time">{{ formatDuration(playbackTime) }}</span>
                    <div class="progress-track" @click="seekToPosition" @mousedown="startProgressDrag">
                      <div class="progress-fill" :style="{ width: progressPercent + '%' }"></div>
                      <div class="progress-thumb" :style="{ left: progressPercent + '%' }"></div>
                    </div>
                    <span class="audio-time">{{ formatDuration(playbackDuration) }}</span>
                  </div>
                </div>
              </div>
              <!-- 下载按钮 -->
              <div class="download-actions">
                <NButton size="small" @click="downloadAudio" :disabled="isRecording || !audioUrl">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="7 10 12 15 17 10"/>
                      <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                  </template>
                  {{ t('meeting.downloadAudio') }}
                </NButton>
                <NButton size="small" @click="downloadTranscript" :disabled="isRecording || sentences.length === 0">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                    </svg>
                  </template>
                  {{ t('meeting.downloadTranscript') }}
                </NButton>
                <NButton size="small" @click="downloadJson" :disabled="isRecording || sentences.length === 0">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                      <polyline points="10 9 9 9 8 9"/>
                    </svg>
                  </template>
                  {{ t('meeting.downloadJson') }}
                </NButton>
                <NButton v-if="htmlContent" size="small" @click="downloadReport" :disabled="isRecording">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                    </svg>
                  </template>
                  {{ t('meeting.downloadReport') }}
                </NButton>
              </div>
            </div>

            <!-- 分析结果区域 - 只在有分析结果时显示 -->
            <template v-if="analysisResult">
              <div v-if="analysisResult.summary" class="result-section">
                <h3>{{ t('meeting.summary') }}</h3>
                <p>{{ analysisResult.summary }}</p>
              </div>

              <div v-if="analysisResult.key_points?.length" class="result-section">
                <h3>{{ t('meeting.keyPoints') }}</h3>
                <ul>
                  <li v-for="(point, i) in analysisResult.key_points" :key="i">{{ point }}</li>
                </ul>
              </div>

              <div v-if="analysisResult.action_items?.length" class="result-section">
                <h3>{{ t('meeting.actionItems') }}</h3>
                <ul class="action-list">
                  <li v-for="(item, i) in analysisResult.action_items" :key="i">
                    <input type="checkbox" />
                    <div class="action-body">
                      <span class="action-text">{{ formatActionItem(item) }}</span>
                      <span v-if="formatActionAssignee(item)" class="action-assignee">
                        👤 {{ formatActionAssignee(item) }}
                      </span>
                      <span v-if="formatActionDeadline(item)" class="action-deadline">
                        📅 {{ formatActionDeadline(item) }}
                      </span>
                    </div>
                  </li>
                </ul>
              </div>

              <div v-if="analysisResult.decisions?.length" class="result-section">
                <h3>{{ t('meeting.decisions') }}</h3>
                <ol class="decision-list">
                  <li v-for="(d, i) in analysisResult.decisions" :key="i">{{ d }}</li>
                </ol>
              </div>

              <div v-if="analysisResult.risks?.length" class="result-section">
                <h3>{{ t('meeting.risks') }}</h3>
                <ul>
                  <li v-for="(r, i) in analysisResult.risks" :key="i">{{ r }}</li>
                </ul>
              </div>

              <div v-if="analysisResult.learnings?.length" class="result-section">
                <h3>{{ t('meeting.learnings') }}</h3>
                <ul>
                  <li v-for="(l, i) in analysisResult.learnings" :key="i">{{ l }}</li>
                </ul>
              </div>

              <div v-if="analysisResult.feedback?.positive?.length || analysisResult.feedback?.negative?.length" class="result-section">
                <h3>{{ t('meeting.feedback') }}</h3>
                <div class="feedback-grid">
                  <div v-if="analysisResult.feedback.positive?.length" class="feedback-positive">
                    <h4>{{ t('meeting.feedbackPositive') }}</h4>
                    <ul>
                      <li v-for="(f, i) in analysisResult.feedback.positive" :key="i">{{ f }}</li>
                    </ul>
                  </div>
                  <div v-if="analysisResult.feedback.negative?.length" class="feedback-negative">
                    <h4>{{ t('meeting.feedbackNegative') }}</h4>
                    <ul>
                      <li v-for="(f, i) in analysisResult.feedback.negative" :key="i">{{ f }}</li>
                    </ul>
                  </div>
                </div>
              </div>

              <div v-if="analysisResult.people_mentioned?.length" class="result-section">
                <h3>{{ t('meeting.peopleMentioned') }}</h3>
                <div class="people-container">
                  <NTag v-for="(p, i) in analysisResult.people_mentioned" :key="i" type="info" size="small">
                    {{ p }}
                  </NTag>
                </div>
              </div>

              <div v-if="analysisResult.relationships?.length" class="result-section">
                <h3>{{ t('meeting.relationships') }}</h3>
                <div class="relationship-list">
                  <div v-for="(r, i) in analysisResult.relationships" :key="i" class="relationship-item">
                    <span class="rel-source">{{ r.source }}</span>
                    <span class="rel-arrow">→</span>
                    <span class="rel-target">{{ r.target }}</span>
                    <span class="rel-desc">{{ r.relation }}</span>
                  </div>
                </div>
              </div>

              <div v-if="analysisResult.meeting_type" class="result-section meeting-type">
                <NTag type="primary" size="small">{{ analysisResult.meeting_type }}</NTag>
              </div>

              <div v-if="analysisResult.topics?.length" class="result-section">
                <h3>{{ t('meeting.topics') }}</h3>
                <div class="topic-tags">
                  <NTag v-for="(topic, i) in analysisResult.topics" :key="i" type="info" size="small">
                    {{ topic }}
                  </NTag>
                </div>
              </div>

              <div class="result-section result-actions">
                <NButton type="primary" @click="showReport = true" block size="small" :disabled="!htmlContent">
                  {{ t('meeting.viewReport') }}
                </NButton>
                <NButton v-if="htmlContent" @click="downloadReport" block size="small">
                  {{ t('meeting.downloadReport') }}
                </NButton>
              </div>
            </template>

            <!-- 提示区域 - 当有转写内容但没有分析结果时显示 -->
            <div v-if="!analysisResult && sentences.length > 0" class="analysis-hint">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 16v-4"/>
                <path d="M12 8h.01"/>
              </svg>
              <p>{{ t('meeting.analysisHint') }}</p>
              <NButton
                type="primary"
                size="small"
                :disabled="sentences.length === 0"
                @click="triggerAnalysis"
              >
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                </template>
                {{ t('meeting.triggerAnalysis') }}
              </NButton>
            </div>

            <!-- 报告预览：有 htmlContent 时直接渲染，HTML 内容始终可见 -->
            <div v-if="htmlContent" class="report-preview-section" data-theme-surface="card">
              <div class="report-preview-header">
                <h3>{{ t('meeting.reportPreview') }}</h3>
                <div class="report-preview-actions">
                  <NButton size="tiny" @click="showReport = true">
                    {{ t('meeting.openReport') }}
                  </NButton>
                  <NButton size="tiny" @click="downloadReport" :disabled="isRecording">
                    {{ t('meeting.downloadReport') }}
                  </NButton>
                </div>
              </div>
              <iframe v-if="isHtmlReport" :srcdoc="htmlContent" sandbox="" class="report-preview-iframe"></iframe>
              <MarkdownRenderer v-else :content="htmlContent" />
            </div>

            <!-- 空状态 -->
            <div v-if="sentences.length === 0" class="right-panel-empty">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
                <polyline points="10 9 9 9 8 9"/>
              </svg>
              <p>{{ t('meeting.emptyState') }}</p>
            </div>
          </div>
        </template>
      </MeetingRightPanel>
      </div>
    </div>

<!-- 创建会议对话框（外壳已拆出 CreateMeetingDialog） -->
    <CreateMeetingDialog
      v-model:visible="showCreateModal"
      :create-disabled="createMeetingDisabled"
      @create="handleCreateMeeting"
    >
      <div class="create-meeting-form">
        <div class="form-item">
          <label class="form-label">{{ t('meeting.meetingName') }}</label>
          <NInput
            v-model:value="newMeetingTitle"
            :placeholder="t('meeting.meetingNamePlaceholder')"
            maxlength="50"
          />
        </div>

        <div class="form-item">
          <label class="form-label">{{ t('meeting.scene.label') }}</label>
          <SceneTemplatePicker v-model="newMeetingSceneTemplate" />
          <div class="form-hint">{{ t('meeting.scene.hint') }}</div>
        </div>

        <!-- 采集方式：实时语音（麦克风） / 直接音频转录（上传整段音频） -->
        <NTabs v-model:value="newMeetingCaptureMode" type="line" animated>
          <NTabPane name="realtime" :tab="t('meeting.createTabRealtime')" />
          <NTabPane name="file" :tab="t('meeting.createTabFile')">
            <DirectTranscribeForm
              v-model:engine="directEngine"
              v-model:diarize="directDiarize"
              v-model:speaker-count="directSpeakerCount"
              v-model:file="directFile"
              :minimax-configured="transcriptionSetting?.minimaxKeyConfigured"
              :dashscope-configured="transcriptionSetting?.dashscopeKeyConfigured"
            />
          </NTabPane>
        </NTabs>

        <NAlert
          v-if="newMeetingCaptureMode === 'realtime' || !captureConfigured"
          :type="captureConfigured ? 'info' : 'warning'"
          :show-icon="false"
        >
          <template v-if="transcriptionSettingError">
            <NButton text @click="refreshTranscriptionSetting(activeProfile)">{{ t('common.retry') }}</NButton>
          </template>
          <NSpin v-else-if="!transcriptionSetting" size="small" />
          <template v-else-if="!captureConfigured">{{ t('models.meetingTranscription.notConfigured') }}</template>
          <template v-else-if="newMeetingCaptureMode === 'realtime'">
            {{ transcriptionProviderLabel }} · {{ transcriptionModel }}
          </template>
          <NButton text type="primary" class="transcription-settings-link" @click="openTranscriptionSettings">
            {{ t('models.meetingTranscription.openSettings') }}
          </NButton>
        </NAlert>

        <div class="form-item">
          <label class="form-label" for="meeting-agent">{{ t('meeting.agentType') }}</label>
          <NSelect
            v-model:value="newMeetingAgentType"
            :options="agentTypeOptions"
            :input-props="{ id: 'meeting-agent', 'aria-label': t('meeting.agentType') }"
          />
        </div>
        <div class="form-item">
          <label class="form-label" for="meeting-agent-profile">{{ t('meeting.selectProfile') }}</label>
          <NSelect
            v-model:value="newMeetingAgentProfile"
            :options="profileOptions"
            :placeholder="t('meeting.selectProfilePlaceholder')"
            :input-props="{ id: 'meeting-agent-profile', 'aria-label': t('meeting.selectProfile') }"
          />
        </div>
      </div>
    </CreateMeetingDialog>

    <DiarizeWholeFileDialog
      v-model:visible="showDiarizeDialog"
      :default-engine="transcriptionSetting?.ossConfigured ? defaultFileEngine() : 'minimax'"
      :default-speaker-count="speakerCount"
      :minimax-key-available="transcriptionSetting?.minimaxKeyConfigured"
      :dashscope-key-available="transcriptionSetting?.dashscopeKeyConfigured"
      :oss-configured="transcriptionSetting?.ossConfigured"
      :busy="transcriptionBusy"
      @open-settings="openTranscriptionSettings"
      @start="onDiarizeStart"
    />

    <div v-if="showReport" class="report-modal" @click.self="showReport = false">
      <div class="report-container">
        <div class="report-header">
          <h2>{{ t('meeting.report') }}</h2>
          <button class="close-button" @click="showReport = false">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <iframe v-if="isHtmlReport" :srcdoc="htmlContent" sandbox="" class="report-iframe"></iframe>
        <MarkdownRenderer v-else :content="htmlContent" />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.meeting-view {
  display: flex;
  height: calc(100 * var(--vh));
  background: var(--theme-card-bg, var(--bg-card));
  color: $text-primary;
  overflow: hidden;
}

/* 左侧边栏布局（容器+删除按钮样式由父级提供；列表项内层样式已迁入 MeetingSidebar）*/
:deep(.sidebar-backdrop) {
  display: none;

  @media (max-width: 768px) {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(var(--text-primary-rgb), 0.4);
    z-index: 99;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

:deep(.meeting-sidebar) {
  width: 260px;
  min-width: 260px;
  height: 100%;
  display: flex;
  flex-direction: column;
  border-right: 1px solid $border-color;
  background: var(--theme-card-bg, var(--bg-card));
  overflow: hidden;
  transition: width 0.2s ease, min-width 0.2s ease;

  &.collapsed {
    width: 0;
    min-width: 0;
    border-right: none;
  }

  @media (max-width: 768px) {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 100;
    transform: translateX(-100%);
    transition: transform 0.2s ease;

    &:not(.collapsed) {
      transform: translateX(0);
    }

    &.collapsed {
      width: 260px;
      min-width: 260px;
    }
  }
}

:deep(.page-sidebar-top) {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 12px;
  gap: 8px;
}

:deep(.meeting-list) {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

:deep(.meeting-list-item) {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.2s ease;
  text-align: left;
  width: 100%;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.1);
  }
}

:deep(.meeting-item-icon) {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;
}

:deep(.meeting-item-content) {
  flex: 1;
  min-width: 0;
}

/* 删除按钮由父级 slot 渲染（包 NPopconfirm），故其样式留在父级*/
:deep(.meeting-item-delete) {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s ease;

  &:hover {
    background: rgba(var(--error-rgb), 0.1);
    color: var(--error);
  }
}

/* 让 hover 父级（列表项）时显示删除按钮——拆成独立规则，因为 SCSS 嵌套 + :deep + & 不能正确编译。*/
:deep(.meeting-list-item:hover) .meeting-item-delete {
  opacity: 1;
}

.meeting-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

:deep(.header-avatar-toggle) {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: all 0.2s ease;
  overflow: hidden;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.1);
    transform: scale(1.05);
  }

  &:active {
    transform: scale(0.95);
  }
}

:deep(.header-logo) {
  width: 24px;
  height: 24px;
  object-fit: contain;
}

/* 顶部控制条样式（MeetingTopBar 子组件内部 DOM，scoped 需用 :deep 穿透）*/
:deep(.meeting-header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid $border-color;
  background: var(--theme-card-bg, var(--bg-card));
  flex-shrink: 0;
}

:deep(.meeting-title) {
  display: flex;
  align-items: center;
  gap: 8px;

  h1 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
  }

  svg {
    color: $accent-primary;
  }
}

:deep(.meeting-controls) {
  display: flex;
  gap: 8px;
}

.meeting-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.transcript-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  border-right: 1px solid $border-color;
  min-width: 0;
}

/* .waveform-container / .connecting-overlay 已迁入 WaveformCanvas 组件。*/
/* 演讲评分：波形区外层舞台。圆角悬浮卡对齐主设计——*/
/* 方角深蓝底（WaveformCanvas 容器）随 overflow:hidden 被圆角裁切。*/
.waveform-stage {
  position: relative;
  overflow: hidden;
  margin: 12px 12px 0;
  border-radius: 12px;
}

.status-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
  background: var(--theme-card-bg, var(--bg-card));
}

.status-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.transcribe-progress {
  padding: 8px 16px;
  border-bottom: 1px solid $border-color;
  background: rgba(var(--accent-primary-rgb), 0.06);
}

.transcribe-progress-label {
  font-size: 12px;
  color: $text-secondary;
  margin-bottom: 6px;
}

.transcribe-progress-track {
  height: 4px;
  border-radius: 2px;
  background: rgba(var(--accent-primary-rgb), 0.15);
  overflow: hidden;
}

.transcribe-progress-fill {
  height: 100%;
  background: var(--accent-primary);
  transition: width 0.3s ease;
}

.panel-toggle-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: $text-secondary;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;

  &:hover {
    background: rgba($accent-primary, 0.1);
    color: $accent-primary;
  }

  &.active {
    color: $accent-primary;
  }
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: $text-secondary;

  &.active {
    color: $accent-primary;

    .status-dot {
      background: var(--error);
      animation: pulse 1.5s infinite;
    }
  }
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: $text-secondary;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.error-message {
  color: var(--error);
  font-size: 12px;
}

/* 转写内容样式（.transcript-content/.empty-state/.sentence-item/.sentence-speaker/*/
/* .partial-text 等）已迁入 TranscriptList.vue scoped 样式。*/

.record-button-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px;
  gap: 8px;
}

.record-button {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  border: none;
  background: $accent-primary;
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  box-shadow: 0 4px 12px rgba($accent-primary, 0.3);

  &:hover:not(:disabled) {
    transform: scale(1.05);
    box-shadow: 0 6px 16px rgba($accent-primary, 0.4);
  }

  &:active:not(:disabled) {
    transform: scale(0.95);
  }

  &.recording {
    background: var(--error);
    box-shadow: 0 4px 12px rgba(var(--error-rgb), 0.3);
    animation: pulse-button 1.5s infinite;
  }

  &.connecting {
    opacity: 0.7;
    cursor: not-allowed;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

@keyframes pulse-button {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}

.record-label {
  font-size: 12px;
  color: $text-secondary;
}

/* 右侧面板：chrome 已迁入 MeetingRightPanel.vue*/
/* 父组件只保留分析内容区域的样式（result-section / download-section / ...）*/

.result-section {
  margin-bottom: 20px;

  h3 {
    font-size: 13px;
    font-weight: 600;
    color: $text-secondary;
    margin: 0 0 8px 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  p {
    font-size: 14px;
    line-height: 1.6;
    margin: 0;
  }

  ul {
    margin: 0;
    padding-left: 20px;

    li {
      font-size: 14px;
      line-height: 1.6;
      margin-bottom: 4px;
    }
  }
}

.action-list {
  list-style: none;
  padding: 0;

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    background: rgba(var(--warning-rgb), 0.1);
    border-radius: 6px;
    margin-bottom: 8px;
    border-left: 3px solid var(--warning);

    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      cursor: pointer;
    }
  }
}

.topic-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* 新增分析结果样式*/
.decision-list {
  margin: 0;
  padding-left: 24px;

  li {
    font-size: 14px;
    line-height: 1.7;
    margin-bottom: 6px;
    color: var(--success);
  }
}

.feedback-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;

  @media (max-width: 600px) {
    grid-template-columns: 1fr;
  }
}

.feedback-positive,
.feedback-negative {
  padding: 12px;
  border-radius: 8px;

  h4 {
    font-size: 13px;
    font-weight: 600;
    margin: 0 0 8px 0;
  }

  ul {
    margin: 0;
    padding-left: 20px;

    li {
      font-size: 13px;
      line-height: 1.6;
      margin-bottom: 4px;
    }
  }
}

.feedback-positive {
  background: rgba(var(--success-rgb), 0.1);
  border-left: 3px solid var(--success);

  h4 { color: var(--success); }
  li { color: var(--success); }
}

.feedback-negative {
  background: rgba(var(--error-rgb), 0.1);
  border-left: 3px solid var(--error);

  h4 { color: var(--error); }
  li { color: var(--error); }
}

.people-container {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.relationship-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.relationship-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: rgba(var(--accent-info-rgb), 0.05);
  border-radius: 8px;
  flex-wrap: wrap;
}

.rel-source,
.rel-target {
  font-weight: 600;
  color: var(--accent-info);
  font-size: 13px;
}

.rel-arrow {
  color: var(--accent-info);
}

.rel-desc {
  color: $text-secondary;
  font-size: 12px;
  flex: 1;
  min-width: 100px;
}

.action-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.action-assignee,
.action-deadline {
  font-size: 11px;
  color: var(--warning);
}

.meeting-type {
  display: flex;
  justify-content: flex-start;
}

/* 音频播放器样式*/
.audio-section {
  padding: 12px;
  background: rgba(var(--accent-primary-rgb), 0.03);
  border-radius: 8px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
  margin-bottom: 16px;
}

.audio-player {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.audio-play-btn {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: $accent-primary;
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  flex-shrink: 0;

  &:hover {
    transform: scale(1.05);
    opacity: 0.9;
  }
}

.audio-info {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.audio-time {
  font-size: 12px;
  color: $text-secondary;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.progress-track {
  flex: 1;
  height: 6px;
  background: rgba($border-color, 0.8);
  border-radius: 3px;
  position: relative;
  cursor: pointer;
  transition: height 0.15s ease;

  &:hover {
    height: 8px;

    .progress-thumb {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
  }
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, $accent-primary, rgba($accent-primary, 0.8));
  border-radius: 3px;
  transition: width 0.1s linear;
}

.progress-thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%) scale(0.8);
  width: 14px;
  height: 14px;
  background: $accent-primary;
  border: 2px solid var(--border-color);
  border-radius: 50%;
  box-shadow: 0 1px 4px rgba(var(--text-primary-rgb), 0.2);
  opacity: 0;
  transition: opacity 0.15s ease, transform 0.15s ease;
  pointer-events: none;
}

.audio-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.download-section {
  padding: 12px;
  background: rgba(var(--accent-primary-rgb), 0.03);
  border-radius: 8px;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.1);
  margin-bottom: 16px;
  
  h3 {
    font-size: 13px;
    font-weight: 600;
    color: $text-secondary;
    margin: 0 0 12px 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
}

.download-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.analysis-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  gap: 12px;
  color: $text-secondary;

  p {
    font-size: 13px;
    text-align: center;
    line-height: 1.5;
    margin: 0;
  }
}

/* 报告预览：直接内嵌 iframe 渲染已生成的 HTML*/
.report-preview-section {
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(var(--accent-primary-rgb), 0.2);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 16px;
  background: var(--theme-card-bg, var(--bg-card));
}

.report-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(var(--accent-primary-rgb), 0.04);
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;

  h3 {
    font-size: 12px;
    font-weight: 600;
    color: $text-secondary;
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
}

.report-preview-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.report-preview-iframe {
  width: 100%;
  height: 480px;
  border: none;

  /* theme-exception: preview -- Fixed contrast keeps camera and paper preview controls visible. */
  background: white;
  display: block;
}

.result-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.report-modal {
  position: fixed;
  inset: 0;
  background: rgba(var(--text-primary-rgb), 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.report-container {
  width: 100%;
  height: 100%;
  max-width: 1200px;
  max-height: 90vh;
  background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(var(--text-primary-rgb), 0.3);
}

.report-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);

  h2 {
    font-size: 16px;
    font-weight: 600;
    margin: 0;
    color: var(--text-primary);
  }
}

.close-button {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--text-primary);

  &:hover {
    background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  }
}

.report-iframe {
  flex: 1;
  border: none;
  width: 100%;
  height: 100%;
}

/* 创建会议对话框样式*/
.create-meeting-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.transcription-settings-link {
  margin-inline-start: 8px;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-hint {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.4;
}

/* Agent 分析相关样式*/
.agent-analysis-section {
  border-bottom: 1px solid $border-color;
  background: rgba($accent-primary, 0.02);
}

.agent-analysis-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  transition: background 0.2s ease;

  &:hover {
    background: rgba($accent-primary, 0.05);
  }

  svg {
    transition: transform 0.2s ease;
    color: $accent-primary;
  }
}

.agent-status {
  margin-left: auto;
  font-size: 12px;
  color: $accent-primary;
  font-weight: normal;
}

.agent-messages-container {
  max-height: 300px;
  overflow-y: auto;
  padding: 0 16px 12px;
}

.agent-message {
  margin-bottom: 8px;
  
  &.role-tool {
    padding: 6px 10px;
    background: rgba(var(--text-primary-rgb), 0.03);
    border-radius: 6px;
    border-left: 3px solid $accent-primary;
  }
}

.agent-thinking {
  margin-bottom: 8px;
  padding: 8px 10px;
  background: rgba($accent-primary, 0.05);
  border-radius: 6px;
  border-left: 3px solid $accent-primary;
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: $accent-primary;
  margin-bottom: 4px;
}

.thinking-content {
  font-size: 12px;
  color: $text-secondary;
  white-space: pre-wrap;
  line-height: 1.5;
}

.agent-tool {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.tool-spinner {
  animation: spin 1s linear infinite;
  color: $accent-primary;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.tool-done {
  color: var(--success);
}

.tool-error {
  color: var(--error);
}

.tool-name {
  font-weight: 600;
  color: $text-primary;
}

.tool-error-text {
  color: var(--error);
  font-size: 11px;
}

.agent-content {
  font-size: 13px;
  line-height: 1.6;
  color: $text-primary;
  white-space: pre-wrap;
}

</style>
