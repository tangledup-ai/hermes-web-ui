import type { Server, Namespace } from 'socket.io'
import { logger } from '../../public/logging'
import { authenticateUserToken } from '../../public/auth'
import { getSceneTemplateOrDefault } from './scene-templates'
import { streamAgentReport } from './agent-bridge'
import { analyzeMeetingBatch, streamMeetingModelReport, type SpeechSummary } from './direct-llm'
import type { MeetingModelTarget } from '../../public/meeting-runtime'
import { annotateTranscriptSpeakers, resolveDominantSpeaker, type AnalysisRound, type SpeechContext } from './report-parser'
export { parseAnalysisRound as parseAnalysisResponse } from './report-parser'
export type { AnalysisRound, SpeechContext, GoldenQuote, GrammarIssue, FillerWord } from './report-parser'

export interface MeetingAnalysisTarget extends MeetingModelTarget {
  agentType?: 'ekko' | 'hermes'
}

interface TranscriptSentence {
  speaker?: string
  text: string
  timestamp?: number
}

interface ActiveSession {
  sessionId: string
  ownerUserId: number
  sceneTemplate: string
  target: MeetingModelTarget
  speechContext?: SpeechContext | null
  speechSummary?: SpeechSummary
  buffer: TranscriptSentence[]
  timer: NodeJS.Timeout | null
  isAnalyzing: boolean
  flushRequested: boolean
  controller: AbortController
}

const WINDOW_SIZE = 5
const WINDOW_INTERVAL_MS = 18_000
const NAMESPACE = '/meeting-assist'

function meetingRoom(ownerUserId: number, sessionId: string): string {
  return `meeting:${ownerUserId}:${sessionId}`
}

function isMeetingSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/**
 * Sentinel yielded by `generateReportStream` to signal "agent path failed, now
 * switching to direct LLM fallback — discard any partial content received so far".
 *
 * Streamed as an internal token only. `streamReport` translates it into an
 * SSE frame of shape `{ fallback: true }`, which the client recognizes and
 * clears its `reportMarkdown` accumulator before rendering new chunks.
 *
 * Lives at module scope so the controller (`meeting-asr.ts#streamReport`)
 * and the service generator agree on a single source of truth.
 */
export const REPORT_FALLBACK_MARKER = Symbol.for('meeting-assist.report.fallback')

class RealtimeAssistService {
  private nsp: Namespace | null = null
  private sessions = new Map<string, ActiveSession>()

  init(io: Server): void {
    this.nsp = io.of(NAMESPACE)

    this.nsp.use(async (socket, next) => {
      try {
        const user = await authenticateUserToken(String(socket.handshake.auth?.token || ''))
        if (user) {
          socket.data.meetingUserId = user.id
          next()
          return
        }
      } catch {
        // Reject the connection if authentication cannot be verified.
      }
      next(new Error('Authentication failed'))
    })

    this.nsp.on('connection', (socket) => {
      socket.on('join', (sessionId: unknown, acknowledge?: (ok: boolean) => void) => {
        if (!isMeetingSessionId(sessionId)) {
          if (typeof acknowledge === 'function') acknowledge(false)
          return
        }
        void Promise.resolve(socket.join(meetingRoom(socket.data.meetingUserId, sessionId)))
          .then(() => { if (typeof acknowledge === 'function') acknowledge(true) })
          .catch(() => { if (typeof acknowledge === 'function') acknowledge(false) })
      })
      socket.on('leave', (sessionId: unknown) => {
        if (isMeetingSessionId(sessionId)) void socket.leave(meetingRoom(socket.data.meetingUserId, sessionId))
      })
    })

    logger.info('[meeting-assist] namespace registered: %s', NAMESPACE)
  }

  async startSession(sessionId: string, sceneTemplate: string, target: MeetingModelTarget, speechContext?: SpeechContext, ownerUserId = 0): Promise<void> {
    const key = meetingRoom(ownerUserId, sessionId)
    if (this.sessions.has(key)) {
      logger.info('[meeting-assist] session %s already active, resetting buffer', sessionId)
      this.stopSession(sessionId, ownerUserId)
    }

    this.sessions.set(key, {
      sessionId,
      ownerUserId,
      sceneTemplate,
      target,
      speechContext: speechContext || null,
      buffer: [],
      timer: null,
      isAnalyzing: false,
      flushRequested: false,
      controller: new AbortController(),
    })

    logger.info('[meeting-assist] session started: %s (scene: %s, profile: %s)', sessionId, sceneTemplate, target.profile)
  }

  /** 更新会话的演讲评分上下文（计时记录、每日一词等），后续分析批次会带上最新数据。 */
  updateSpeechContext(sessionId: string, speechContext: SpeechContext, ownerUserId = 0): void {
    const session = this.sessions.get(meetingRoom(ownerUserId, sessionId))
    if (!session) return
    session.speechContext = speechContext
  }

  /** 立即触发一次分析（忽略窗口大小/间隔计时），供"开始分析"按钮使用。 */
  flushNow(sessionId: string, ownerUserId = 0): void {
    const session = this.sessions.get(meetingRoom(ownerUserId, sessionId))
    if (!session) return
    void this.flush(session)
  }

  stopAllSessions(): void {
    for (const session of this.sessions.values()) this.stopSession(session.sessionId, session.ownerUserId)
    this.nsp = null
  }

  stopSession(sessionId: string, ownerUserId = 0): void {
    const room = meetingRoom(ownerUserId, sessionId)
    const session = this.sessions.get(room)
    if (!session) return

    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    session.buffer = []
    session.controller.abort()
    this.sessions.delete(room)
    if (session.isAnalyzing) this.nsp?.to(room).emit('analyzing', false)
    logger.info('[meeting-assist] session stopped: %s', sessionId)
  }

  pushSentence(sessionId: string, sentence: TranscriptSentence, ownerUserId = 0): void {
    const session = this.sessions.get(meetingRoom(ownerUserId, sessionId))
    if (!session) return

    session.buffer.push(sentence)

    if (session.buffer.length >= WINDOW_SIZE) {
      void this.flush(session)
      return
    }

    this.scheduleFlush(session)
  }

  private scheduleFlush(session: ActiveSession): void {
    if (!session.timer) {
      session.timer = setTimeout(() => {
        session.timer = null
        void this.flush(session)
      }, WINDOW_INTERVAL_MS)
    }
  }

  private async flush(session: ActiveSession): Promise<void> {
    if (session.controller.signal.aborted || session.buffer.length === 0) return
    if (session.isAnalyzing) {
      session.flushRequested = true
      return
    }

    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }

    const sentences = session.buffer.splice(0)
    session.isAnalyzing = true
    session.flushRequested = false

    const room = meetingRoom(session.ownerUserId, session.sessionId)
    this.nsp?.to(room).emit('analyzing', true)

    try {
      const round = await this.analyzeBatch(sentences, session)
      if (round && !session.controller.signal.aborted) {
        // 演讲评分场景：把本轮新增的亮点/改进点/主题/评分累积进会话摘要，供下一批提示词使用
        this.accumulateSpeechSummary(session, round)
        this.nsp?.to(room).emit('analysis', round)
      }
    } catch (err) {
      if (!session.controller.signal.aborted) {
        logger.error(err, '[meeting-assist] analysis failed for session %s', session.sessionId)
        this.nsp?.to(room).emit('error', String(err))
      }
    } finally {
      session.isAnalyzing = false
      if (!session.controller.signal.aborted) {
        this.nsp?.to(room).emit('analyzing', false)
        if (session.flushRequested) void this.flush(session)
      }
    }
  }

  /** 将本轮演讲评分的新增内容合并进会话摘要（去重），供后续批次判断"是否出现新的评价点"。 */
  private accumulateSpeechSummary(session: ActiveSession, round: AnalysisRound): void {
    if (session.sceneTemplate !== 'speech') return
    const summary = session.speechSummary || { highlights: [], improvements: [], topics: [] }
    const pushUnique = (list: string[] | undefined, target: string[]) => {
      for (const item of list || []) {
        const s = item?.trim()
        if (s && !target.includes(s)) target.push(s)
      }
    }
    pushUnique(round.highlights, summary.highlights)
    pushUnique(round.improvements, summary.improvements)
    pushUnique(round.topics, summary.topics)
    if (round.score && Object.keys(round.score).length > 0) {
      summary.score = round.score
    }
    session.speechSummary = summary
  }

  private async analyzeBatch(
    sentences: TranscriptSentence[],
    { sceneTemplate, target, speechContext, speechSummary, controller }: ActiveSession,
  ): Promise<AnalysisRound | null> {
    const template = getSceneTemplateOrDefault(sceneTemplate)
    // 转写句子按环节-演讲者时间线标注真实姓名（替换"说话人1"等声纹名），
    // 让 LLM 的赘语/金句/语法归属与计时员记录的环节/演讲者一致。
    const annotated = annotateTranscriptSpeakers(sentences, speechContext?.speakerTimeline)
    const transcriptText = annotated
      .map(s => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`)
      .join('\n')

    const round = await analyzeMeetingBatch(transcriptText, template, target, speechContext, speechSummary, controller.signal)
    if (round) {
      // 主导演讲者由批次内已标注句子确定性推导（非 LLM 输出）：
      // 多演讲者场景客户端据此把评分/亮点/提升点按演讲者分组。
      const dominant = resolveDominantSpeaker(annotated)
      if (dominant) round.speaker = dominant
    }
    return round
  }

  async *generateReportStream(
    sessionId: string,
    transcript: string,
    sceneTemplateId: string,
    target: MeetingAnalysisTarget,
    signal?: AbortSignal,
  ): AsyncGenerator<string | typeof REPORT_FALLBACK_MARKER> {
    const template = getSceneTemplateOrDefault(sceneTemplateId)
    if (target.agentType !== 'hermes') {
      yield* streamMeetingModelReport(transcript, template, target, signal)
      return
    }

    let agentError: unknown
    try {
      yield* streamAgentReport(sessionId, transcript, template, target, signal)
      return
    } catch (error) {
      signal?.throwIfAborted()
      agentError = error
      logger.warn(error, '[meeting-assist] Hermes report failed; trying the configured model')
    }

    yield REPORT_FALLBACK_MARKER
    try {
      let hasOutput = false
      for await (const chunk of streamMeetingModelReport(transcript, template, target, signal)) {
        hasOutput = true
        yield chunk
      }
      if (!hasOutput) throw new Error('Meeting model fallback produced no output')
    } catch (error) {
      signal?.throwIfAborted()
      const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
      const failure = new Error(`agent: ${message(agentError)} | fallback: ${message(error)}`)
      failure.name = 'ReportStreamBothFailed'
      throw failure
    }
  }

}

export const realtimeAssistService = new RealtimeAssistService()
