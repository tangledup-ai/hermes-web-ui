import { getWebUiHome } from '../../public/config'
import fs from 'fs/promises'
import path from 'path'
import { logger } from '../../public/logging'
import { streamConfiguredMeetingModel, type MeetingModelRequest, type MeetingModelTarget } from '../../public/meeting-runtime'
import { readSseFrames } from '../chat-run/sse-utils'
import type { SceneTemplate } from './scene-templates'
import { REPORT_TITLE_INSTRUCTION, REPORT_TRANSCRIPT_INSTRUCTION } from './scene-templates'
import { prepareAnalysisSkillSection } from './skill-resolver'
import { parseAnalysisRound, type AnalysisRound, type SpeechContext } from './report-parser'

/**
 * 服务端累积的演讲评价摘要：跨批次保留，注入后续提示词，供 AI 判断是否出现新的评价点。
 * 由 realtime-assist 的 accumulateSpeechSummary 维护（源自 org 演讲功能增量评价模式）。
 */
export interface SpeechSummary {
  highlights: string[]
  improvements: string[]
  topics: string[]
  score?: Record<string, number>
}

interface LLMConfig {
  apiKey: string
  baseUrl: string
  model: string
}

interface DirectLLMDeps {
  fetchImpl?: typeof fetch
  loadConfig?: () => Promise<LLMConfig | null>
}

/** 墙钟毫秒 → HH:mm:ss（环节时间线展示用）。 */
function fmtClock(ms: number): string {
  if (!Number.isFinite(ms)) return '??:??:??'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function loadLegacyLLMConfig(): Promise<LLMConfig | null> {
  const dir = process.env.MEETING_ASR_DATA_DIR?.trim()
    || path.join(getWebUiHome(), 'meeting-asr')
  const configFile = path.join(dir, 'config.json')

  try {
    const content = await fs.readFile(configFile, 'utf-8')
    const stored = JSON.parse(content)

    const apiKey = stored?.llm?.api_key?.trim()
    if (!apiKey) return null

    return {
      apiKey,
      baseUrl: stored?.llm?.base_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: stored?.llm?.model || 'qwen-plus',
    }
  } catch {
    return null
  }
}

async function requestLegacyCompletion(
  config: LLMConfig,
  input: MeetingModelRequest,
  stream: boolean,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const timeout = AbortSignal.timeout(input.purpose === 'meeting-report' ? 180_000 : 30_000)
  const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      stream,
    }),
    signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Meeting model API error ${response.status}`)
  }
  return response
}

interface LegacyModelResponse {
  choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
  error?: string | { message?: string }
}

function legacyModelContent(payload: LegacyModelResponse): string | undefined {
  if (payload.error) {
    throw new Error(typeof payload.error === 'string' ? payload.error : payload.error.message || 'Meeting model stream failed')
  }
  return payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content
}

async function* streamLegacyModel(config: LLMConfig, input: MeetingModelRequest, fetchImpl: typeof fetch): AsyncGenerator<string> {
  if (input.purpose === 'meeting-report') {
    const response = await requestLegacyCompletion(config, input, true, fetchImpl)
    if (!response.body) throw new Error('Meeting model returned no response body')
    let yieldedText = false
    for await (const frame of readSseFrames(response.body)) {
      if (frame.data === '[DONE]') break
      let payload: LegacyModelResponse
      try {
        payload = JSON.parse(frame.data)
      } catch {
        continue
      }
      const text = legacyModelContent(payload)
      if (text) {
        yieldedText = true
        yield text
      }
    }
    if (yieldedText) return
  }
  const response = await requestLegacyCompletion(config, input, false, fetchImpl)
  const text = legacyModelContent(await response.json() as LegacyModelResponse)
  if (text) yield text
}

async function resolveMeetingModel(input: MeetingModelRequest, deps?: DirectLLMDeps): Promise<AsyncIterable<string> | null> {
  input.signal?.throwIfAborted()
  const configured = await streamConfiguredMeetingModel(input)
  if (configured) return configured
  if (input.provider || input.model) throw new Error('Meeting model is unavailable in this profile')
  if (input.profile !== 'default') return null
  const legacy = await (deps?.loadConfig ? deps.loadConfig() : loadLegacyLLMConfig())
  return legacy ? streamLegacyModel(legacy, input, deps?.fetchImpl ?? fetch) : null
}

async function completeMeetingModel(input: MeetingModelRequest, deps?: DirectLLMDeps): Promise<string> {
  const stream = await resolveMeetingModel(input, deps)
  if (!stream) throw new Error('Configure a text model in Model Configuration for this profile')
  let output = ''
  for await (const text of stream) output += text
  return output
}

export async function analyzeMeetingBatch(
  transcriptText: string,
  template: SceneTemplate,
  target: MeetingModelTarget,
  speechContext?: SpeechContext | null,
  speechSummary?: SpeechSummary,
  signal?: AbortSignal,
): Promise<AnalysisRound | null> {
  // 动态加载 profile 下的会议分析技能并追加到 system prompt。
  // 演讲评分场景使用自成一体的专业提示词（3+1 反馈 / 金句定义 / 赘语阈值 / 说人话鼓励式点评等），
  // 不追加通用会议分析技能，避免其通用方法论稀释演讲点评风格。
  const skillSection = template.id === 'speech' ? '' : await prepareAnalysisSkillSection(target.profile, template.id)
  let systemPrompt = skillSection
    ? `${template.systemPrompt}\n\n${skillSection}`
    : template.systemPrompt

  // 演讲评分场景：把计时记录/每日一词/当前倒计时/已累积评价注入提示词。
  if (template.id === 'speech') {
    const lines: string[] = ['', '【当前演讲评估上下文（请据此点评与评分）】']
    if (speechContext) {
      const ctx = speechContext
      if (ctx.wordOfTheDay) lines.push(`- 每日一词：${ctx.wordOfTheDay}`)
      if (ctx.timerDurationSec) {
        lines.push(`- 计时设置：单环节标准时长 ${ctx.timerDurationSec} 秒；黄牌触发剩余 ${ctx.yellowAtSec ?? 30} 秒；红牌触发剩余 ${ctx.redAtSec ?? 10} 秒`)
      }
      if (ctx.currentRemainingSec != null) {
        lines.push(`- 当前倒计时：剩余 ${Math.round(ctx.currentRemainingSec)} 秒（${ctx.currentPhase || 'green'}）`)
      }
      if (ctx.timerRecords && ctx.timerRecords.length > 0) {
        lines.push('- 已记录环节用时：')
        for (const r of ctx.timerRecords) {
          const overtime = r.overtimeSec > 0 ? `（超时 ${r.overtimeSec} 秒）` : ''
          lines.push(`  - ${r.label}：${r.durationSec} 秒${overtime}`)
        }
      }
      if (ctx.speakerTimeline && ctx.speakerTimeline.length > 0) {
        lines.push('- 环节与发言人时间线（计时员人工登记，转写中的 [姓名] 已按此标注）：')
        for (const e of ctx.speakerTimeline) {
          const name = e.segment ? `${e.segment}/${e.speaker}` : e.speaker
          lines.push(`  - ${name}：${fmtClock(e.startMs)} - ${fmtClock(e.endMs)}`)
        }
        lines.push('- 赘语/金句/语法问题的 speaker 字段必须使用时间线中的演讲者姓名（禁止输出"说话人1"这类编号），分析点评也直接称呼姓名。')
      } else {
        // 无时间线且转写无 [姓名] 标注时明确禁止编造：LLM 在无归属信息的转写上
        // 会自行虚构姓名（如"张三"），误导用户以为系统真的识别到了演讲者。
        lines.push('- 本次未提供演讲者时间线，转写也没有 [姓名] 标注：speaker 字段一律留空字符串，禁止编造或猜测任何姓名（如"张三""发言人"）。')
      }
    }
    if (speechSummary) {
      if (speechSummary.highlights.length > 0) {
        lines.push(`- 已累积亮点：${speechSummary.highlights.join('；')}`)
      }
      if (speechSummary.improvements.length > 0) {
        lines.push(`- 已累积改进点：${speechSummary.improvements.join('；')}`)
      }
      if (speechSummary.topics.length > 0) {
        lines.push(`- 已出现主题：${speechSummary.topics.join('；')}`)
      }
      if (speechSummary.score && Object.keys(speechSummary.score).length > 0) {
        lines.push(`- 当前评分：${JSON.stringify(speechSummary.score)}`)
      }
    }
    // 用户手动记录（语法官/肢体语言观察）：AI 点评必须结合这些人工观察
    const mn = speechContext?.manualNotes
    if (mn?.goodPhrases?.length) {
      lines.push(`- 手动记录金句：${mn.goodPhrases.join('；')}（点评时呼应这些被标记的句子）`)
    }
    if (mn?.grammarNotes?.length) {
      lines.push(`- 手动语法/用词记录：${mn.grammarNotes.join('；')}（核实后可纳入 grammarIssues）`)
    }
    if (mn?.bodyNotes?.length) {
      lines.push(`- 肢体语言观察（人工记录，你看不到画面，务必结合）：${mn.bodyNotes.join('；')}`)
    }
    systemPrompt = `${systemPrompt}\n${lines.join('\n')}`
  }

  const content = await completeMeetingModel({
    ...target,
    purpose: 'meeting-analysis',
    systemPrompt,
    userPrompt: `以下是最近的对话内容：\n\n${transcriptText}`,
    temperature: 0.3,
    maxTokens: template.id === 'speech' ? 1200 : 800,
    signal,
  })

  // H1 赘语阈值：实际发言时长 = 设置时长 - 当前倒计时（缺省不启用阈值过滤）
  let speechDurationSec: number | undefined
  if (template.id === 'speech' && speechContext) {
    const { timerDurationSec, currentRemainingSec } = speechContext
    if (typeof timerDurationSec === 'number' && typeof currentRemainingSec === 'number') {
      const elapsed = timerDurationSec - currentRemainingSec
      if (elapsed > 0) speechDurationSec = elapsed
    }
  }

  return parseAnalysisRound(content, { speechDurationSec })
}

export async function* streamMeetingModelReport(
  transcript: string,
  template: SceneTemplate,
  target: MeetingModelTarget,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const skillSection = template.id === 'speech' ? '' : await prepareAnalysisSkillSection(target.profile, template.id)
  const stream = await resolveMeetingModel({
    ...target,
    purpose: 'meeting-report',
    systemPrompt: [template.reportPrompt, skillSection, REPORT_TITLE_INSTRUCTION, REPORT_TRANSCRIPT_INSTRUCTION]
      .filter(Boolean).join('\n\n'),
    userPrompt: `以下是完整的会议转写内容：\n\n${transcript}`,
    temperature: 0.4,
    maxTokens: 4000,
    signal,
  })
  if (!stream) throw new Error('Configure a text model in Model Configuration for this profile')
  yield* stream
}

/**
 * 清洗 LLM 返回的标题候选：只取第一行，去掉误带的 markdown 标记、"标题："前缀与
 * 各类包裹/结尾标点；空或过长（>40 字）视为不可用。
 */
export function cleanMeetingTitle(raw: unknown): string | null {
  const text = String(raw ?? '').split(/\r?\n/)[0].trim()
  if (!text) return null
  const cleaned = text
    .replace(/^[#*>\s]+/, '') // 去掉可能误带的 markdown 标记
    .replace(/^标题[:：]?/, '') // 去掉"标题："
    .replace(/^[「『“‘"《〈(（]+/, '') // 去掉前导包裹符
    .replace(/[」』”’"》〉)）]+$/, '') // 去掉尾部包裹符
    .replace(/[。．.!！?？]+$/, '') // 去掉结尾标点
    .trim()
  if (!cleaned) return null
  return cleaned.length > 40 ? cleaned.slice(0, 40) : cleaned
}

export async function generateMeetingTitle(
  transcript: string,
  target: MeetingModelTarget,
  deps?: DirectLLMDeps,
): Promise<string | null> {
  const text = (transcript || '').trim()
  if (!text) return null
  // 控制请求体大小：转写过长时只取开头与结尾，中间省略。
  const MAX = 6000
  const excerpt = text.length > MAX
    ? `${text.slice(0, Math.floor(MAX / 2))}\n…（中间内容省略）…\n${text.slice(-Math.floor(MAX / 2))}`
    : text

  const system = [
    '你是会议命名助手。请根据会议转写内容，为这场会议拟定一个简短、贴切、能概括主题的中文标题。',
    '要求：',
    '1. 只输出标题本身，长度 5~20 字，不要任何解释或多余文字。',
    '2. 不要输出引号、书名号、括号、冒号、“标题：”前缀、句号等标点。',
    '3. 标题应具体（如“Q3 供应商合同条款评审”），不要用“会议纪要/会议记录/会议总结/会议分析”这类泛化词。',
  ].join('\n')

  try {
    return cleanMeetingTitle(await completeMeetingModel({
      ...target,
      purpose: 'meeting-title',
      systemPrompt: system,
      userPrompt: `会议转写内容：\n\n${excerpt}`,
      temperature: 0.3,
      maxTokens: 64,
    }, deps))
  } catch (err) {
    logger.warn('[meeting-assist] title generation failed: %s', err instanceof Error ? err.message : String(err))
    return null
  }
}
