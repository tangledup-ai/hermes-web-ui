import { startRunViaSocket, resumeSession, registerSessionHandlers, unregisterSessionHandlers, getChatRunSocket, onPeerUserMessage, onSessionCommand, onSessionTitleUpdated, onSessionWorkspaceUpdated, onSessionSettingsUpdated, type ChatRunTransport, type ResumeSessionPayload, type StartRunRequest, type RunEvent } from '@/api/hermes/chat'
import { archiveSession as archiveSessionApi, createSessionServer, deleteSession as deleteSessionApi, fetchSessionMessagesPage, fetchSessions, fetchWorkspaceRunChangeFile, fetchWorkspaceRunChangesForSession, setSessionModel, setSessionReasoningEffort as persistSessionReasoningEffort, type SessionSummary, type WorkspaceRunChangeFileDetail, type WorkspaceRunChangeSummary } from '@/api/hermes/sessions'
import { inferCodingAgentApiMode, normalizeCodingAgentApiMode, type ChatCodingAgentId } from '@/api/coding-agents'
import { getDownloadUrl } from '@/api/hermes/download'
import type { ProviderApiMode } from '@/api/hermes/system'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAppStore } from './app'
import { useProfilesStore } from './profiles'
import { useSettingsStore } from './settings'
import { primeCompletionSound, playCompletionSound } from '@/utils/completion-sound'
import { showCompletionNotification } from '@/utils/completion-notification'
import { detectThinkingBoundary } from '@/utils/thinking-parser'
import { isKnownBridgeSessionCommand } from '@/utils/hermes/bridge-session-commands'
import { type AbortState, type Attachment, type ChatAgentId, type ChatRuntimeMode, type CompressionState, type ContentBlock, type Message, type MessageReference, type PendingApproval, type PendingClarify, type QueueInsertionState, type Session, type SubagentStream, LEGACY_STORAGE_KEY, LEGACY_WORKSPACE_RUN_CHANGE_MESSAGE_PREFIX, LIVE_CHAT_MAX_LOADED_MESSAGES, LIVE_CHAT_MESSAGE_PAGE_SIZE, SESSION_PROFILE_FILTER_STORAGE_KEY, activeRuntimeMode, agentToCodingAgentId, alignWorkspaceChangeAssistantMessage, attachWorkspaceChangesToExactTurns, buildContentBlocks, clearCodingAgentRuntimeCredentials, codingAgentIdToAgent, formatMessageWithReference, friendlyAgentErrorMessage, getItemBestEffort, getReplayRunMarker, hasRuntimeToolPayload, isBackgroundDelegateToolPayload, isCodingAgentLikeSession, isQueueInsertionInterruption, lastVisibleMessageContent, lastVisibleMessageRole, legacyStorageKey, mapHermesMessages, mapHermesSession, readRunMarker, removeItem, resolveResumedAssistantState, runtimeObjectPayload, runtimeToolOutputFromEvent, runtimeToolOutputHasError, runtimeToolPayloadOrUndefined, sessionActivitySeconds, setItemBestEffort, shouldPreserveRuntimeApiMode, storageKey, setActiveRuntimeMode, uid, uploadFiles } from './chat-core'
import { createChatInteractions } from './chat-interactions'
import { createChatMessages } from './chat-messages'
import { createChatQueue } from './chat-queue'
import { createChatSubagents } from './chat-subagents'
export * from './chat-core'

export const useChatStore = defineStore('chat', () => {
  const runtimeMode = ref<ChatRuntimeMode>(activeRuntimeMode)
  const seenSessionCommandEvents = new WeakSet<RunEvent>()
  const sessions = ref<Session[]>([])
  // 消息/会话状态操作域（拆分自本文件，见 chat-messages.ts）
  const chatMessages = createChatMessages({ sessions })
  const {
    getSessionMsgs,
    isEkkoAgentSession,
    addMessage,
    addMessageInTimelineOrder,
    addHermesBackgroundDelegateAnchors,
    findHermesBackgroundDelegateAnchor,
    addOrUpdateSession,
    updateMessage,
    settleRunningTools,
    settleRuntimeDisplayForCommand,
  } = chatMessages
  const activeSessionId = ref<string | null>(null)
  const focusMessageId = ref<string | null>(null)
  const streamStates = ref<Map<string, { abort: () => void }>>(new Map())
  /** sessionId → server-reported isWorking status */
  const serverWorking = ref<Set<string>>(new Set())
  /** sessionIds with a terminal /fork command submitted but not settled yet */
  const pendingForkCommands = ref<Set<string>>(new Set())
  /** Sessions that completed while the user was viewing another session. */
  const completedUnreadSessions = ref<Set<string>>(new Set())
  /** UI-only live streams for Hermes background subagents. Never sent into parent context. */
  const subagentStreams = ref<Map<string, SubagentStream>>(new Map())
  // 子代理 / MoA 流事件域（拆分自本文件，见 chat-subagents.ts）
  const subagents = createChatSubagents({
    subagentStreams,
    messages: {
      getSessionMsgs,
      findHermesBackgroundDelegateAnchor,
      updateMessage,
      addMessageInTimelineOrder,
      addMessage,
    },
  })
  const {
    handleSubagentEvent,
    restorePersistedSubagentStreams,
    settleInterruptedSubagents,
    getSubagentStream,
    handleMoaEvent,
  } = subagents
  const storedSessionProfileFilter = getItemBestEffort(SESSION_PROFILE_FILTER_STORAGE_KEY)?.trim()
  const sessionProfileFilter = ref<string | null>(
    storedSessionProfileFilter && storedSessionProfileFilter !== '__all__'
      ? storedSessionProfileFilter
      : null,
  )
  /** sessionId → queued message count */
  const queueLengths = ref<Map<string, number>>(new Map())
  /** sessionId → queued user messages not yet visible in the transcript */
  const queuedUserMessages = ref<Map<string, Message[]>>(new Map())
  /** sessionId → server-owned safe-boundary insertion state */
  const queueInsertionStates = ref<Map<string, QueueInsertionState>>(new Map())
  /** sessionId → queue ids that server reported as dequeued before the peer message arrived */
  const dequeuedQueueIds = ref<Map<string, Set<string>>>(new Map())
  /** sessionId → message selected as the reference for the next user turn */
  const messageReferences = ref<Map<string, MessageReference>>(new Map())
  const activeMessageReference = computed(() => {
    const sid = activeSessionId.value
    return sid ? messageReferences.value.get(sid) || null : null
  })
  const pendingApprovals = ref<Map<string, PendingApproval>>(new Map())
  const pendingClarifies = ref<Map<string, PendingClarify>>(new Map())
  // 审批/澄清交互域（拆分自本文件，见 chat-interactions.ts）
  const interactions = createChatInteractions({
    activeSessionId,
    pendingApprovals,
    pendingClarifies,
    runtimeTransport,
  })
  const {
    activePendingApproval,
    activePendingClarify,
    setPendingApproval,
    clearPendingApproval,
    setPendingClarify,
    clearPendingClarify,
    clearPendingInteractions,
    respondToClarifyFor,
    respondToClarify,
    respondApprovalFor,
    respondApproval,
  } = interactions
  // 队列系统域（拆分自本文件，见 chat-queue.ts）
  const queue = createChatQueue({
    queuedUserMessages,
    queueLengths,
    queueInsertionStates,
    dequeuedQueueIds,
    runtimeTransport,
    updateSessionTitle,
    messages: {
      getSessionMsgs,
      addMessage,
    },
  })
  const {
    enqueueUserMessage,
    updateQueuedUserMessage,
    dropQueuedUserMessage,
    removeQueuedMessage,
    insertQueuedMessage,
    replaceQueueInsertionState,
    handleQueueInsertionUpdated,
    normalizeQueuedUserMessages,
    replaceQueuedUserMessages,
    consumeDequeuedQueueId,
    handleRunQueuedEvent,
  } = queue

  function setSessionProfileFilter(profile: string | null) {
    const normalized = profile?.trim()
    sessionProfileFilter.value = normalized && normalized !== '__all__' ? normalized : null
    if (sessionProfileFilter.value) {
      setItemBestEffort(SESSION_PROFILE_FILTER_STORAGE_KEY, sessionProfileFilter.value)
    } else {
      removeItem(SESSION_PROFILE_FILTER_STORAGE_KEY)
    }
  }

  function validateSessionProfileFilter(profileNames: string[]) {
    const current = sessionProfileFilter.value
    if (!current || profileNames.length === 0 || profileNames.includes(current)) return
    setSessionProfileFilter(null)
  }

  // 自动播放语音开关
  const autoPlaySpeechEnabled = ref(false)

  function setAutoPlaySpeech(enabled: boolean) {
    autoPlaySpeechEnabled.value = enabled
  }
  const isStreaming = computed(() => {
    const sid = activeSessionId.value
    if (sid == null) return false
    return streamStates.value.has(sid) || serverWorking.value.has(sid)
  })
  const isForkPending = computed(() => {
    const sid = activeSessionId.value
    return sid != null && pendingForkCommands.value.has(sid)
  })
  const isLoadingSessions = ref(false)
  const sessionsLoaded = ref(false)
  // 最近一次 switchSession 失败的原因（'resume timeout' / 'socket error' / ...）。
  // UI 可以 watch 这个 ref 出 toast。resume 失败时 store 内只能 console.error
  // （没有可继续上抛的调用方），否则用户在录音中切会话只会看到「空白」却不知道为什么。
  const lastSwitchError = ref<string | null>(null)
  const messageLoadRequests = ref<Map<string, number>>(new Map())
  const isLoadingMessages = computed(() => {
    const sid = activeSessionId.value
    return sid ? messageLoadRequests.value.has(sid) : false
  })
  const isRunActive = computed(() => isStreaming.value)
  let loadSessionsRequestSequence = 0
  let switchSessionRequestSequence = 0
  let activeSelectionSequence = 0
  const reasoningEffortWriteChains = new Map<string, Promise<boolean>>()
  const reasoningEffortWriteTargets = new Map<string, string | undefined>()
  const reasoningEffortConfirmedValues = new Map<string, string | undefined>()

  function beginMessageLoad(sessionId: string, requestSequence: number) {
    const next = new Map(messageLoadRequests.value)
    next.set(sessionId, requestSequence)
    messageLoadRequests.value = next
  }

  function endMessageLoad(sessionId: string, requestSequence: number) {
    if (messageLoadRequests.value.get(sessionId) !== requestSequence) return
    const next = new Map(messageLoadRequests.value)
    next.delete(sessionId)
    messageLoadRequests.value = next
  }

  async function fetchRuntimeSessions(profile?: string | null): Promise<SessionSummary[]> {
    const scopedProfile = profile || undefined
    if (runtimeMode.value === 'global_agent') return fetchSessions('global_agent', undefined, scopedProfile)

    const [localSessions, globalSessions] = await Promise.all([
      fetchSessions(undefined, undefined, scopedProfile),
      fetchSessions('global_agent', undefined, scopedProfile),
    ])
    const byId = new Map<string, SessionSummary>()
    for (const session of [...localSessions, ...globalSessions]) byId.set(session.id, session)
    return [...byId.values()].sort((a, b) =>
      sessionActivitySeconds(b) - sessionActivitySeconds(a),
    )
  }

  function runtimeTransport(): ChatRunTransport {
    return runtimeMode.value === 'global_agent' ? 'global-agent' : 'chat-run'
  }

  function setRuntimeMode(mode: ChatRuntimeMode) {
    if (runtimeMode.value === mode) return
    setActiveRuntimeMode(mode)
    runtimeMode.value = mode
    sessions.value = []
    completedUnreadSessions.value = new Set()
    queueLengths.value = new Map()
    queuedUserMessages.value = new Map()
    queueInsertionStates.value = new Map()
    pendingApprovals.value = new Map()
    pendingClarifies.value = new Map()
    streamStates.value = new Map()
    serverWorking.value = new Set()
    pendingForkCommands.value = new Set()
    workspaceRunChangesBySession.value = new Map()
    abortStates.value = new Map()
    sessionsLoaded.value = false
    clearActiveSession()
  }

  // Compression state is scoped per session because sockets can stay joined to
  // background sessions while another chat is active.
  const compressionStates = ref<Map<string, CompressionState>>(new Map())
  const compressionState = computed<CompressionState | null>(() => {
    const sid = activeSessionId.value
    return sid ? compressionStates.value.get(sid) || null : null
  })

  function setCompressionState(sessionId: string | null | undefined, state: CompressionState | null) {
    if (!sessionId) return
    const next = new Map(compressionStates.value)
    if (state) next.set(sessionId, state)
    else next.delete(sessionId)
    compressionStates.value = next
  }

  // Abort state is scoped per session because background sockets remain active
  // while another conversation is selected.
  const abortStates = ref<Map<string, AbortState>>(new Map())

  function setAbortState(sessionId: string | null | undefined, state: AbortState | null) {
    if (!sessionId) return
    const next = new Map(abortStates.value)
    if (state) next.set(sessionId, state)
    else next.delete(sessionId)
    abortStates.value = next
  }

  const abortState = computed<AbortState | null>({
    get: () => {
      const sid = activeSessionId.value
      return sid ? abortStates.value.get(sid) || null : null
    },
    set: state => setAbortState(activeSessionId.value, state),
  })
  const isAborting = computed(() => abortState.value?.aborting === true)

  const activeSession = ref<Session | null>(null)
  const messages = computed<Message[]>(() => activeSession.value?.messages || [])
  const workspaceRunChangesBySession = ref<Map<string, Map<string, WorkspaceRunChangeSummary>>>(new Map())
  const workspaceRunChangeLoadRequests = new Set<string>()

  function isSessionLive(sessionId: string): boolean {
    return streamStates.value.has(sessionId) || serverWorking.value.has(sessionId)
  }

  function isSessionCompletedUnread(sessionId: string): boolean {
    return completedUnreadSessions.value.has(sessionId)
  }

  function clearSessionCompletedUnread(sessionId: string) {
    if (!completedUnreadSessions.value.has(sessionId)) return
    const next = new Set(completedUnreadSessions.value)
    next.delete(sessionId)
    completedUnreadSessions.value = next
  }

  function setMessageReference(sessionId: string, reference: MessageReference) {
    const next = new Map(messageReferences.value)
    next.set(sessionId, reference)
    messageReferences.value = next
  }

  function clearMessageReference(sessionId: string) {
    if (!messageReferences.value.has(sessionId)) return
    const next = new Map(messageReferences.value)
    next.delete(sessionId)
    messageReferences.value = next
  }

  function markSessionCompletedUnread(sessionId: string, hasQueue = false) {
    if (hasQueue) {
      return
    }
    if (activeSessionId.value === sessionId) {
      clearSessionCompletedUnread(sessionId)
      return
    }
    const next = new Set(completedUnreadSessions.value)
    next.add(sessionId)
    completedUnreadSessions.value = next
  }

  function pruneCompletedUnreadSessions(existingIds: Set<string>) {
    const next = new Set([...completedUnreadSessions.value].filter(id => existingIds.has(id)))
    if (next.size !== completedUnreadSessions.value.size) completedUnreadSessions.value = next
  }

  function clearActiveSession() {
    activeSelectionSequence++
    const sid = activeSessionId.value
    activeSessionId.value = null
    activeSession.value = null
    focusMessageId.value = null
    setAbortState(sid, null)
    setCompressionState(sid, null)
    removeItem(storageKey())
  }

  function attachWorkspaceChangesToMessages(sessionId: string) {
    const target = sessions.value.find(session => session.id === sessionId)
    if (!target) return
    const changes = workspaceRunChangesBySession.value.get(sessionId)
    target.messages = target.messages.filter(
      message => !message.id.startsWith(LEGACY_WORKSPACE_RUN_CHANGE_MESSAGE_PREFIX),
    )
    if (!changes) {
      for (const message of target.messages) message.workspaceChanges = []
      return
    }
    const runChanges = [...changes.values()].filter(change => change?.source === 'run')
    attachWorkspaceChangesToExactTurns(target.messages, runChanges)
  }

  function setWorkspaceRunChanges(sessionId: string, changes: WorkspaceRunChangeSummary[]) {
    const next = new Map(workspaceRunChangesBySession.value)
    const byChangeId = new Map<string, WorkspaceRunChangeSummary>()
    for (const change of changes) {
      if (change?.change_id) byChangeId.set(change.change_id, change)
    }
    next.set(sessionId, byChangeId)
    workspaceRunChangesBySession.value = next
    attachWorkspaceChangesToMessages(sessionId)
  }

  function upsertWorkspaceRunChange(sessionId: string, change: WorkspaceRunChangeSummary | null | undefined) {
    if (!change?.change_id) return
    const next = new Map(workspaceRunChangesBySession.value)
    const current = new Map(next.get(sessionId) || [])
    current.set(change.change_id, change)
    next.set(sessionId, current)
    workspaceRunChangesBySession.value = next
    attachWorkspaceChangesToMessages(sessionId)
  }

  function handleWorkspaceRunChangeEvent(
    sessionId: string,
    evt: any,
    assistantMessageId?: string | null,
  ): string | null {
    const change = evt?.change as WorkspaceRunChangeSummary | undefined
    const target = sessions.value.find(session => session.id === sessionId)
    const alignedAssistantMessageId = target
      ? alignWorkspaceChangeAssistantMessage(target.messages, change, assistantMessageId)
      : assistantMessageId || null
    upsertWorkspaceRunChange(sessionId, change)
    return alignedAssistantMessageId
  }

  function handleTerminalWorkspaceRunChange(
    sessionId: string,
    evt: any,
    assistantMessageId?: string | null,
  ) {
    const change = evt?.workspace_run_change as WorkspaceRunChangeSummary | undefined
    const target = sessions.value.find(session => session.id === sessionId)
    if (target) alignWorkspaceChangeAssistantMessage(target.messages, change, assistantMessageId)
    upsertWorkspaceRunChange(sessionId, change)
  }

  function restoreWorkspaceRunChangeMessages(sessionId: string) {
    attachWorkspaceChangesToMessages(sessionId)
    if (workspaceRunChangesBySession.value.has(sessionId) || workspaceRunChangeLoadRequests.has(sessionId)) return
    workspaceRunChangeLoadRequests.add(sessionId)
    void loadWorkspaceRunChangesForSession(sessionId)
      .catch(err => console.warn('Failed to load workspace run changes:', err))
      .finally(() => {
        workspaceRunChangeLoadRequests.delete(sessionId)
      })
  }

  async function loadWorkspaceRunChangesForSession(sessionId: string) {
    const changes = await fetchWorkspaceRunChangesForSession(sessionId)
    setWorkspaceRunChanges(sessionId, changes)
  }

  async function loadWorkspaceRunChangeFile(sessionId: string, toolCallId: string, fileId: number): Promise<WorkspaceRunChangeFileDetail | null> {
    return fetchWorkspaceRunChangeFile(sessionId, toolCallId, fileId)
  }

  function ensureSessionLoaded(summary: SessionSummary): Session {
    const existing = sessions.value.find(session => session.id === summary.id)
    const mapped = mapHermesSession(summary)
    if (existing) {
      Object.assign(existing, {
        ...mapped,
        messages: existing.messages,
        contextTokens: existing.contextTokens,
        apiMode: mapped.apiMode || existing.apiMode,
        loadedMessageCount: existing.loadedMessageCount,
        hasMoreBefore: existing.hasMoreBefore,
      })
      return existing
    }
    sessions.value.unshift(mapped)
    return mapped
  }

  async function loadSessions(profile?: string | null, preferredSessionId?: string | null) {
    const requestSequence = ++loadSessionsRequestSequence
    const selectionSequence = activeSelectionSequence
    isLoadingSessions.value = true
    try {
      const list = await fetchRuntimeSessions(profile)
      if (requestSequence !== loadSessionsRequestSequence) return
      const fresh = list.map(mapHermesSession)
      const selectionChanged = selectionSequence !== activeSelectionSequence
      const explicitlySelectedSession = selectionChanged && activeSessionId.value
        ? sessions.value.find(session => session.id === activeSessionId.value) || activeSession.value
        : null
      // Preserve already-loaded messages for sessions that are still present,
      // so we don't blow away the active session's messages on refresh.
      const runtimeByIdBefore = new Map(sessions.value.map(s => [s.id, {
        messages: s.messages,
        contextTokens: s.contextTokens,
        apiMode: s.apiMode,
      }]))
      for (const s of fresh) {
        const prev = runtimeByIdBefore.get(s.id)
        if (prev?.messages?.length) s.messages = prev.messages
        if (prev?.contextTokens != null) s.contextTokens = prev.contextTokens
        if (!s.apiMode && prev?.apiMode) s.apiMode = prev.apiMode
      }
      const freshIds = new Set(fresh.map(session => session.id))
      const localOnlySessions = sessions.value.filter(session =>
        session.isLocalOnly
        && !freshIds.has(session.id)
        && (!profile || session.profile === profile),
      )
      if (
        explicitlySelectedSession
        && !freshIds.has(explicitlySelectedSession.id)
        && !localOnlySessions.some(session => session.id === explicitlySelectedSession.id)
      ) {
        localOnlySessions.unshift(explicitlySelectedSession)
      }
      sessions.value = [...localOnlySessions, ...fresh]
      pruneCompletedUnreadSessions(new Set(sessions.value.map(s => s.id)))

      // A session load may have started before the user selected or created a
      // different chat. Keep the refreshed list, but do not let that stale
      // continuation take ownership of the active selection.
      if (selectionChanged) {
        activeSession.value = activeSessionId.value
          ? sessions.value.find(session => session.id === activeSessionId.value) || null
          : null
        return
      }

      // Restore route-selected session first (tab-local source of truth),
      // then current in-memory session, then persisted legacy/default choice,
      // then fallback to the most recent session.
      const currentId = activeSessionId.value
      const legacyActiveKey = legacyStorageKey()
      const storedId = getItemBestEffort(storageKey()) || (legacyActiveKey ? getItemBestEffort(LEGACY_STORAGE_KEY) : null)
      const targetId = preferredSessionId && sessions.value.some(s => s.id === preferredSessionId)
        ? preferredSessionId
        : currentId && sessions.value.some(s => s.id === currentId)
          ? currentId
          : storedId && sessions.value.some(s => s.id === storedId)
            ? storedId
            : sessions.value[0]?.id
      if (targetId) {
        await switchSession(targetId)
      } else {
        clearActiveSession()
      }
    } catch (err) {
      if (requestSequence === loadSessionsRequestSequence) {
        console.error('Failed to load sessions:', err)
      }
    } finally {
      if (requestSequence === loadSessionsRequestSequence) {
        isLoadingSessions.value = false
        sessionsLoaded.value = true
      }
    }
  }

  // Refresh ONLY the session list metadata (titles, ordering, new/removed
  // sessions) without switching the active session or reloading its messages.
  // Used for live sync so sessions created elsewhere (CLI, Telegram, another
  // device) appear without a manual reload. Skips while streaming to avoid
  // churn.
  //
  // CRITICAL: this MERGES IN-PLACE into the existing session objects instead of
  // replacing the array with `mapHermesSession` clones. `activeSession` is a ref
  // bound to a specific object inside `sessions.value` (see switchSession), and
  // streaming deltas mutate that same object via `sessions.value.find(...)`. If
  // we swapped in fresh objects, `activeSession.value` would point at an orphan
  // and live messages would stop appearing until a manual reload. Mutating the
  // existing objects preserves referential identity so streaming keeps working.
  async function refreshSessionListOnly(profile?: string | null): Promise<void> {
    if (isStreaming.value) return
    if (isLoadingSessions.value) return
    try {
      const list = await fetchRuntimeSessions(profile ?? sessionProfileFilter.value)
      const incoming = list.map(mapHermesSession)
      const existingById = new Map(sessions.value.map(s => [s.id, s]))
      const incomingIds = new Set(incoming.map(s => s.id))

      // Build the next array reusing existing objects (identity-preserving) and
      // inserting genuinely-new sessions as fresh objects.
      const next: Session[] = []
      for (const fresh of incoming) {
        const existing = existingById.get(fresh.id)
        if (existing) {
          // Update scalar metadata in-place; never touch runtime/scroll state
          // (messages, loadedMessageCount, hasMoreBefore, contextTokens).
          existing.title = fresh.title
          existing.source = fresh.source
          existing.updatedAt = fresh.updatedAt
          existing.lastActiveAt = fresh.lastActiveAt
          existing.endedAt = fresh.endedAt
          existing.model = fresh.model
          existing.provider = fresh.provider
          existing.apiMode = fresh.apiMode || existing.apiMode
          existing.reasoningEffort = fresh.reasoningEffort
          existing.messageCount = fresh.messageCount
          existing.inputTokens = fresh.inputTokens
          existing.outputTokens = fresh.outputTokens
          existing.workspace = fresh.workspace
          existing.categoryId = fresh.categoryId
          existing.isLocalOnly = false
          // messageTotal: keep the larger of server count vs what we've loaded,
          // so we don't shrink below already-rendered messages mid-session.
          if (fresh.messageTotal != null) {
            existing.messageTotal = Math.max(fresh.messageTotal, existing.loadedMessageCount || 0)
          }
          next.push(existing)
        } else {
          next.push(fresh)
        }
      }

      // Keep the active session even if the server no longer lists it (don't
      // pull the rug out from under what the user is viewing).
      const activeId = activeSessionId.value
      if (activeId && !incomingIds.has(activeId)) {
        const keep = existingById.get(activeId)
        if (keep) next.push(keep)
      }

      sessions.value = next
      pruneCompletedUnreadSessions(new Set(next.map(s => s.id)))

      // Defensive: re-bind activeSession to the (same) object now in the array,
      // by id, in case anything above changed array membership.
      if (activeId) {
        const again = sessions.value.find(s => s.id === activeId)
        if (again && activeSession.value !== again) activeSession.value = again
      }
    } catch (err) {
      console.error('Failed to refresh session list:', err)
    }
  }

  // Re-pull active session from server. Used on tab-visible events.
  async function refreshActiveSession(): Promise<boolean> {
    const sid = activeSessionId.value
    if (!sid) return false
    try {
      const target = sessions.value.find(s => s.id === sid)
      if (!target) return false
      const limit = Math.min(
        Math.max(target.loadedMessageCount || LIVE_CHAT_MESSAGE_PAGE_SIZE, LIVE_CHAT_MESSAGE_PAGE_SIZE),
        LIVE_CHAT_MAX_LOADED_MESSAGES,
      )
      const detail = await fetchSessionMessagesPage(sid, 0, limit, activeSession.value?.profile)
      if (!detail) return false
      const mapped = mapHermesMessages(detail.messages || [])
      target.messages = mapped
      restorePersistedSubagentStreams(sid)
      target.loadedMessageCount = detail.messages.length
      target.messageTotal = detail.total
      target.messageCount = detail.total
      target.hasMoreBefore = detail.hasMore
      if (detail.session.title) target.title = detail.session.title
      target.workspace = detail.session.workspace || target.workspace || null
      target.categoryId = detail.session.category_id ?? null
      target.isLocalOnly = false
      target.parentSessionId = detail.session.parent_session_id || target.parentSessionId || null
      target.forkPointMessageId = (detail.session as any).fork_point_message_id != null ? String((detail.session as any).fork_point_message_id) : target.forkPointMessageId || null
      target.parentTitle = detail.session.parent_title || target.parentTitle || null
      target.parentLastMessage = detail.session.parent_last_message || target.parentLastMessage || null
      target.parentLastMessageRole = detail.session.parent_last_message_role || target.parentLastMessageRole || null
      restoreWorkspaceRunChangeMessages(sid)
      return true
    } catch (err) {
      console.error('Failed to refresh active session:', err)
      return false
    }
  }


  function createSession(options: {
    profile?: string
    model?: string
    provider?: string
    source?: 'api_server' | 'cli' | 'coding_agent' | 'global_agent' | 'workflow' | 'group_chat' | 'trpg_recap'
    agent?: ChatAgentId
    codingAgentId?: ChatCodingAgentId
    codingAgentMode?: 'global' | 'scoped'
    workspace?: string | null
    categoryId?: number | null
    baseUrl?: string
    apiKey?: string
    apiMode?: ProviderApiMode
  } = {}): Session {
    const source = options.source === 'trpg_recap' ? 'trpg_recap' : runtimeMode.value === 'global_agent' ? 'global_agent' : options.source || 'cli'
    const codingAgentId = options.codingAgentId || agentToCodingAgentId(options.agent)
    const codingAgentMode = codingAgentId ? (options.codingAgentMode || 'scoped') : undefined
    const session: Session = {
      id: uid(),
      profile: options.profile || useProfilesStore().activeProfileName || 'default',
      title: '',
      source,
      agent: options.agent || codingAgentIdToAgent(codingAgentId) || 'hermes',
      codingAgentId,
      codingAgentMode,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: options.model || undefined,
      provider: options.provider || '',
      workspace: options.workspace || null,
      categoryId: options.categoryId ?? null,
      isLocalOnly: true,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      apiMode: options.apiMode,
    }
    sessions.value.unshift(session)
    return session
  }

  function newCliSession(): Session {
    const now = new Date()
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')
    const hex = Math.random().toString(16).slice(2, 8)
    const session: Session = {
      id: `${ts}_${hex}`,
      title: '',
      source: runtimeMode.value === 'global_agent' ? 'global_agent' : 'cli',
      agent: 'hermes',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    sessions.value.unshift(session)
    return session
  }

  async function switchSession(sessionId: string, focusId?: string | null) {
    activeSelectionSequence++
    const requestSequence = ++switchSessionRequestSequence
    clearThinkingObservationFor(sessionId)
    activeSessionId.value = sessionId
    focusMessageId.value = focusId ?? null
    setItemBestEffort(storageKey(), sessionId)
    const legacyActiveKey = legacyStorageKey()
    if (legacyActiveKey) removeItem(legacyActiveKey)
    activeSession.value = sessions.value.find(s => s.id === sessionId) || null
    clearSessionCompletedUnread(sessionId)

    if (!activeSession.value) return

    beginMessageLoad(sessionId, requestSequence)
    let backgroundPendingOnResume = 0

    try {
      // Load messages via Socket.IO resume (server loads from DB if not in memory)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('resume timeout')), 15_000)
        resumeSession(sessionId, (data) => {
          clearTimeout(timeout)
          if (
            data.session_id !== sessionId
            || activeSessionId.value !== sessionId
            || requestSequence !== switchSessionRequestSequence
          ) {
            resolve()
            return
          }
          const target = sessions.value.find(s => s.id === sessionId)
          if (!target) {
            resolve()
            return
          }
          if (data.isWorking) {
            serverWorking.value.add(sessionId)
          } else {
            serverWorking.value.delete(sessionId)
          }
          backgroundPendingOnResume = Number(data.backgroundPending || 0)
          if (data.queueLength && data.queueLength > 0) {
            queueLengths.value.set(sessionId, data.queueLength)
          } else {
            queueLengths.value.delete(sessionId)
          }
          if (Array.isArray((data as any).queueMessages)) {
            replaceQueuedUserMessages(sessionId, normalizeQueuedUserMessages((data as any).queueMessages))
          } else if (!data.queueLength) {
            replaceQueuedUserMessages(sessionId, [])
          }
          replaceQueueInsertionState(sessionId, data.queueInsertion)
          if ((data as any).isAborting) {
            setAbortState(sessionId, { aborting: true, synced: null })
          } else if (!data.isWorking) {
            setAbortState(sessionId, null)
          }
          if (!data.isWorking) setCompressionState(sessionId, null)
          if (data.inputTokens != null) target.inputTokens = data.inputTokens
          if (data.outputTokens != null) target.outputTokens = data.outputTokens
          if ((data as any).contextTokens != null) target.contextTokens = (data as any).contextTokens
          applyResumedSessionSettings(data)
          if (typeof data.workspace === 'string') {
            target.workspace = data.workspace.trim() || null
            target.isLocalOnly = false
          }
          target.parentSessionId = (data as any).parentSessionId || target.parentSessionId || null
          target.forkPointMessageId = (data as any).forkPointMessageId != null ? String((data as any).forkPointMessageId) : target.forkPointMessageId || null
          target.parentTitle = (data as any).parentTitle || target.parentTitle || null
          target.parentLastMessage = (data as any).parentLastMessage || target.parentLastMessage || null
          target.parentLastMessageRole = (data as any).parentLastMessageRole || target.parentLastMessageRole || null
          if (data.messages?.length) {
            target.messages = mapHermesMessages(data.messages as any[])
            restorePersistedSubagentStreams(sessionId)
            restoreWorkspaceRunChangeMessages(sessionId)
            target.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
            target.messageTotal = data.messageTotal ?? target.messageCount ?? target.loadedMessageCount
            target.messageCount = target.messageTotal
            target.hasMoreBefore = data.hasMoreBefore ?? target.loadedMessageCount < target.messageTotal
          }
          if (!target.title) {
            const firstUser = target.messages.find(m => m.role === 'user')
            if (firstUser) {
              const t = firstUser.content.slice(0, 40)
              target.title = t + (firstUser.content.length > 40 ? '...' : '')
            }
          }
          activeSession.value = target
          // Process replayed events (compression state etc.)
          if (data.events?.length) {
            for (const evt of data.events) {
              const e = evt.data as any
              if (e.event === 'compression.started') {
                setCompressionState(sessionId, {
                  compressing: true,
                  messageCount: e.message_count || 0,
                  beforeTokens: e.token_count || 0,
                  afterTokens: 0,
                  compressed: null,
                })
              } else if (e.event === 'compression.completed') {
                const afterTokens = e.contextTokens || e.afterTokens || 0
                setCompressionState(sessionId, {
                  compressing: false,
                  messageCount: e.totalMessages || 0,
                  beforeTokens: e.beforeTokens || 0,
                  afterTokens,
                  compressed: e.compressed ?? false,
                  error: e.error,
                })
                if (e.contextTokens != null) target.contextTokens = e.contextTokens
              } else if (e.event === 'abort.started') {
                setAbortState(sessionId, { aborting: true, synced: null })
              } else if (e.event === 'abort.timeout') {
                setAbortState(sessionId, { aborting: true, synced: false, timedOut: true, message: (e as any).message })
              } else if (e.event === 'abort.completed') {
                setAbortState(sessionId, { aborting: false, synced: e.synced ?? false })
                settleInterruptedSubagents(sessionId)
              } else if (e.event === 'approval.requested') {
                setPendingApproval({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'approval.resolved') {
                clearPendingApproval({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'clarify.requested') {
                setPendingClarify({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'clarify.resolved') {
                clearPendingClarify({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'run.failed') {
                handleTerminalWorkspaceRunChange(sessionId, e)
                addAgentErrorMessage(sessionId, e.error)
                serverWorking.value.delete(sessionId)
                queueLengths.value.delete(sessionId)
              } else if (e.event === 'agent.event' || e.event === 'run.reattach_failed') {
                handleAgentEvent(e)
              } else if (e.event === 'workspace.diff.completed') {
                handleWorkspaceRunChangeEvent(sessionId, e)
              } else if (e.event === 'tool.started') {
                const startedToolName = e.tool || e.name
                if (
                  isBackgroundDelegateToolPayload(startedToolName, (e as any).arguments)
                  || (isEkkoAgentSession(sessionId) && startedToolName === 'delegate_task')
                ) continue
                const msgs = getSessionMsgs(sessionId)
                const toolCallId = e.tool_call_id as string | undefined
                const existingTool = toolCallId
                  ? msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
                  : null
                if (existingTool) {
                  updateMessage(sessionId, existingTool.id, {
                    toolName: e.tool || e.name,
                    runMarker: existingTool.runMarker || readRunMarker(e),
                    toolArgs: hasRuntimeToolPayload((e as any).arguments) ? (e as any).arguments : existingTool.toolArgs,
                    toolPreview: e.preview || existingTool.toolPreview,
                    toolStatus: existingTool.toolStatus || 'running',
                  })
                } else {
                  addMessage(sessionId, {
                    id: uid(),
                    role: 'tool',
                    content: '',
                    timestamp: Date.now(),
                    toolName: e.tool || e.name,
                    toolCallId,
                    runMarker: readRunMarker(e),
                    toolPreview: e.preview,
                    toolArgs: runtimeToolPayloadOrUndefined((e as any).arguments),
                    toolStatus: 'running',
                  })
                }
              } else if (e.event === 'tool.completed' || e.event === 'tool.failed') {
                const msgs = getSessionMsgs(sessionId)
                const toolCallId = e.tool_call_id as string | undefined
                const toolMsgs = toolCallId
                  ? msgs.filter(m => m.role === 'tool' && m.toolCallId === toolCallId)
                  : msgs.filter(m => m.role === 'tool' && m.toolStatus === 'running')
                const output = runtimeToolOutputFromEvent(e)
                const toolName = e.tool || e.name || toolMsgs[toolMsgs.length - 1]?.toolName
                if (isBackgroundDelegateToolPayload(toolName, output)) {
                  target.messages = target.messages.filter(message => !toolMsgs.includes(message))
                  addHermesBackgroundDelegateAnchors(
                    sessionId,
                    toolCallId,
                    output,
                    toolMsgs[toolMsgs.length - 1]?.toolArgs,
                  )
                  continue
                }
                if (
                  isEkkoAgentSession(sessionId)
                  && toolName === 'delegate_task'
                  && runtimeObjectPayload(output)?.runtime === 'ekko'
                ) {
                  target.messages = target.messages.filter(message => !toolMsgs.includes(message))
                  continue
                }
                if (toolMsgs.length > 0) {
                  const last = toolMsgs[toolMsgs.length - 1]
                  updateMessage(sessionId, last.id, {
                    runMarker: last.runMarker || readRunMarker(e),
                    toolStatus: e.event === 'tool.failed' || e.error === true || runtimeToolOutputHasError(output) ? 'error' : 'done',
                    toolDuration: e.duration,
                    toolResult: output,
                  })
                }
              } else if (e.event === 'moa.reference' || e.event === 'moa.aggregating') {
                handleMoaEvent(sessionId, e as RunEvent)
              } else if (String(e.event || '').startsWith('subagent.') || e.event === 'delegation.updated') {
                handleSubagentEvent(sessionId, e as RunEvent)
              }
            }
          }
          if (Array.isArray(data.backgroundTasks)) {
            for (const task of data.backgroundTasks) {
              const lastEvent = String(task.last_event || '')
              const status = String(task.status || '')
              const event = lastEvent.startsWith('subagent.')
                ? lastEvent
                : status === 'running' ? 'subagent.progress' : 'subagent.complete'
              handleSubagentEvent(sessionId, {
                ...task,
                event,
                session_id: sessionId,
                background_snapshot: true,
                subagent_id: task.subagent_id,
                tool: task.last_tool,
                name: task.last_tool,
                text: task.preview,
                duration_seconds: task.duration_seconds,
              } as RunEvent)
            }
          }
          resolve()
        }, activeSession.value?.profile, runtimeTransport())
      })
      if (activeSessionId.value === sessionId && requestSequence === switchSessionRequestSequence) {
        await loadWorkspaceRunChangesForSession(sessionId)
      }
    } catch (err) {
      console.error('Failed to load session messages via resume:', err)
      // 只在「这次切会话请求还是当前活跃请求」时 surface，避免快速连切导致旧错误
      // 覆盖新错误。同时把错误归一化：timeout / network / 其他都有区分。
      if (activeSessionId.value === sessionId && requestSequence === switchSessionRequestSequence) {
        const reason = err instanceof Error ? err.message : String(err)
        lastSwitchError.value = `${sessionId}:${reason}`
      }
    } finally {
      endMessageLoad(sessionId, requestSequence)
    }

    // Resume in-flight run event listeners if needed
    if (activeSessionId.value === sessionId && requestSequence === switchSessionRequestSequence) {
      resumeServerWorkingRun(sessionId, backgroundPendingOnResume > 0, !serverWorking.value.has(sessionId))
    }
  }

  async function loadOlderMessages(sessionId = activeSessionId.value): Promise<boolean> {
    if (!sessionId) return false
    const target = sessions.value.find(s => s.id === sessionId)
    if (!target || target.isLoadingOlderMessages || !target.hasMoreBefore) return false
    const offset = target.loadedMessageCount || 0
    if (offset >= LIVE_CHAT_MAX_LOADED_MESSAGES) return false
    const limit = Math.min(LIVE_CHAT_MESSAGE_PAGE_SIZE, LIVE_CHAT_MAX_LOADED_MESSAGES - offset)
    target.isLoadingOlderMessages = true
    try {
      const page = await fetchSessionMessagesPage(sessionId, offset, limit, target.profile)
      if (!page || page.messages.length === 0) {
        target.hasMoreBefore = false
        return false
      }

      const existingIds = new Set(target.messages.map(message => message.id))
      const olderMessages = mapHermesMessages(page.messages).filter(message => !existingIds.has(message.id))
      target.messages = [...olderMessages, ...target.messages]
      restorePersistedSubagentStreams(sessionId)
      attachWorkspaceChangesToMessages(sessionId)
      target.loadedMessageCount = offset + page.messages.length
      target.messageTotal = page.total
      target.messageCount = page.total
      target.hasMoreBefore = page.hasMore
      return olderMessages.length > 0
    } catch (err) {
      console.error('Failed to load older session messages:', err)
      return false
    } finally {
      target.isLoadingOlderMessages = false
    }
  }

  function newChat(options: {
    profile?: string
    model?: string
    provider?: string
    source?: 'api_server' | 'cli' | 'coding_agent' | 'global_agent' | 'workflow' | 'group_chat' | 'trpg_recap'
    agent?: ChatAgentId
    codingAgentId?: ChatCodingAgentId
    codingAgentMode?: 'global' | 'scoped'
    workspace?: string | null
    categoryId?: number | null
    baseUrl?: string
    apiKey?: string
    apiMode?: ProviderApiMode
  } = {}): Session {
    const appStore = useAppStore()
    const storageSource = runtimeMode.value === 'global_agent' ? 'global_agent' : options.source || 'cli'
    const codingAgentId = options.codingAgentId || agentToCodingAgentId(options.agent)
    const isGlobalCodingAgent = Boolean(codingAgentId) && options.codingAgentMode === 'global'
    const session = createSession({
      profile: options.profile,
      model: isGlobalCodingAgent ? undefined : options.model || appStore.selectedModel || undefined,
      provider: isGlobalCodingAgent ? '' : options.provider || appStore.selectedProvider || '',
      source: storageSource,
      agent: options.agent,
      codingAgentId,
      codingAgentMode: options.codingAgentMode,
      workspace: options.workspace,
      categoryId: options.categoryId,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      apiMode: options.apiMode,
    })
    void switchSession(session.id)
    return session
  }

  /**
   * 同步在 server 端创建 session，避免 ChatView.loadSessions 覆盖本地新建 session
   * 失败时回退到本地 createSession
   */
  async function newChatWithRemoteCreate(options: {
    profile?: string
    model?: string
    provider?: string
    source?: 'api_server' | 'cli' | 'coding_agent' | 'global_agent'
    agent?: 'hermes' | 'claude' | 'codex'
    title?: string
  } = {}): Promise<Session> {
    const session = createSession(options)
    try {
      await createSessionServer({
        id: session.id,
        profile: session.profile || 'default',
        title: options.title || '',
        source: session.source,
        agent: session.agent,
        model: session.model,
        provider: session.provider,
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[chat] remote session create failed, falling back to local:', err)
    }
    void switchSession(session.id)
    return session
  }

  async function switchSessionModel(modelId: string, provider?: string, sessionId?: string, apiMode?: ProviderApiMode): Promise<boolean> {
    const targetId = sessionId || activeSession.value?.id
    if (!targetId) return false
    const target = sessions.value.find(s => s.id === targetId)
    const activeTarget = activeSession.value?.id === targetId ? activeSession.value : null
    const session = target || activeTarget
    if (session?.codingAgentMode === 'global' && isCodingAgentLikeSession(session)) return false
    const previousProvider = String(target?.provider ?? activeTarget?.provider ?? '')
    const nextProvider = provider || ''
    const shouldClearRuntimeCredentials = previousProvider !== nextProvider && (
      isCodingAgentLikeSession(target) || isCodingAgentLikeSession(activeTarget)
    )
    const preservedApiMode = apiMode || (previousProvider === nextProvider
      ? (shouldPreserveRuntimeApiMode(target) ? target?.apiMode : undefined) ||
        (shouldPreserveRuntimeApiMode(activeTarget) ? activeTarget?.apiMode : undefined)
      : undefined)
    const isLocalOnly = target?.isLocalOnly === true || activeTarget?.isLocalOnly === true
    if (!isLocalOnly) {
      await reasoningEffortWriteChains.get(targetId)?.catch(() => false)
      const ok = await setSessionModel(targetId, modelId, provider || '', preservedApiMode)
      if (!ok) return false
    }
    if (target) {
      target.model = modelId
      target.provider = provider || ''
      target.apiMode = preservedApiMode
      target.reasoningEffort = undefined
      if (shouldClearRuntimeCredentials) clearCodingAgentRuntimeCredentials(target)
    }
    if (activeTarget) {
      activeTarget.model = modelId
      activeTarget.provider = provider || ''
      activeTarget.apiMode = preservedApiMode
      activeTarget.reasoningEffort = undefined
      if (shouldClearRuntimeCredentials) clearCodingAgentRuntimeCredentials(activeTarget)
    }
    return true
  }

  async function deleteSession(sessionId: string): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const ok = await deleteSessionApi(sessionId, target?.profile)
    if (!ok) return false
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    clearMessageReference(sessionId)
    setAbortState(sessionId, null)
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0].id)
      } else {
        const session = createSession()
        switchSession(session.id)
      }
    }
    return true
  }

  async function archiveSession(sessionId: string): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const ok = await archiveSessionApi(sessionId)
    if (!ok) return false
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    clearMessageReference(sessionId)
    setAbortState(sessionId, null)
    if (completedUnreadSessions.value.has(sessionId)) {
      const next = new Set(completedUnreadSessions.value)
      next.delete(sessionId)
      completedUnreadSessions.value = next
    }
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0].id)
      } else {
        clearActiveSession()
      }
    } else if (target) {
      await refreshSessionListOnly(sessionProfileFilter.value)
    }
    return true
  }

  function clearAgentEventMessages(sessionId: string) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (!s) return
    s.messages = s.messages.filter(m => m.commandAction !== 'agent.event')
  }


  function addAgentErrorMessage(sessionId: string, error?: unknown) {
    const message = friendlyAgentErrorMessage(error)
    const content = message ? `Error: ${message}` : 'Run failed'
    const msgs = getSessionMsgs(sessionId)
    const last = msgs[msgs.length - 1]
    if (last?.isStreaming) {
      // If the streaming message already has substantial content (the assistant
      // produced a meaningful reply before the error), don't overwrite it —
      // just close the stream and append a separate error message. Only
      // overwrite when the message is still empty or trivially short, meaning
      // the run failed before producing useful output.
      const hasSubstantialContent = (last.content || '').trim().length > 100
      if (hasSubstantialContent) {
        updateMessage(sessionId, last.id, { isStreaming: false })
        // fall through to append a separate error message
      } else {
        updateMessage(sessionId, last.id, {
          role: 'assistant',
          content,
          isStreaming: false,
          systemType: 'error',
        })
        return
      }
    }
    if (last?.role === 'assistant' && last.systemType === 'error' && last.content === content) return
    addMessage(sessionId, {
      id: uid(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      systemType: 'error',
    })
  }

  function handleSessionCommandEvent(evt: RunEvent) {
    if (seenSessionCommandEvents.has(evt)) return
    seenSessionCommandEvents.add(evt)

    const sid = evt.session_id
    if (!sid) return
    const target = sessions.value.find(s => s.id === sid)
    const action = (evt as any).action as string | undefined
    const command = String((evt as any).command || '').toLowerCase()
    if ((evt as any).started === true && (evt as any).terminal === false) {
      serverWorking.value.add(sid)
    }
    if ((evt as any).terminal === true) {
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
      pendingForkCommands.value.delete(sid)
      const msgs = getSessionMsgs(sid)
      msgs.forEach((m, i) => {
        if (m.isStreaming) updateMessage(sid, m.id, { isStreaming: false })
        if (m.role === 'tool' && m.toolStatus === 'running') {
          msgs[i] = { ...m, toolStatus: (evt as any).ok === false ? 'error' : 'done' }
        }
      })
    }

    if (action === 'clear' && command === 'clear') {
      if (target) target.messages = []
      queuedUserMessages.value.delete(sid)
      queueLengths.value.delete(sid)
      queueInsertionStates.value.delete(sid)
      clearMessageReference(sid)
      if ((evt as any).clearHistory) {
        const message = String((evt as any).message || '')
        if (message) {
          addMessage(sid, {
            id: uid(),
            role: 'command',
            content: message,
            timestamp: Date.now(),
            systemType: (evt as any).ok === false ? 'error' : 'command',
            commandAction: action,
            commandData: { ...(evt as any) },
          })
        }
      }
      return
    }

    if (action === 'title' && target && typeof (evt as any).title === 'string') {
      target.title = (evt as any).title
      target.updatedAt = Date.now()
    }

    if (action === 'usage' && target) {
      target.inputTokens = (evt as any).inputTokens
      target.outputTokens = (evt as any).outputTokens
      if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
    }

    if (action === 'destroy') {
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
      queueLengths.value.delete(sid)
      queuedUserMessages.value.delete(sid)
      queueInsertionStates.value.delete(sid)
      clearMessageReference(sid)
      setAbortState(sid, null)
      const msgs = getSessionMsgs(sid)
      msgs.forEach(m => {
        if (m.isStreaming) updateMessage(sid, m.id, { isStreaming: false })
        if (m.role === 'tool' && m.toolStatus === 'running') m.toolStatus = 'error'
      })
    }

    if (action === 'branch' && (evt as any).ok !== false) {
      const branch = ((evt as any).branchSession || {}) as Record<string, unknown>
      const newSessionId = String((evt as any).newSessionId || branch.id || '').trim()
      if (newSessionId) {
        const existing = sessions.value.find(s => s.id === newSessionId)
        if (!existing) {
          sessions.value.unshift({
            id: newSessionId,
            profile: typeof branch.profile === 'string' ? branch.profile : undefined,
            title: String((evt as any).newSessionTitle || branch.title || 'Branch'),
            source: typeof branch.source === 'string' ? branch.source : 'cli',
            messages: [],
            createdAt: typeof branch.createdAt === 'number' ? branch.createdAt : Date.now(),
            updatedAt: typeof branch.updatedAt === 'number' ? branch.updatedAt : Date.now(),
            model: typeof branch.model === 'string' ? branch.model : undefined,
            provider: typeof branch.provider === 'string' ? branch.provider : undefined,
            messageCount: typeof branch.messageCount === 'number' ? branch.messageCount : undefined,
            messageTotal: typeof branch.messageCount === 'number' ? branch.messageCount : undefined,
            loadedMessageCount: 0,
            hasMoreBefore: false,
            parentSessionId: typeof branch.parentSessionId === 'string'
              ? branch.parentSessionId
              : typeof (evt as any).parentSessionId === 'string' ? (evt as any).parentSessionId : sid,
            forkPointMessageId: branch.forkPointMessageId != null ? String(branch.forkPointMessageId) : null,
            parentTitle: typeof branch.parentTitle === 'string' ? branch.parentTitle : target?.title || null,
            parentLastMessage: typeof branch.parentLastMessage === 'string' ? branch.parentLastMessage : lastVisibleMessageContent(target?.messages),
            parentLastMessageRole: typeof branch.parentLastMessageRole === 'string' ? branch.parentLastMessageRole : lastVisibleMessageRole(target?.messages),
            workspace: typeof branch.workspace === 'string' ? branch.workspace : null,
          })
        }
        void switchSession(newSessionId)
      }
    }

    const message = String((evt as any).message || '')
    if (message) {
      addMessage(sid, {
        id: uid(),
        role: 'command',
        content: message,
        timestamp: Date.now(),
        systemType: (evt as any).ok === false ? 'error' : 'command',
        commandAction: action,
        commandData: { ...(evt as any) },
      })
    }
  }

  function handleAgentEvent(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    if ((evt as any).source === 'coding_agent' && (evt as any).kind === 'status') return
    const text = String((evt as any).text || (evt as any).message || '').trim()
    if (!text) return

    const msgs = getSessionMsgs(sid)
    const last = msgs[msgs.length - 1]
    const commandData = { ...(evt as any) }
    if (last?.role === 'system' && last.commandAction === 'agent.event') {
      if (last.content === text) return
      updateMessage(sid, last.id, {
        content: text,
        timestamp: Date.now(),
        commandData,
      })
      return
    }

    addMessage(sid, {
      id: uid(),
      role: 'system',
      content: text,
      timestamp: Date.now(),
      commandAction: 'agent.event',
      commandData,
    })
  }


  function updateSessionTitle(sessionId: string) {
    const target = sessions.value.find(s => s.id === sessionId)
    if (!target) return
    if (!target.title) {
      const firstUser = target.messages.find(m => m.role === 'user')
      if (firstUser) {
        const title = firstUser.attachments?.length
          ? firstUser.attachments.map(a => a.name).join(', ')
          : firstUser.content
        target.title = title.slice(0, 40) + (title.length > 40 ? '...' : '')
      }
    }
    target.updatedAt = Date.now()
  }

  function applyGeneratedSessionTitle(evt: RunEvent) {
    const sid = evt.session_id
    const title = typeof (evt as any).title === 'string' ? (evt as any).title.trim() : ''
    if (!sid || !title) return
    const target = sessions.value.find(s => s.id === sid)
    if (target) {
      target.title = title
      target.updatedAt = Date.now()
    }
    if (activeSession.value?.id === sid) {
      activeSession.value.title = title
    }
  }

  function applySessionWorkspaceUpdate(evt: RunEvent) {
    const sid = evt.session_id
    const workspace = typeof evt.workspace === 'string' ? evt.workspace.trim() : ''
    if (!sid || !workspace) return
    const target = sessions.value.find(s => s.id === sid)
    if (target) {
      target.workspace = workspace
      target.isLocalOnly = false
    }
    if (activeSession.value?.id === sid) {
      activeSession.value.workspace = workspace
      activeSession.value.isLocalOnly = false
    }
  }

  function applySessionSettingsUpdate(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    const targets = [sessions.value.find(s => s.id === sid), activeSession.value?.id === sid ? activeSession.value : null]
      .filter((session): session is Session => Boolean(session))
    for (const target of new Set(targets)) {
      if (typeof evt.model === 'string') target.model = evt.model
      if (typeof evt.provider === 'string') target.provider = evt.provider
      if (typeof evt.api_mode === 'string') target.apiMode = evt.api_mode as ProviderApiMode || undefined
      if (typeof evt.reasoning_effort === 'string') {
        const incomingEffort = evt.reasoning_effort || undefined
        const pendingEffort = reasoningEffortWriteTargets.get(sid)
        if (!reasoningEffortWriteTargets.has(sid) || pendingEffort === incomingEffort) {
          target.reasoningEffort = incomingEffort
        }
      }
    }
  }

  function applyResumedSessionSettings(data: ResumeSessionPayload) {
    applySessionSettingsUpdate({
      event: 'session.settings.updated',
      session_id: data.session_id,
      ...(typeof data.model === 'string' ? { model: data.model } : {}),
      ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
      ...(typeof data.api_mode === 'string' ? { api_mode: data.api_mode || undefined } : {}),
      ...(typeof data.reasoning_effort === 'string' ? { reasoning_effort: data.reasoning_effort } : {}),
    })
  }

  function primeNotificationSoundIfEnabled() {
    const { display } = useSettingsStore()
    if (display.bell_on_complete || display.approval_bell) {
      primeCompletionSound()
    }
  }

  function playCompletionBellIfEnabled() {
    if (useSettingsStore().display.bell_on_complete) {
      void playCompletionSound()
    }
  }

  function truncateNotificationText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
  }

  function completionNotificationAgent(session: Session): { icon: string } {
    const codingAgentId = session.codingAgentId || agentToCodingAgentId(session.agent)
    if (codingAgentId === 'codex') {
      return { icon: '/coding-agents/codex-openai.png' }
    }
    if (codingAgentId === 'claude-code') {
      return { icon: '/coding-agents/claude-code.svg' }
    }
if (codingAgentId === 'dsh') {
      return { icon: '/coding-agents/dsh.svg' }
    }
    if (codingAgentId === 'pi') {
      return { icon: '/coding-agents/pi.svg' }
    }
    if (codingAgentId === 'ekko-agent') {
      return { icon: '/coding-agents/ekko-agent.png' }
    }
    return { icon: '/coding-agents/hermes.png' }
  }

  function completionNotificationBody(session: Session, message?: Message): string {
    const preview = message?.content || session.title || 'Message complete.'
    return truncateNotificationText(preview, 140)
  }

  function showCompletionNotificationIfEnabled(sessionId: string, messageId?: string | null) {
    const settingsStore = useSettingsStore()
    if (!settingsStore.display.notify_on_complete) return

    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    const message = messageId
      ? session.messages.find(m => m.id === messageId)
      : [...session.messages].reverse().find(m => m.role === 'assistant')

    const agent = completionNotificationAgent(session)
    void showCompletionNotification({
      title: truncateNotificationText(session.title || 'Hermes', 80),
      body: completionNotificationBody(session, message),
      icon: agent.icon,
      tag: `hermes-complete-${sessionId}-${message?.id || Date.now()}`,
    })
  }

  async function sendMessage(content: string, attachments?: Attachment[]) {
    if ((!content.trim() && !(attachments && attachments.length > 0))) return

    primeNotificationSoundIfEnabled()

    const trimmedContent = content.trim()

    if (!activeSession.value) {
      const session = createSession()
      switchSession(session.id)
    }

    // Capture session ID at send time — all callbacks use this, not activeSessionId
    const sid = activeSessionId.value!
    const shouldSendInitialSessionConfig = activeSession.value
      ? activeSession.value.messageCount == null || activeSession.value.messageCount === 0
      : false
    const isCodingAgentSession = isCodingAgentLikeSession(activeSession.value)
    const isBridgeSlashCommand = !isCodingAgentSession && isKnownBridgeSessionCommand(trimmedContent)
    const isBridgeCompressCommand = isBridgeSlashCommand && /^\/compress(?:\s|$)/i.test(trimmedContent)
    const isBridgePlanCommand = isBridgeSlashCommand && /^\/plan(?:\s|$)/i.test(trimmedContent)
    const isBridgeSkillCommand = isBridgeSlashCommand && /^\/skill(?:\s|$)/i.test(trimmedContent)
    const isBridgeBundleCommand = isBridgeSlashCommand && /^\/bundles(?:\s|$)/i.test(trimmedContent)
    const isBridgeMoaCommand = isBridgeSlashCommand && /^\/moa(?:\s|$)/i.test(trimmedContent)
    const isBridgeGoalCommand = isBridgeSlashCommand && /^\/goal(?:\s|$)/i.test(trimmedContent)
    const isBridgeForkCommand = isBridgeSlashCommand && /^\/fork(?:\s|$)/i.test(trimmedContent)
    const messageReference = isBridgeSlashCommand ? null : messageReferences.value.get(sid) || null
    const submittedContent = messageReference
      ? formatMessageWithReference(messageReference, trimmedContent)
      : trimmedContent
    const shouldOptimisticallyShowRunStatus = !isCodingAgentSession && !isBridgeForkCommand
    const wasLiveBeforeSend = isSessionLive(sid)
    if (isBridgeForkCommand) {
      if (pendingForkCommands.value.has(sid)) return
      pendingForkCommands.value = new Set(pendingForkCommands.value).add(sid)
    }
    const shouldQueue = wasLiveBeforeSend && (
      !isBridgeSlashCommand ||
      isBridgePlanCommand ||
      isBridgeSkillCommand ||
      isBridgeBundleCommand ||
      isBridgeMoaCommand
    )
    if (isBridgeSlashCommand && !shouldQueue && !wasLiveBeforeSend) {
      settleRuntimeDisplayForCommand(sid)
    }

    const userMsg: Message = {
      id: uid(),
      role: isBridgeSlashCommand ? 'command' : 'user',
      content: submittedContent,
      timestamp: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      queued: shouldQueue,
      systemType: isBridgeSlashCommand ? 'command' : undefined,
    }

    if (shouldQueue) {
      enqueueUserMessage(sid, userMsg)
    } else {
      addMessage(sid, userMsg)
      updateSessionTitle(sid)
      if (shouldOptimisticallyShowRunStatus) serverWorking.value.add(sid)
    }
    clearMessageReference(sid)

    let runSubmitted = false
    try {

      // Build input in Anthropic format
      let input: string | ContentBlock[]
      let displayInput: string | ContentBlock[] | undefined
      if (attachments && attachments.length > 0) {
        // Has attachments: upload first, then build content blocks
        const uploaded = await uploadFiles(attachments)

        // Update attachment URLs on the user message for display
        const urlMap = new Map(uploaded.map(f => {
          return [f.name, getDownloadUrl(f.path, f.name)]
        }))
        if (shouldQueue && userMsg.attachments) {
          userMsg.attachments = userMsg.attachments.map(a => {
            const dl = urlMap.get(a.name)
            return dl ? { ...a, url: dl } : a
          })
          updateQueuedUserMessage(sid, userMsg.id, { attachments: userMsg.attachments })
        } else {
          const msgs = getSessionMsgs(sid)
          const lastUser = msgs.findLast(m => m.id === userMsg.id)
          if (lastUser?.attachments) {
            lastUser.attachments = lastUser.attachments.map(a => {
              const dl = urlMap.get(a.name)
              return dl ? { ...a, url: dl } : a
            })
          }
        }

        // Build content blocks with uploaded file paths
        input = await buildContentBlocks(submittedContent, attachments, uploaded)
        if (attachments.some(attachment => attachment.context?.trim())) {
          displayInput = await buildContentBlocks(submittedContent, attachments, uploaded, false)
        }
      } else {
        // No attachments: use plain text format
        input = submittedContent
      }

      const appStore = useAppStore()
      await appStore.waitForModelsForRun()
      const sessionModel = activeSession.value?.model || appStore.selectedModel
      const sessionProvider = activeSession.value?.provider || appStore.selectedProvider
      const sessionProfile = activeSession.value?.profile || useProfilesStore().activeProfileName || undefined
      const profileModelGroups = sessionProfile
        ? appStore.profileModelGroups.find(entry => entry.profile === sessionProfile)?.groups
        : undefined
      const runModelGroups = profileModelGroups?.length ? profileModelGroups : appStore.modelGroups
      const providerGroup = runModelGroups.find(group => group.provider === sessionProvider)
      const storedSource = activeSession.value?.source
      const sessionSource: StartRunRequest['source'] = storedSource === 'trpg_recap' ? 'trpg_recap' : storedSource === 'global_agent'
        ? 'global_agent'
        : storedSource === 'workflow'
          ? 'workflow'
        : isCodingAgentSession
          ? 'coding_agent'
          : storedSource === 'api_server'
            ? 'api_server'
            : 'cli'
      const isCodingAgentExecution = sessionSource === 'coding_agent' || (sessionSource === 'workflow' && isCodingAgentSession)
      const codingAgentId: ChatCodingAgentId =
        activeSession.value?.codingAgentId ||
        agentToCodingAgentId(activeSession.value?.agent) ||
        'claude-code'
      const codingAgentMode = activeSession.value?.codingAgentMode || 'scoped'
      const codingAgentApiMode = isCodingAgentExecution && codingAgentMode !== 'global'
        ? normalizeCodingAgentApiMode(
            activeSession.value?.apiMode || providerGroup?.api_mode,
            inferCodingAgentApiMode(
              sessionProvider || providerGroup?.provider,
              activeSession.value?.baseUrl || providerGroup?.base_url,
            ),
          )
        : undefined
      const runPayload: StartRunRequest = {
        input,
        ...(displayInput ? { display_input: displayInput } : {}),
        session_id: sid,
        profile: sessionProfile,
        model: isCodingAgentExecution
          ? (codingAgentMode === 'global' ? undefined : sessionModel || undefined)
          : shouldSendInitialSessionConfig ? sessionModel || undefined : undefined,
        provider: isCodingAgentExecution
          ? (codingAgentMode === 'global' ? undefined : sessionProvider || undefined)
          : shouldSendInitialSessionConfig ? sessionProvider || undefined : undefined,
        model_groups: runModelGroups.map(group => ({
          provider: group.provider,
          models: group.models,
        })),
        queue_id: userMsg.id,
        workspace: activeSession.value?.workspace || undefined,
        category_id: activeSession.value?.categoryId ?? null,
        source: sessionSource,
        ...(runtimeMode.value === 'global_agent' && sessionSource !== 'trpg_recap' ? { session_source: 'global_agent' as const } : {}),
        ...(sessionSource === 'workflow' ? { session_source: 'workflow' as const } : {}),
        ...(isCodingAgentExecution
          ? {
              coding_agent_id: codingAgentId,
              mode: codingAgentMode,
              baseUrl: codingAgentMode === 'global' ? undefined : activeSession.value?.baseUrl || providerGroup?.base_url || undefined,
              apiKey: codingAgentMode === 'global' ? undefined : activeSession.value?.apiKey || providerGroup?.api_key || undefined,
              apiMode: codingAgentApiMode,
            }
          : {}),
        // Per-session reasoning effort override. Hermes bridge and scoped coding
        // agents both consume this when the selected provider/API supports it.
        // Global coding-agent mode uses the user's native CLI config, so avoid
        // injecting a per-session override there.
        reasoning_effort: isCodingAgentExecution && codingAgentMode === 'global'
          ? undefined
          : activeSession.value?.reasoningEffort || undefined,
      }
      if (shouldSendInitialSessionConfig && activeSession.value) {
        activeSession.value.messageCount = Math.max(activeSession.value.messageCount || 0, 1)
      }

      // Helper to clean up this session's stream state
      const cleanup = () => {
        streamStates.value.delete(sid)
        serverWorking.value.delete(sid)
      }

      // Per-active-run flags used to detect silently-swallowed errors at run.completed.
      // hermes-agent occasionally emits run.completed with empty output and no
      // usage when the agent layer caught an upstream error (e.g. invalid API
      // key). We need to distinguish: (a) run with assistant text produced,
      // (b) run with only tool activity, (c) run with truly nothing visible.
      // Reset on every run.started because one handler may span multiple queued runs.
      let runProducedAssistantText = false
      let runProducedAssistantContent = false
      let runHadToolActivity = false
      let activeAssistantMessageId: string | null = null
      let reasoningAssistantMessageId: string | null = null
      let activeRunMarker: string | null = null

      const closeStreamingAssistant = () => {
        const msgs = getSessionMsgs(sid)
        msgs.forEach(m => {
          if (m.role === 'assistant' && m.isStreaming) {
            updateMessage(sid, m.id, { isStreaming: false })
          }
        })
        activeAssistantMessageId = null
        reasoningAssistantMessageId = null
        activeRunMarker = null
      }

      const applyReconnectResume = (data: ResumeSessionPayload) => {
        if (data.session_id !== sid) return
        const target = sessions.value.find(s => s.id === sid)
        if (!target) return

        if (data.isWorking) serverWorking.value.add(sid)
        else serverWorking.value.delete(sid)

        if (data.queueLength && data.queueLength > 0) {
          queueLengths.value.set(sid, data.queueLength)
        } else {
          queueLengths.value.delete(sid)
        }

        if (Array.isArray(data.queueMessages)) {
          replaceQueuedUserMessages(sid, normalizeQueuedUserMessages(data.queueMessages))
        } else if (!data.queueLength) {
          replaceQueuedUserMessages(sid, [])
        }
        replaceQueueInsertionState(sid, data.queueInsertion)

        if (data.isAborting) {
          setAbortState(sid, { aborting: true, synced: null })
        } else if (!data.isWorking) {
          setAbortState(sid, null)
        }
        if (!data.isWorking) setCompressionState(sid, null)

        if (data.inputTokens != null) target.inputTokens = data.inputTokens
        if (data.outputTokens != null) target.outputTokens = data.outputTokens
        if (data.contextTokens != null) target.contextTokens = data.contextTokens
        applyResumedSessionSettings(data)

        if (Array.isArray(data.messages)) {
          const previousActiveAssistantMessageId = activeAssistantMessageId
          const previousReasoningAssistantMessageId = reasoningAssistantMessageId
          const replayRunMarker = getReplayRunMarker(data.events) ?? activeRunMarker
          target.messages = mapHermesMessages(data.messages as any[])
          restorePersistedSubagentStreams(sid)
          target.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
          target.messageTotal = data.messageTotal ?? target.messageCount ?? target.loadedMessageCount
          target.messageCount = target.messageTotal
          target.hasMoreBefore = data.hasMoreBefore ?? target.loadedMessageCount < target.messageTotal
          restoreWorkspaceRunChangeMessages(sid)

          const resumedAssistantState = data.isWorking
            ? resolveResumedAssistantState(target.messages, {
                previousActiveAssistantMessageId,
                previousReasoningAssistantMessageId,
                activeRunMarker: replayRunMarker,
              })
            : {
                activeAssistant: null,
                reasoningAssistant: null,
                runMarker: null,
                hadVisibleText: false,
              }

          const resumedActiveAssistant = resumedAssistantState.activeAssistant
          const resumedReasoningAssistant = resumedAssistantState.reasoningAssistant
          activeRunMarker = resumedAssistantState.runMarker

          if (resumedActiveAssistant) {
            resumedActiveAssistant.isStreaming = true
            activeAssistantMessageId = resumedActiveAssistant.id
            if (resumedAssistantState.hadVisibleText) runProducedAssistantText = true
          } else {
            activeAssistantMessageId = null
          }

          if (resumedReasoningAssistant) {
            reasoningAssistantMessageId = resumedReasoningAssistant.id
            if (resumedReasoningAssistant.reasoning) noteReasoningStart(resumedReasoningAssistant.id)
          } else {
            reasoningAssistantMessageId = null
          }
        }

        if (data.events?.length) {
          for (const evt of data.events) {
            const e = evt.data as RunEvent
            switch (e.event) {
              case 'compression.started':
                setCompressionState(sid, {
                  compressing: true,
                  messageCount: (e as any).message_count || 0,
                  beforeTokens: (e as any).token_count || 0,
                  afterTokens: 0,
                  compressed: null,
                })
                break
              case 'compression.completed': {
                const afterTokens = (e as any).contextTokens || (e as any).afterTokens || 0
                setCompressionState(sid, {
                  compressing: false,
                  messageCount: (e as any).totalMessages || 0,
                  beforeTokens: (e as any).beforeTokens || 0,
                  afterTokens,
                  compressed: (e as any).compressed ?? false,
                  error: (e as any).error,
                })
                if ((e as any).contextTokens != null) target.contextTokens = (e as any).contextTokens
                break
              }
              case 'abort.started':
                setAbortState(sid, { aborting: true, synced: null })
                break
              case 'abort.timeout':
                setAbortState(sid, { aborting: true, synced: false, timedOut: true, message: (e as any).message })
                break
              case 'abort.completed':
                setAbortState(sid, { aborting: false, synced: (e as any).synced ?? false })
                settleInterruptedSubagents(sid)
                break
              case 'approval.requested':
                setPendingApproval({ ...e, session_id: sid })
                break
              case 'approval.resolved':
                clearPendingApproval({ ...e, session_id: sid })
                break
              case 'clarify.requested':
                setPendingClarify({ ...e, session_id: sid })
                break
              case 'clarify.resolved':
                clearPendingClarify({ ...e, session_id: sid })
                break
              case 'run.failed':
                handleTerminalWorkspaceRunChange(sid, e)
                if (!isQueueInsertionInterruption(e)) addAgentErrorMessage(sid, e.error)
                break
              case 'agent.event':
                handleAgentEvent(e)
                break
            }
          }
        }

        if (activeSessionId.value === sid) activeSession.value = target
        if (!data.isWorking && !(data.queueLength && data.queueLength > 0)) {
          clearAgentEventMessages(sid)
          cleanup()
          activeAssistantMessageId = null
          updateSessionTitle(sid)
        }
      }

      // Send run via Socket.IO and listen to streamed events — all closures capture `sid`
      const ctrl = startRunViaSocket(
        runPayload,
        // onEvent
        (evt: RunEvent) => {
          const eventRunMarker = readRunMarker(evt)
          if (eventRunMarker) activeRunMarker = eventRunMarker
          switch (evt.event) {
            case 'run.started':
              clearSessionCompletedUnread(sid)
              serverWorking.value.add(sid)
              clearAgentEventMessages(sid)
              setAbortState(sid, null)
              setCompressionState(sid, null)
              runProducedAssistantText = false
              runProducedAssistantContent = false
              runHadToolActivity = false
              closeStreamingAssistant()
              activeRunMarker = readRunMarker(evt) ?? null
              if ((evt as any).queue_length > 0) {
                queueLengths.value.set(sid, (evt as any).queue_length)
              } else {
                queueLengths.value.delete(sid)
              }
              break

            case 'run.queued': {
              handleRunQueuedEvent(sid, evt)
              break
            }

            case 'run.queue_insertion.updated': {
              handleQueueInsertionUpdated(evt)
              break
            }

            case 'session.command': {
              handleSessionCommandEvent(evt)
              break
            }

            case 'session.workspace.updated': {
              applySessionWorkspaceUpdate(evt)
              break
            }

            case 'session.settings.updated': {
              applySessionSettingsUpdate(evt)
              break
            }

            case 'agent.event': {
              handleAgentEvent(evt)
              break
            }

            case 'run.reattach_failed': {
              handleAgentEvent(evt)
              break
            }

            case 'compression.started': {
              setCompressionState(sid, {
                compressing: true,
                messageCount: (evt as any).message_count || 0,
                beforeTokens: (evt as any).token_count || 0,
                afterTokens: 0,
                compressed: null,
              })
              break
            }

            case 'compression.completed': {
              const afterTokens = (evt as any).contextTokens || (evt as any).afterTokens || 0
              setCompressionState(sid, {
                compressing: false,
                messageCount: (evt as any).totalMessages || 0,
                beforeTokens: (evt as any).beforeTokens || 0,
                afterTokens,
                compressed: (evt as any).compressed ?? false,
                error: (evt as any).error,
              })
              if ((evt as any).contextTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) target.contextTokens = (evt as any).contextTokens
              }
              // Auto-clear after 5s
              setTimeout(() => {
                const state = compressionStates.value.get(sid)
                if (state && !state.compressing) {
                  setCompressionState(sid, null)
                }
              }, 5000)
              break
            }

            case 'abort.started': {
              setAbortState(sid, { aborting: true, synced: null })
              break
            }

            case 'abort.timeout': {
              setAbortState(sid, { aborting: true, synced: false, timedOut: true, message: (evt as any).message })
              break
            }

            case 'abort.completed': {
              setAbortState(sid, { aborting: false, synced: (evt as any).synced ?? false })
              settleInterruptedSubagents(sid)
              clearPendingInteractions(sid)
              if ((evt as any).queue_length > 0) {
                queueLengths.value.set(sid, (evt as any).queue_length)
                setAbortState(sid, null)
                break
              }
              const msgs = getSessionMsgs(sid)
              const lastMsg = msgs[msgs.length - 1]
              if (lastMsg?.isStreaming) {
                updateMessage(sid, lastMsg.id, { isStreaming: false })
              }
              msgs.forEach((m, i) => {
                if (m.role === 'tool' && m.toolStatus === 'running') {
                  msgs[i] = { ...m, toolStatus: 'done' }
                }
              })
              cleanup()
              setAbortState(sid, null)
              break
            }

            case 'reasoning.delta':
            case 'thinking.delta': {
              const text = evt.text || evt.delta || ''
              if (!text) break
              runProducedAssistantText = true
              const msgs = getSessionMsgs(sid)
              const reasoningTargetId = reasoningAssistantMessageId || activeAssistantMessageId
              const last = reasoningTargetId
                ? msgs.find(m => m.id === reasoningTargetId)
                : null
              if (last?.role === 'assistant') {
                last.reasoning = (last.reasoning || '') + text
                reasoningAssistantMessageId = last.id
                noteReasoningStart(last.id)
              } else {
                const newId = uid()
                addMessage(sid, {
                  id: newId,
                  role: 'assistant',
                  content: '',
                  timestamp: Date.now(),
                  isStreaming: true,
                  reasoning: text,
                })
                activeAssistantMessageId = newId
                reasoningAssistantMessageId = newId
                noteReasoningStart(newId)
              }

              break
            }

            case 'moa.reference': {
              runHadToolActivity = true
              handleMoaEvent(sid, evt)
              break
            }

            case 'moa.aggregating': {
              runHadToolActivity = true
              handleMoaEvent(sid, evt)
              break
            }

            case 'reasoning.available': {
              // Upstream run_agent.py fires reasoning.available with
              // `assistant_message.content[:500]` as the preview — i.e.,
              // the main answer, not real reasoning. Ignore the payload
              // and only use this event as a "thinking ended" signal so
              // the duration counter stops.
              const msgs = getSessionMsgs(sid)
              const last = msgs[msgs.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) {
                // 只有当 reasoning.delta 事件曾经启动过计时，才标记结束；
                // 否则（上游未转发 delta，只发这一次 available）不显示时长。
                noteReasoningEnd(last.id)
              }

              break
            }

            case 'message.delta': {
              if (evt.delta) {
                runProducedAssistantText = true
                runProducedAssistantContent = true
              }
              const msgs = getSessionMsgs(sid)
              const last = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : null
              if (last?.role === 'assistant' && last.isStreaming) {
                const prev = last.content
                const next = prev + (evt.delta || '')
                noteThinkingDelta(last.id, prev, next)
                // 若之前有 reasoning 累积，则 content 到达即视为推理结束。
                if (last.reasoning) noteReasoningEnd(last.id)
                last.content = next
              } else {
                const newId = uid()
                const nextContent = evt.delta || ''
                noteThinkingDelta(newId, '', nextContent)
                addMessage(sid, {
                  id: newId,
                  role: 'assistant',
                  content: nextContent,
                  timestamp: Date.now(),
                  isStreaming: true,
                })
                activeAssistantMessageId = newId
              }

              break
            }

            case 'message.interim': {
              const text = String(evt.text || '')
              if (!text.trim()) break
              runProducedAssistantText = true
              runProducedAssistantContent = true
              const msgs = getSessionMsgs(sid)
              const active = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : null
              if (active?.role === 'assistant') {
                active.content = text
                active.isStreaming = false
                if (active.reasoning) noteReasoningEnd(active.id)
              } else {
                addMessage(sid, {
                  id: uid(),
                  role: 'assistant',
                  content: text,
                  timestamp: Date.now(),
                  isStreaming: false,
                })
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null

              break
            }

            case 'session.title.updated': {
              applyGeneratedSessionTitle(evt)
              break
            }

            case 'tool.started': {
              runHadToolActivity = true
              const startedToolName = evt.tool || evt.name
              if (
                isBackgroundDelegateToolPayload(startedToolName, (evt as any).arguments)
                || (isEkkoAgentSession(sid) && startedToolName === 'delegate_task')
              ) break
              const msgs = getSessionMsgs(sid)
              const toolCallId = (evt as any).tool_call_id as string | undefined
              const last = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : msgs[msgs.length - 1]
              const toolReasoning =
                last?.role === 'assistant' && last.reasoning?.trim()
                  ? last.reasoning
                  : undefined
              if (last?.isStreaming) {
                updateMessage(sid, last.id, { isStreaming: false })
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              const existingTool = toolCallId
                ? msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
                : null
              if (existingTool) {
                updateMessage(sid, existingTool.id, {
                  toolName: evt.tool || evt.name,
                  runMarker: existingTool.runMarker || readRunMarker(evt),
                  toolArgs: hasRuntimeToolPayload((evt as any).arguments) ? (evt as any).arguments : existingTool.toolArgs,
                  toolPreview: evt.preview || existingTool.toolPreview,
                  reasoning: existingTool.reasoning || toolReasoning,
                  toolStatus: existingTool.toolStatus || 'running',
                })
                break
              }
              addMessage(sid, {
                id: uid(),
                role: 'tool',
                content: '',
                timestamp: Date.now(),
                toolName: evt.tool || evt.name,
                toolCallId,
                runMarker: readRunMarker(evt),
                toolPreview: evt.preview,
                toolArgs: runtimeToolPayloadOrUndefined((evt as any).arguments),
                reasoning: toolReasoning,
                toolStatus: 'running',
              })

              break
            }

            case 'tool.completed':
            case 'tool.failed': {
              runHadToolActivity = true
              const msgs = getSessionMsgs(sid)
              const toolCallId = (evt as any).tool_call_id as string | undefined
              const toolMsgs = toolCallId
                ? msgs.filter(m => m.role === 'tool' && m.toolCallId === toolCallId)
                : msgs.filter(m => m.role === 'tool' && m.toolStatus === 'running')
              const output = runtimeToolOutputFromEvent(evt)
              const toolName = evt.tool || evt.name || toolMsgs[toolMsgs.length - 1]?.toolName
              if (isBackgroundDelegateToolPayload(toolName, output)) {
                const session = sessions.value.find(item => item.id === sid)
                if (session) session.messages = session.messages.filter(message => !toolMsgs.includes(message))
                addHermesBackgroundDelegateAnchors(
                  sid,
                  toolCallId,
                  output,
                  toolMsgs[toolMsgs.length - 1]?.toolArgs,
                )
                break
              }
              if (
                isEkkoAgentSession(sid)
                && toolName === 'delegate_task'
                && runtimeObjectPayload(output)?.runtime === 'ekko'
              ) {
                const session = sessions.value.find(item => item.id === sid)
                if (session) session.messages = session.messages.filter(message => !toolMsgs.includes(message))
                break
              }
              if (toolMsgs.length > 0) {
                const last = toolMsgs[toolMsgs.length - 1]
                const hasError = evt.event === 'tool.failed' || (evt as any).error === true || runtimeToolOutputHasError(output)
                const duration = (evt as any).duration
                updateMessage(sid, last.id, {
                  runMarker: last.runMarker || readRunMarker(evt),
                  toolStatus: hasError ? 'error' : 'done',
                  toolDuration: duration,
                  toolResult: output,
                })
              }

              break
            }

            case 'workspace.diff.completed': {
              activeAssistantMessageId = handleWorkspaceRunChangeEvent(sid, evt, activeAssistantMessageId)
              break
            }

            case 'subagent.start':
            case 'subagent.tool':
            case 'subagent.progress':
            case 'subagent.text':
            case 'subagent.thinking':
            case 'subagent.complete':
            case 'delegation.updated': {
              runHadToolActivity = true
              handleSubagentEvent(sid, evt)
              break
            }

            case 'approval.requested': {
              setPendingApproval(evt)
              break
            }

            case 'approval.resolved': {
              clearPendingApproval(evt)
              break
            }

            case 'clarify.requested': {
              setPendingClarify(evt)
              break
            }

            case 'clarify.resolved': {
              clearPendingClarify(evt)
              break
            }

            case 'run.completed': {
              const msgs = getSessionMsgs(sid)
              const lastMsg = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : msgs[msgs.length - 1]
              const completedAssistantMessageId = lastMsg?.role === 'assistant' && lastMsg.isStreaming
                ? lastMsg.id
                : null
              clearAgentEventMessages(sid)
              if (lastMsg?.isStreaming) {
                updateMessage(sid, lastMsg.id, { isStreaming: false })
              }
              settleRunningTools(sid, 'done')
              // Server-computed usage (local countTokens, snapshot-aware)
              if ((evt as any).inputTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) {
                  target.inputTokens = (evt as any).inputTokens
                  target.outputTokens = (evt as any).outputTokens
                  if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
                }
              }
              // Belt-and-suspenders: some providers may deliver the final
              // assistant text only via run.completed.output (no message.delta
              // stream). If we never produced assistant text but the gateway
              // reports a non-empty output, fall back to rendering it as a
              // single assistant message so the user actually sees the reply.

              // Check if backend provided parsed content (from stringified array format)
              let finalOutputTrimmed = ''
              if ((evt as any).parsed_content !== undefined) {
                // Backend has parsed stringified array format, update last assistant message
                const msgs = getSessionMsgs(sid)
                const lastAssistant = activeAssistantMessageId
                  ? msgs.find(m => m.id === activeAssistantMessageId)
                  : completedAssistantMessageId
                    ? msgs.find(m => m.id === completedAssistantMessageId)
                    : undefined
                const parsedContent = typeof (evt as any).parsed_content === 'string'
                  ? (evt as any).parsed_content
                  : ''
                const parsedContentTrimmed = parsedContent.trim()
                if (lastAssistant) {
                  const existingContentTrimmed = lastAssistant.content?.trim() ?? ''
                  if (parsedContentTrimmed || !existingContentTrimmed) {
                    updateMessage(sid, lastAssistant.id, {
                      content: parsedContent,
                    })
                    finalOutputTrimmed = parsedContentTrimmed
                    if (parsedContentTrimmed) {
                      runProducedAssistantText = true
                      runProducedAssistantContent = true
                    }
                  } else {
                    finalOutputTrimmed = existingContentTrimmed
                    runProducedAssistantText = true
                  }
                  if ((evt as any).parsed_reasoning) {
                    updateMessage(sid, lastAssistant.id, {
                      reasoning: (evt as any).parsed_reasoning,
                    })
                  }
                } else if (parsedContentTrimmed) {
                  addMessage(sid, {
                    id: uid(),
                    role: 'assistant',
                    content: parsedContent,
                    reasoning: typeof (evt as any).parsed_reasoning === 'string' ? (evt as any).parsed_reasoning : undefined,
                    timestamp: Date.now(),
                  })
                  finalOutputTrimmed = parsedContentTrimmed
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
                }
              } else {
                // Fallback to output field (legacy behavior)
                const finalOutput =
                  typeof evt.output === 'string' ? evt.output : ''
                finalOutputTrimmed = finalOutput.trim()
                if (!runProducedAssistantContent && finalOutputTrimmed !== '') {
                  const activeAssistant = activeAssistantMessageId
                    ? getSessionMsgs(sid).find(message =>
                        message.id === activeAssistantMessageId && message.role === 'assistant')
                    : null
                  if (activeAssistant) {
                    updateMessage(sid, activeAssistant.id, { content: finalOutput })
                  } else {
                    addMessage(sid, {
                      id: uid(),
                      role: 'assistant',
                      content: finalOutput,
                      timestamp: Date.now(),
                    })
                  }
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
                }
              }
              // Workaround for upstream hermes-agent bug: when the agent
              // layer silently swallows an error (e.g. invalid API key,
              // unsupported model), the gateway still emits run.completed
              // with an empty output. Without surfacing it here the chat UI
              // looks frozen / "succeeded with no reply". Detect by the
              // combination of: no assistant text AND no tool activity AND
              // empty final output. Usage being zero is a *supporting*
              // signal but not required, since some providers/local models
              // legitimately omit usage.
              const queueInsertionInterruption = isQueueInsertionInterruption(evt)
              const swallowedError =
                !runProducedAssistantText &&
                !runHadToolActivity &&
                finalOutputTrimmed === '' &&
                !queueInsertionInterruption
              if (swallowedError) {
                addMessage(sid, {
                  id: uid(),
                  role: 'system',
                  content: 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.',
                  timestamp: Date.now(),
                })
              } else {
                playCompletionBellIfEnabled()
                showCompletionNotificationIfEnabled(sid, completedAssistantMessageId)
              }
              const terminalAssistantMessageId = completedAssistantMessageId || [...getSessionMsgs(sid)]
                .reverse()
                .find(message => message.role === 'assistant' && String(message.content || '').trim())
                ?.id
              handleTerminalWorkspaceRunChange(sid, evt, terminalAssistantMessageId)
              attachWorkspaceChangesToMessages(sid)

              // 自动播放语音
              if (autoPlaySpeechEnabled.value && runProducedAssistantContent) {
                const msgs = getSessionMsgs(sid)
                const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
                if (lastAssistant?.content) {
                  // 延迟一小会儿再播放，确保 UI 更新完成
                  setTimeout(() => {
                    playMessageSpeech(lastAssistant.id, lastAssistant.content)
                  }, 300)
                }
              }

              const hasQueue = (evt as any).queue_remaining > 0
              markSessionCompletedUnread(sid, hasQueue)
              if (hasQueue) {
                queueLengths.value.set(sid, (evt as any).queue_remaining)
              } else {
                cleanup()
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              activeRunMarker = null
              updateSessionTitle(sid)
              break
            }

            case 'run.failed': {
              clearPendingInteractions(sid)
              const failedMessages = getSessionMsgs(sid)
              const failedAssistant = activeAssistantMessageId
                ? failedMessages.find(message => message.id === activeAssistantMessageId)
                : [...failedMessages].reverse().find(message => message.role === 'assistant' && message.isStreaming)
              const queueInsertionInterruption = isQueueInsertionInterruption(evt)
              handleTerminalWorkspaceRunChange(sid, evt, failedAssistant?.id)
              clearAgentEventMessages(sid)
              if ((evt as any).inputTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) {
                  target.inputTokens = (evt as any).inputTokens
                  target.outputTokens = (evt as any).outputTokens
                  if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
                }
              }
              if (queueInsertionInterruption) {
                if (failedAssistant?.isStreaming) updateMessage(sid, failedAssistant.id, { isStreaming: false })
                settleRunningTools(sid, 'done')
              } else {
                addAgentErrorMessage(sid, evt.error)
                settleRunningTools(sid, 'error')
              }
              if ((evt as any).queue_remaining > 0) {
                queueLengths.value.set(sid, (evt as any).queue_remaining)
              } else {
                cleanup()
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              activeRunMarker = null
              break
            }

            case 'usage.updated': {
              const target = sessions.value.find(s => s.id === sid)
              if (target) {
                target.inputTokens = (evt as any).inputTokens
                target.outputTokens = (evt as any).outputTokens
                if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
              }
              break
            }
          }
        },
        // onDone
        () => {
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.isStreaming) {
            updateMessage(sid, last.id, { isStreaming: false })
          }
          cleanup()
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
          updateSessionTitle(sid)
        },
        // onError
        (err) => {
          console.warn('Socket.IO run stream error:', err.message)
          addAgentErrorMessage(sid, err.message)
          const msgs = getSessionMsgs(sid)
          msgs.forEach((m, i) => {
            if (m.role === 'tool' && m.toolStatus === 'running') {
              msgs[i] = { ...m, toolStatus: 'error' }
            }
          })
          cleanup()
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
        },
        undefined,
        { onReconnectResume: applyReconnectResume, transport: runtimeTransport() },
      )
      runSubmitted = true

      if (isCodingAgentSession) {
        serverWorking.value.add(sid)
        streamStates.value.set(sid, ctrl)
      } else if (!isBridgeSlashCommand || isBridgeCompressCommand || isBridgePlanCommand || isBridgeGoalCommand) {
        streamStates.value.set(sid, ctrl)
      }
    } catch (err: any) {
      if (isBridgeForkCommand) {
        const nextPendingForkCommands = new Set(pendingForkCommands.value)
        nextPendingForkCommands.delete(sid)
        pendingForkCommands.value = nextPendingForkCommands
      }
      if (shouldQueue && !runSubmitted) {
        dropQueuedUserMessage(sid, userMsg.id)
      }
      if (!shouldQueue && !runSubmitted) {
        serverWorking.value.delete(sid)
      }
      addMessage(sid, {
        id: uid(),
        role: 'system',
        content: `Error: ${err.message}`,
        timestamp: Date.now(),
      })
    }
  }

  /**
   * Resume an in-flight run after page refresh.
   * Emits 'resume' to join the session room on the server,
   * then sets up event listeners to receive ongoing events.
   */
  function resumeServerWorkingRun(sid: string, force = false, passive = false) {
    // Don't register duplicate listeners if already streaming
    if (streamStates.value.has(sid)) return
    // Only set up listeners if the server reported an active run during resume.
    if (!force && !serverWorking.value.has(sid)) return

    let closed = false
    let runProducedAssistantText = false
    let runProducedAssistantContent = false
    let runHadToolActivity = false
    let activeAssistantMessageId: string | null = null
    let reasoningAssistantMessageId: string | null = null
    let activeRunMarker: string | null = null

    const cleanup = () => {
      if (closed) return
      closed = true
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
      // Unregister from global session handlers
      unregisterSessionHandlers(sid)
    }

    const markIdleKeepingBackgroundListener = () => {
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
    }

    const ensureAbortHandle = () => {
      if (streamStates.value.has(sid)) return
      streamStates.value.set(sid, {
        abort: () => {
          getChatRunSocket(runtimeTransport())?.emit('abort', { session_id: sid })
        },
      })
    }

    const closeStreamingAssistant = () => {
      const msgs = getSessionMsgs(sid)
      msgs.forEach(m => {
        if (m.role === 'assistant' && m.isStreaming) {
          updateMessage(sid, m.id, { isStreaming: false })
        }
      })
      activeAssistantMessageId = null
      reasoningAssistantMessageId = null
      activeRunMarker = null
    }

    const initializeResumedAssistantState = () => {
      const resumedAssistantState = resolveResumedAssistantState(getSessionMsgs(sid), { activeRunMarker })
      activeRunMarker = resumedAssistantState.runMarker
      if (resumedAssistantState.activeAssistant) {
        resumedAssistantState.activeAssistant.isStreaming = true
        activeAssistantMessageId = resumedAssistantState.activeAssistant.id
        if (resumedAssistantState.hadVisibleText) runProducedAssistantText = true
      }
      if (resumedAssistantState.reasoningAssistant) {
        reasoningAssistantMessageId = resumedAssistantState.reasoningAssistant.id
        if (resumedAssistantState.reasoningAssistant.reasoning) {
          noteReasoningStart(resumedAssistantState.reasoningAssistant.id)
        }
      }
    }

    initializeResumedAssistantState()

    // Shared event handler — filters by session_id tag
    function handleEvent(evt: RunEvent) {
      if (closed) return
      // Filter events for this session (server tags all events with session_id)
      if (evt.session_id && evt.session_id !== sid) return
      const eventRunMarker = readRunMarker(evt)
      if (eventRunMarker) activeRunMarker = eventRunMarker
      switch (evt.event) {
        case 'run.queued': {
          handleRunQueuedEvent(sid, evt)
          break
        }

        case 'run.queue_insertion.updated': {
          handleQueueInsertionUpdated(evt)
          break
        }

        case 'session.command': {
          handleSessionCommandEvent(evt)
          break
        }

        case 'session.workspace.updated': {
          applySessionWorkspaceUpdate(evt)
          break
        }

        case 'session.settings.updated': {
          applySessionSettingsUpdate(evt)
          break
        }

        case 'agent.event': {
          handleAgentEvent(evt)
          break
        }

        case 'run.reattach_failed': {
          handleAgentEvent(evt)
          break
        }

        case 'run.started':
          clearSessionCompletedUnread(sid)
          serverWorking.value.add(sid)
          ensureAbortHandle()
          clearAgentEventMessages(sid)
          setAbortState(sid, null)
          setCompressionState(sid, null)
          runProducedAssistantText = false
          runProducedAssistantContent = false
          runHadToolActivity = false
          closeStreamingAssistant()
          activeRunMarker = readRunMarker(evt) ?? null
          if ((evt as any).queue_length > 0) {
            queueLengths.value.set(sid, (evt as any).queue_length)
          } else {
            queueLengths.value.delete(sid)
          }
          break

        case 'compression.started': {
          setCompressionState(sid, {
            compressing: true,
            messageCount: (evt as any).message_count || 0,
            beforeTokens: (evt as any).token_count || 0,
            afterTokens: 0,
            compressed: null,
          })
          break
        }

        case 'compression.completed': {
          const afterTokens = (evt as any).contextTokens || (evt as any).afterTokens || 0
          setCompressionState(sid, {
            compressing: false,
            messageCount: (evt as any).totalMessages || 0,
            beforeTokens: (evt as any).beforeTokens || 0,
            afterTokens,
            compressed: (evt as any).compressed ?? false,
            error: (evt as any).error,
          })
          if ((evt as any).contextTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) target.contextTokens = (evt as any).contextTokens
          }
          setTimeout(() => {
            const state = compressionStates.value.get(sid)
            if (state && !state.compressing) {
              setCompressionState(sid, null)
            }
          }, 5000)
          break
        }

        case 'abort.started': {
          setAbortState(sid, { aborting: true, synced: null })
          break
        }

        case 'abort.timeout': {
          setAbortState(sid, { aborting: true, synced: false, timedOut: true, message: (evt as any).message })
          break
        }

        case 'abort.completed': {
          setAbortState(sid, { aborting: false, synced: (evt as any).synced ?? false })
          settleInterruptedSubagents(sid)
          clearPendingInteractions(sid)
          if ((evt as any).queue_length > 0) {
            queueLengths.value.set(sid, (evt as any).queue_length)
            setAbortState(sid, null)
            break
          }
          const msgs = getSessionMsgs(sid)
          const lastMsg = msgs[msgs.length - 1]
          if (lastMsg?.isStreaming) {
            updateMessage(sid, lastMsg.id, { isStreaming: false })
          }
          msgs.forEach((m, i) => {
            if (m.role === 'tool' && m.toolStatus === 'running') {
              msgs[i] = { ...m, toolStatus: 'done' }
            }
          })
          cleanup()
          setAbortState(sid, null)
          break
        }

        case 'reasoning.delta':
        case 'thinking.delta': {
          const text = evt.text || evt.delta || ''
          if (!text) break
          runProducedAssistantText = true
          const msgs = getSessionMsgs(sid)
          const reasoningTargetId = reasoningAssistantMessageId || activeAssistantMessageId
          const last = reasoningTargetId
            ? msgs.find(m => m.id === reasoningTargetId)
            : null
          if (last?.role === 'assistant') {
            last.reasoning = (last.reasoning || '') + text
            reasoningAssistantMessageId = last.id
            noteReasoningStart(last.id)
          } else {
            const newId = uid()
            addMessage(sid, {
              id: newId,
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              isStreaming: true,
              reasoning: text,
            })
            activeAssistantMessageId = newId
            reasoningAssistantMessageId = newId
            noteReasoningStart(newId)
          }

          break
        }

        case 'moa.reference': {
          runHadToolActivity = true
          handleMoaEvent(sid, evt)
          break
        }

        case 'moa.aggregating': {
          runHadToolActivity = true
          handleMoaEvent(sid, evt)
          break
        }

        case 'reasoning.available': {
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant' && last.isStreaming) {
            noteReasoningEnd(last.id)
          }

          break
        }

        case 'message.delta': {
          if (evt.delta) {
            runProducedAssistantText = true
            runProducedAssistantContent = true
          }
          const msgs = getSessionMsgs(sid)
          const last = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : null
          if (last?.role === 'assistant' && last.isStreaming) {
            const prev = last.content
            const next = prev + (evt.delta || '')
            noteThinkingDelta(last.id, prev, next)
            if (last.reasoning) noteReasoningEnd(last.id)
            last.content = next
          } else {
            const newId = uid()
            const nextContent = evt.delta || ''
            noteThinkingDelta(newId, '', nextContent)
            addMessage(sid, {
              id: newId,
              role: 'assistant',
              content: nextContent,
              timestamp: Date.now(),
              isStreaming: true,
            })
            activeAssistantMessageId = newId
          }

          break
        }

        case 'message.interim': {
          const text = String(evt.text || '')
          if (!text.trim()) break
          runProducedAssistantText = true
          runProducedAssistantContent = true
          const msgs = getSessionMsgs(sid)
          const active = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : null
          if (active?.role === 'assistant') {
            active.content = text
            active.isStreaming = false
            if (active.reasoning) noteReasoningEnd(active.id)
          } else {
            addMessage(sid, {
              id: uid(),
              role: 'assistant',
              content: text,
              timestamp: Date.now(),
              isStreaming: false,
            })
          }
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null

          break
        }

        case 'session.title.updated': {
          applyGeneratedSessionTitle(evt)
          break
        }

        case 'tool.started': {
          runHadToolActivity = true
          const startedToolName = evt.tool || evt.name
          if (
            isBackgroundDelegateToolPayload(startedToolName, (evt as any).arguments)
            || (isEkkoAgentSession(sid) && startedToolName === 'delegate_task')
          ) break
          const msgs = getSessionMsgs(sid)
          const toolCallId = (evt as any).tool_call_id as string | undefined
          const last = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : msgs[msgs.length - 1]
          const toolReasoning =
            last?.role === 'assistant' && last.reasoning?.trim()
              ? last.reasoning
              : undefined
          if (last?.isStreaming) {
            updateMessage(sid, last.id, { isStreaming: false })
          }
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          const existingTool = toolCallId
            ? msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
            : null
          if (existingTool) {
            updateMessage(sid, existingTool.id, {
              toolName: evt.tool || evt.name,
              runMarker: existingTool.runMarker || readRunMarker(evt),
              toolArgs: hasRuntimeToolPayload((evt as any).arguments) ? (evt as any).arguments : existingTool.toolArgs,
              toolPreview: evt.preview || existingTool.toolPreview,
              reasoning: existingTool.reasoning || toolReasoning,
              toolStatus: existingTool.toolStatus || 'running',
            })
            break
          }
          addMessage(sid, {
            id: uid(),
            role: 'tool',
            content: '',
            timestamp: Date.now(),
            toolName: evt.tool || evt.name,
            toolCallId,
            runMarker: readRunMarker(evt),
            toolPreview: evt.preview,
            toolArgs: runtimeToolPayloadOrUndefined((evt as any).arguments),
            reasoning: toolReasoning,
            toolStatus: 'running',
          })

          break
        }

        case 'tool.completed':
        case 'tool.failed': {
          runHadToolActivity = true
          const msgs = getSessionMsgs(sid)
          const toolCallId = (evt as any).tool_call_id as string | undefined
          const toolMsgs = toolCallId
            ? msgs.filter(m => m.role === 'tool' && m.toolCallId === toolCallId)
            : msgs.filter(m => m.role === 'tool' && m.toolStatus === 'running')
          const output = runtimeToolOutputFromEvent(evt)
          const toolName = evt.tool || evt.name || toolMsgs[toolMsgs.length - 1]?.toolName
          if (isBackgroundDelegateToolPayload(toolName, output)) {
            const session = sessions.value.find(item => item.id === sid)
            if (session) session.messages = session.messages.filter(message => !toolMsgs.includes(message))
            addHermesBackgroundDelegateAnchors(
              sid,
              toolCallId,
              output,
              toolMsgs[toolMsgs.length - 1]?.toolArgs,
            )
            break
          }
          if (
            isEkkoAgentSession(sid)
            && toolName === 'delegate_task'
            && runtimeObjectPayload(output)?.runtime === 'ekko'
          ) {
            const session = sessions.value.find(item => item.id === sid)
            if (session) session.messages = session.messages.filter(message => !toolMsgs.includes(message))
            break
          }
          if (toolMsgs.length > 0) {
            const hasError = evt.event === 'tool.failed' || (evt as any).error === true || runtimeToolOutputHasError(output)
            const last = toolMsgs[toolMsgs.length - 1]
            updateMessage(sid, last.id, {
              runMarker: last.runMarker || readRunMarker(evt),
              toolStatus: hasError ? 'error' : 'done',
              toolDuration: (evt as any).duration,
              toolResult: output,
            })
          }

          break
        }

        case 'workspace.diff.completed': {
          activeAssistantMessageId = handleWorkspaceRunChangeEvent(sid, evt, activeAssistantMessageId)
          break
        }

        case 'subagent.start':
        case 'subagent.tool':
        case 'subagent.progress':
        case 'subagent.text':
        case 'subagent.thinking':
        case 'subagent.complete':
        case 'delegation.updated': {
          runHadToolActivity = true
          handleSubagentEvent(sid, evt)
          break
        }

        case 'approval.requested': {
          setPendingApproval(evt)
          break
        }

        case 'approval.resolved': {
          clearPendingApproval(evt)
          break
        }

        case 'clarify.requested': {
          setPendingClarify(evt)
          break
        }

        case 'clarify.resolved': {
          clearPendingClarify(evt)
          break
        }

        case 'run.completed': {
          clearAgentEventMessages(sid)
          const hasQueue = (evt as any).queue_remaining > 0
          const hasBackground = (evt.background_pending || 0) > 0
          if (hasQueue) {
            queueLengths.value.set(sid, (evt as any).queue_remaining)
          } else {
            queueLengths.value.delete(sid)
          }
          const msgs = getSessionMsgs(sid)
          const lastMsg = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : msgs[msgs.length - 1]
          const completedAssistantMessageId = lastMsg?.role === 'assistant' && lastMsg.isStreaming
            ? lastMsg.id
            : null
          if (lastMsg?.isStreaming) {
            updateMessage(sid, lastMsg.id, { isStreaming: false })
          }
          settleRunningTools(sid, 'done')
          // Server-computed usage (local countTokens, snapshot-aware)
          if ((evt as any).inputTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) {
              target.inputTokens = (evt as any).inputTokens
              target.outputTokens = (evt as any).outputTokens
              if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
            }
          }
          // Check if backend provided parsed content (from stringified array format)
          let finalOutputTrimmed = ''
          if ((evt as any).parsed_content !== undefined) {
            // Backend has parsed stringified array format, update last assistant message
            const msgs = getSessionMsgs(sid)
            const lastAssistant = activeAssistantMessageId
              ? msgs.find(m => m.id === activeAssistantMessageId)
              : completedAssistantMessageId
                ? msgs.find(m => m.id === completedAssistantMessageId)
                : undefined
            const parsedContent = typeof (evt as any).parsed_content === 'string'
              ? (evt as any).parsed_content
              : ''
            const parsedContentTrimmed = parsedContent.trim()
            if (lastAssistant) {
              const existingContentTrimmed = lastAssistant.content?.trim() ?? ''
              if (parsedContentTrimmed || !existingContentTrimmed) {
                updateMessage(sid, lastAssistant.id, {
                  content: parsedContent,
                })
                finalOutputTrimmed = parsedContentTrimmed
                if (parsedContentTrimmed) {
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
                }
              } else {
                finalOutputTrimmed = existingContentTrimmed
                runProducedAssistantText = true
              }
              if ((evt as any).parsed_reasoning) {
                updateMessage(sid, lastAssistant.id, {
                  reasoning: (evt as any).parsed_reasoning,
                })
              }
            } else if (parsedContentTrimmed) {
              addMessage(sid, {
                id: uid(),
                role: 'assistant',
                content: parsedContent,
                reasoning: typeof (evt as any).parsed_reasoning === 'string' ? (evt as any).parsed_reasoning : undefined,
                timestamp: Date.now(),
              })
              finalOutputTrimmed = parsedContentTrimmed
              runProducedAssistantText = true
              runProducedAssistantContent = true
            }
          } else {
            // Fallback to output field (legacy behavior)
            const finalOutput = typeof evt.output === 'string' ? evt.output : ''
            finalOutputTrimmed = finalOutput.trim()
            if (!runProducedAssistantContent && finalOutputTrimmed !== '') {
              const activeAssistant = activeAssistantMessageId
                ? getSessionMsgs(sid).find(message =>
                    message.id === activeAssistantMessageId && message.role === 'assistant')
                : null
              if (activeAssistant) {
                updateMessage(sid, activeAssistant.id, { content: finalOutput })
              } else {
                addMessage(sid, {
                  id: uid(),
                  role: 'assistant',
                  content: finalOutput,
                  timestamp: Date.now(),
                })
              }
              runProducedAssistantText = true
              runProducedAssistantContent = true
            }
          }
          const queueInsertionInterruption = isQueueInsertionInterruption(evt)
          const swallowedError = !runProducedAssistantText
            && !runHadToolActivity
            && finalOutputTrimmed === ''
            && !queueInsertionInterruption
          if (swallowedError) {
            addMessage(sid, {
              id: uid(),
              role: 'system',
              content: 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.',
              timestamp: Date.now(),
            })
          } else {
            playCompletionBellIfEnabled()
            showCompletionNotificationIfEnabled(sid, completedAssistantMessageId)
          }
          const terminalAssistantMessageId = completedAssistantMessageId || [...getSessionMsgs(sid)]
            .reverse()
            .find(message => message.role === 'assistant' && String(message.content || '').trim())
            ?.id
          handleTerminalWorkspaceRunChange(sid, evt, terminalAssistantMessageId)
          attachWorkspaceChangesToMessages(sid)

          // Auto-play speech for every completed assistant message
          if (autoPlaySpeechEnabled.value && runProducedAssistantContent) {
            const msgs = getSessionMsgs(sid)
            const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
            if (lastAssistant?.content) {
              setTimeout(() => {
                playMessageSpeech(lastAssistant.id, lastAssistant.content)
              }, 300)
            }
          }

          if (!hasQueue && !hasBackground) {
            markSessionCompletedUnread(sid)
            cleanup()
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          } else if (hasQueue) {
            markSessionCompletedUnread(sid, true)
            // More runs pending — reset for next run but don't cleanup
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          } else {
            markSessionCompletedUnread(sid)
            markIdleKeepingBackgroundListener()
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          }
          updateSessionTitle(sid)
          break
        }

        case 'run.failed': {
          clearPendingInteractions(sid)
          const failedMessages = getSessionMsgs(sid)
          const failedAssistant = activeAssistantMessageId
            ? failedMessages.find(message => message.id === activeAssistantMessageId)
            : [...failedMessages].reverse().find(message => message.role === 'assistant' && message.isStreaming)
          const queueInsertionInterruption = isQueueInsertionInterruption(evt)
          handleTerminalWorkspaceRunChange(sid, evt, failedAssistant?.id)
          clearAgentEventMessages(sid)
          if ((evt as any).inputTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) {
              target.inputTokens = (evt as any).inputTokens
              target.outputTokens = (evt as any).outputTokens
              if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
            }
          }
          const hasQueue = (evt as any).queue_remaining > 0
          const hasBackground = (evt.background_pending || 0) > 0
          if (hasQueue) {
            queueLengths.value.set(sid, (evt as any).queue_remaining)
          } else {
            queueLengths.value.delete(sid)
          }
          if (queueInsertionInterruption) {
            if (failedAssistant?.isStreaming) updateMessage(sid, failedAssistant.id, { isStreaming: false })
            settleRunningTools(sid, 'done')
          } else {
            addAgentErrorMessage(sid, evt.error)
            settleRunningTools(sid, 'error')
          }
          if (!hasQueue && !hasBackground) {
            cleanup()
          } else if (hasBackground && !hasQueue) {
            markIdleKeepingBackgroundListener()
          }
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
          break
        }

        case 'usage.updated': {
          const target = sessions.value.find(s => s.id === sid)
          if (target) {
            target.inputTokens = (evt as any).inputTokens
            target.outputTokens = (evt as any).outputTokens
            if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
          }
          break
        }
      }
    }

    // Register handlers in global session map
    registerSessionHandlers(sid, {
      onMessageDelta: (evt) => handleEvent(evt),
      onMessageInterim: (evt) => handleEvent(evt),
      onReasoningDelta: (evt) => handleEvent(evt),
      onThinkingDelta: (evt) => handleEvent(evt),
      onReasoningAvailable: (evt) => handleEvent(evt),
      onToolStarted: (evt) => handleEvent(evt),
      onToolCompleted: (evt) => handleEvent(evt),
      onWorkspaceDiffCompleted: (evt) => handleEvent(evt),
      onSubagentEvent: (evt) => handleEvent(evt),
      onRunStarted: (evt) => handleEvent(evt),
      onRunCompleted: (evt) => handleEvent(evt),
      onRunFailed: (evt) => handleEvent(evt),
      onCompressionStarted: (evt) => handleEvent(evt),
      onCompressionCompleted: (evt) => handleEvent(evt),
      onAbortStarted: (evt) => handleEvent(evt),
      onAbortTimeout: (evt) => handleEvent(evt),
      onAbortCompleted: (evt) => handleEvent(evt),
      onUsageUpdated: (evt) => handleEvent(evt),
      onAgentEvent: (evt) => handleEvent(evt),
      onSessionCommand: (evt) => handleEvent(evt),
      onSessionWorkspaceUpdated: (evt) => handleEvent(evt),
      onSessionSettingsUpdated: applySessionSettingsUpdate,
      onRunQueued: (evt) => handleEvent(evt),
      onQueueInsertionUpdated: (evt) => handleEvent(evt),
      onClarifyRequested: (evt) => handleEvent(evt),
      onClarifyResolved: (evt) => handleEvent(evt),
    })

    // No need to emit resume here — switchSession already did it.
    // Server already joined room and replayed events.
    // Just set up handlers for ongoing streaming events.

    // A passive listener keeps background subagent telemetry alive without
    // making the parent session look busy. The abort handle is installed when
    // the completion notification starts its autonomous parent turn.
    if (!passive) ensureAbortHandle()
  }

  function handlePeerUserMessage(evt: RunEvent) {
    const sid = evt.session_id
    if (evt.event === 'approval.requested') return setPendingApproval(evt)
    if (evt.event === 'approval.resolved') return clearPendingApproval(evt)
    if (evt.event === 'clarify.requested') return setPendingClarify(evt)
    if (evt.event === 'clarify.resolved') return clearPendingClarify(evt)
    if (!sid || activeSessionId.value !== sid || !activeSession.value) return

    const peer = evt.message
    const content = typeof peer?.content === 'string' ? peer.content : ''
    if (!content.trim()) return

    const messageId = peer?.id != null ? String(peer.id) : ''
    const isPeerCommand = peer?.role === 'command'
    const msgs = getSessionMsgs(sid)
    if (messageId && msgs.some(msg => msg.id === messageId)) {
      serverWorking.value.add(sid)
      resumeServerWorkingRun(sid, true)
      return
    }
    if (messageId && (queuedUserMessages.value.get(sid) || []).some(msg => msg.id === messageId)) {
      if (isPeerCommand && !peer?.queued) {
        dropQueuedUserMessage(sid, messageId)
      } else {
        serverWorking.value.add(sid)
        resumeServerWorkingRun(sid, true)
        return
      }
    }

    const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
      ? Math.round(peer.timestamp * 1000)
      : Date.now()

    const message: Message = {
      id: messageId || uid(),
      role: isPeerCommand ? 'command' : 'user',
      content,
      timestamp,
      queued: !!peer?.queued,
      systemType: isPeerCommand ? 'command' : undefined,
    }
    const wasDequeued = messageId ? consumeDequeuedQueueId(sid, messageId) : false
    if (peer?.queued || (
      peer?.queued !== false
      && !isPeerCommand
      && !wasDequeued
      && isSessionLive(sid)
    )) {
      enqueueUserMessage(sid, message)
    } else {
      addMessage(sid, message)
      updateSessionTitle(sid)
    }
    serverWorking.value.add(sid)
    resumeServerWorkingRun(sid, true)
  }

  onPeerUserMessage(handlePeerUserMessage)

  function handleGlobalSessionCommand(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid || activeSessionId.value !== sid || !activeSession.value) return
    const shouldAttachToStartedRun = (evt as any).started === true && (evt as any).terminal === false
    handleSessionCommandEvent(evt)
    if (shouldAttachToStartedRun) {
      serverWorking.value.add(sid)
      resumeServerWorkingRun(sid, true)
    }
  }

  onSessionCommand(handleGlobalSessionCommand)

  onSessionTitleUpdated(applyGeneratedSessionTitle)
  onSessionWorkspaceUpdated(applySessionWorkspaceUpdate)
  onSessionSettingsUpdated(applySessionSettingsUpdate)

  function stopStreaming() {
    const sid = activeSessionId.value
    if (!sid) return
    if (isAborting.value) return
    clearPendingInteractions(sid)
    const ctrl = streamStates.value.get(sid)
    if (ctrl) {
      setAbortState(sid, { aborting: true, synced: null })
      ctrl.abort()
      const msgs = getSessionMsgs(sid)
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.isStreaming) {
        updateMessage(sid, lastMsg.id, { isStreaming: false })
      }
      return
    }
    if (serverWorking.value.has(sid)) {
      setAbortState(sid, { aborting: true, synced: null })
      getChatRunSocket(runtimeTransport())?.emit('abort', { session_id: sid })
      const msgs = getSessionMsgs(sid)
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.isStreaming) {
        updateMessage(sid, lastMsg.id, { isStreaming: false })
      }
    }
  }

  // Tab visibility: re-sync when returning to foreground
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !isStreaming.value) {
        // Live-sync the session list so sessions created elsewhere (CLI,
        // Telegram, another device) appear without a manual reload.
        void refreshSessionListOnly()
      }
      if (document.visibilityState === 'visible' && activeSessionId.value && !isStreaming.value) {
        const sid = activeSessionId.value
        if (sid && !streamStates.value.has(sid)) {
          // Re-load messages via resume (server loads from DB)
          resumeSession(sid, (data) => {
            if (data.isWorking) {
              serverWorking.value.add(sid)
            } else {
              serverWorking.value.delete(sid)
            }
            if (data.isAborting) {
              setAbortState(sid, { aborting: true, synced: null })
            } else if (!data.isWorking) {
              setAbortState(sid, null)
            }
            if (!data.isWorking) setCompressionState(sid, null)
            applyResumedSessionSettings(data)
            if (data.messages?.length && activeSession.value) {
              if (typeof data.workspace === 'string') {
                activeSession.value.workspace = data.workspace.trim() || null
                activeSession.value.isLocalOnly = false
              }
              activeSession.value.messages = mapHermesMessages(data.messages as any[])
              restorePersistedSubagentStreams(sid)
              activeSession.value.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
              activeSession.value.messageTotal = data.messageTotal ?? activeSession.value.messageCount ?? activeSession.value.loadedMessageCount
              activeSession.value.messageCount = activeSession.value.messageTotal
              activeSession.value.hasMoreBefore = data.hasMoreBefore ?? activeSession.value.loadedMessageCount < activeSession.value.messageTotal
              restoreWorkspaceRunChangeMessages(sid)
            }
            resumeServerWorkingRun(sid)
          }, activeSession.value?.profile, runtimeTransport())
        }
      }
    })
  }

  // Mild background polling for live session-list sync (covers sessions created
  // on the VM via CLI/Telegram while this client is in the foreground). Only
  // runs when the tab is visible and not streaming, so it's cheap and never
  // disrupts an active run. visibilitychange (above) handles the wake-from-hidden
  // case; this covers the "left it open and watching" case.
  if (typeof window !== 'undefined') {
    window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (isStreaming.value) return
      void refreshSessionListOnly()
    }, 12_000)
  }

  // Transient observation of <think> boundaries during active streaming.
  // Not persisted; cleared on session switch. See spec §5.3.
  const thinkingObservation = new Map<string, { startedAt?: number; endedAt?: number }>()

  function getThinkingObservation(messageId: string) {
    return thinkingObservation.get(messageId)
  }

  function noteThinkingDelta(messageId: string, prevContent: string, nextContent: string) {
    const { startedAtBoundary, endedAtBoundary } = detectThinkingBoundary(prevContent, nextContent)
    if (!startedAtBoundary && !endedAtBoundary) return
    const existing = thinkingObservation.get(messageId) || {}
    if (startedAtBoundary && existing.startedAt === undefined) {
      existing.startedAt = Date.now()
    }
    if (endedAtBoundary && existing.endedAt === undefined) {
      existing.endedAt = Date.now()
    }
    thinkingObservation.set(messageId, existing)
  }

  /** 第一次见到某条消息的 reasoning 文本时，标记 startedAt。 */
  function noteReasoningStart(messageId: string) {
    const existing = thinkingObservation.get(messageId) || {}
    if (existing.startedAt === undefined) {
      existing.startedAt = Date.now()
      thinkingObservation.set(messageId, existing)
    }
  }

  /** 内容首次到达（视为推理结束）或显式收到 reasoning.available 时，标记 endedAt。 */
  function noteReasoningEnd(messageId: string) {
    const existing = thinkingObservation.get(messageId)
    if (!existing || existing.startedAt === undefined) return
    if (existing.endedAt === undefined) {
      existing.endedAt = Date.now()
      thinkingObservation.set(messageId, existing)
    }
  }

  function clearProviderFromSessions(provider: string) {
    if (!provider) return
    const target = provider.toLowerCase()
    for (const s of sessions.value) {
      if ((s.provider || '').toLowerCase() === target) {
        s.model = undefined
        s.provider = ''
      }
    }
  }

  async function setSessionReasoningEffort(sessionId: string, effort: string): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const activeTarget = activeSession.value?.id === sessionId ? activeSession.value : null
    const session = target || activeTarget
    if (!session) return false

    const nextEffort = effort || undefined
    const previousEffort = session.reasoningEffort
    if (target) target.reasoningEffort = nextEffort
    if (activeTarget) activeTarget.reasoningEffort = nextEffort
    if (session.isLocalOnly) return true

    if (!reasoningEffortWriteChains.has(sessionId)) {
      reasoningEffortConfirmedValues.set(sessionId, previousEffort)
    }
    reasoningEffortWriteTargets.set(sessionId, nextEffort)
    const previousWrite = reasoningEffortWriteChains.get(sessionId) || Promise.resolve(true)
    const write: Promise<boolean> = previousWrite
      .catch(() => false)
      .then(() => persistSessionReasoningEffort(sessionId, effort))
      .then((ok) => {
        if (ok) reasoningEffortConfirmedValues.set(sessionId, nextEffort)
        if (!ok && reasoningEffortWriteTargets.get(sessionId) === nextEffort) {
          const confirmedEffort = reasoningEffortConfirmedValues.get(sessionId)
          if (target) target.reasoningEffort = confirmedEffort
          if (activeTarget) activeTarget.reasoningEffort = confirmedEffort
        }
        return ok
      })
      .finally(() => {
        if (reasoningEffortWriteChains.get(sessionId) !== write) return
        reasoningEffortWriteChains.delete(sessionId)
        reasoningEffortWriteTargets.delete(sessionId)
        reasoningEffortConfirmedValues.delete(sessionId)
      })
    reasoningEffortWriteChains.set(sessionId, write)
    return write
  }

  function clearThinkingObservationFor(_sessionId: string) {
    // messageId 与 sessionId 的关联未单独持有；方案是切会话时一律清空。
    // 这符合 spec 定义：observation 是"当前会话范围内"的 transient 状态。
    thinkingObservation.clear()
  }

  // 播放消息语音
  function playMessageSpeech(messageId: string, content: string) {
    // 触发自定义事件，让 MessageItem 组件处理播放
    const event = new CustomEvent('auto-play-speech', {
      detail: { messageId, content }
    })
    window.dispatchEvent(event)
  }

  return {
    sessions,
    runtimeMode,
    activeSessionId,
    activeSession,
    focusMessageId,
    messages,
    isStreaming,
    isForkPending,
    isRunActive,
    isSessionLive,
    isSessionCompletedUnread,
    clearSessionCompletedUnread,
    sessionProfileFilter,
    setSessionProfileFilter,
    validateSessionProfileFilter,
    compressionState,
    abortState,
    isAborting,
    queueLengths,
    queuedUserMessages,
    queueInsertionStates,
    activeMessageReference,
    pendingApprovals,
    activePendingApproval,
    pendingClarifies,
    activePendingClarify,
    subagentStreams,
    getSubagentStream,
    removeQueuedMessage,
    insertQueuedMessage,
    setMessageReference,
    clearMessageReference,
    isLoadingSessions,
    sessionsLoaded,
    isLoadingMessages,
    lastSwitchError,
    clearLastSwitchError: () => {
      lastSwitchError.value = null
    },

    newChat,
    createSession,
    newChatWithRemoteCreate,
    newCliSession,
    switchSession,
    ensureSessionLoaded,
    addMessage,
    loadOlderMessages,
    switchSessionModel,
    addOrUpdateSession,
    clearProviderFromSessions,
    deleteSession,
    archiveSession,
    sendMessage,
    stopStreaming,
    respondApproval,
    respondApprovalFor,
    respondToClarify,
    respondToClarifyFor,
    loadSessions,
    refreshSessionListOnly,
    refreshActiveSession,
    getThinkingObservation,
    noteThinkingDelta,
    noteReasoningStart,
    noteReasoningEnd,
    clearThinkingObservationFor,
    setAutoPlaySpeech,
    playMessageSpeech,
    loadWorkspaceRunChangeFile,
    setSessionReasoningEffort,
    setRuntimeMode,
  }
})

