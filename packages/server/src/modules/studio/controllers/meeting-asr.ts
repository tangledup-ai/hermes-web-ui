import type { Context } from 'koa'
import { PassThrough } from 'node:stream'
import http from 'node:http'
import https from 'node:https'
import { meetingASRService } from '../services/meeting-asr/index'
import { REPORT_FALLBACK_MARKER, type MeetingAnalysisTarget } from '../services/meeting-asr/realtime-assist'
import { logger } from '../public/logging'
import { MeetingProfileError, resolveMeetingProfile, resolveMeetingRequestProfile } from '../services/meeting-asr/profile'
import {
  meetingTranscriptionRequestContext,
  MeetingTranscriptionSettingsError,
  readMeetingTranscriptionSetting,
  prepareLegacyMeetingTranscriptionSave,
} from '../services/meeting-asr/transcription-settings'

function meetingAnalysisTarget(ctx: Context, body: Record<string, unknown>): MeetingAnalysisTarget | null {
  const agentType = body.agentType ?? 'ekko'
  if ((agentType !== 'ekko' && agentType !== 'hermes') ||
      [body.profile, body.provider, body.model].some(value => value !== undefined && typeof value !== 'string')) {
    ctx.status = 400
    ctx.body = { error: 'Invalid meeting analysis configuration' }
    return null
  }
  const provider = (body.provider as string | undefined)?.trim() || undefined
  const model = (body.model as string | undefined)?.trim() || undefined
  if (Boolean(provider) !== Boolean(model)) {
    ctx.status = 400
    ctx.body = { error: 'provider and model are required together' }
    return null
  }
  try {
    const requested = (body.profile as string | undefined)?.trim() || ctx.state.profile?.name
    const profile = resolveMeetingProfile(ctx.state.user, requested)
    return { profile, agentType, provider, model }
  } catch (error) {
    if (!(error instanceof MeetingProfileError)) throw error
    ctx.status = error.status
    ctx.body = { error: error.message }
    return null
  }
}

/**
 * Talk to the local ASR backend over the protocol it was spawned with.
 *
 * Uses `node:http(s)` rather than `fetch` on purpose: the device image can
 * spawn uvicorn with a self-signed cert (`HERMES_WEB_UI_MEETING_ASR_TLS=true`),
 * and undici's `dispatcher` option rejects a `node:https.Agent` with
 * `agent.dispatch is not a function` — every proxied call then fails with 502.
 * `rejectUnauthorized:false` on the native transport is the supported way to
 * accept the shared cert.
 */
function backendHttpRequest(
  asrPort: number,
  useTls: boolean,
  path: string,
  method: 'GET' | 'POST',
  body?: string,
  headers?: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const transport = useTls ? https : http
    const req = transport.request(
      {
        host: '127.0.0.1',
        port: asrPort,
        path,
        method,
        headers: headers ?? {},
        timeout: timeoutMs,
        ...(useTls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({
          status: res.statusCode || 502,
          body: Buffer.concat(chunks).toString('utf-8'),
          contentType: String(res.headers['content-type'] || ''),
        }))
      },
    )
    req.on('timeout', () => {
      req.destroy(new Error(`backend request timed out after ${timeoutMs}ms`))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function proxyToBackend(ctx: Context, path: string, method: 'GET' | 'POST' = 'GET', body?: any, headers?: Record<string, string>): Promise<any> {
  const status = meetingASRService.status
  if (!status.isRunning || !status.asrPort) {
    ctx.status = 503
    // Carry the service-side reason (crash / restart phase / last error) so a
    // bare "Service Unavailable" in the browser console is diagnosable.
    ctx.body = {
      error: 'ASR service is not running',
      detail: status.error || null,
      startupPhase: status.startupPhase,
      uptime: status.uptime,
      pid: status.pid,
    }
    return null
  }

  try {
    const payload = body && method === 'POST' ? JSON.stringify(body) : undefined
    const response = await backendHttpRequest(
      status.asrPort,
      !!status.useTls,
      path,
      method,
      payload,
      { 'Content-Type': 'application/json', ...headers },
      // The analysis/HTML routes can be slow on ARM64; keep the old generous
      // ceiling so this refactor does not introduce new timeouts.
      path === '/api/analysis/html' || path.startsWith('/api/analysis/') ? 120_000 : 30_000,
    )

    if (path === '/api/analysis/html') {
      ctx.type = 'text/html'
      ctx.body = response.body
      return null
    }

    ctx.status = response.status
    try {
      ctx.body = response.body ? JSON.parse(response.body) : null
    } catch {
      // Backend returned non-JSON — surface the raw body so the client still sees something useful.
      ctx.body = response.body
    }
    return ctx.body
  } catch (err) {
    ctx.status = 502
    ctx.body = { error: `Failed to proxy to ASR backend: ${err}` }
    return null
  }
}

function respondTranscriptionError(ctx: Context, error: unknown, status = 500): void {
  ctx.status = error instanceof MeetingTranscriptionSettingsError || error instanceof MeetingProfileError ? error.status : status
  ctx.body = { status: 'error', error: error instanceof Error ? error.message : String(error) }
}

// Service lifecycle
export async function startASRService(ctx: Context): Promise<void> {
  try {
    const profile = resolveMeetingRequestProfile(ctx)
    const config = (ctx.request.body ?? {}) as Parameters<typeof meetingASRService.start>[0]
    const saveLegacy = prepareLegacyMeetingTranscriptionSave(profile, config, { allowCustomEndpoints: ctx.state?.user?.role === 'super_admin' })
    // The managed child is shared; per-profile ASR credentials and defaults
    // are injected by the audio transport, independent of startup order.
    await meetingASRService.start(profile === 'default' ? config : {})
    saveLegacy()
    ctx.body = { status: 'started', ...meetingASRService.status }
  } catch (error) {
    respondTranscriptionError(ctx, error)
  }
}

export async function stopASRService(ctx: Context): Promise<void> {
  try {
    await meetingASRService.stop()
    ctx.body = {
      status: 'stopped',
    }
  } catch (err) {
    ctx.status = 500
    ctx.body = {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function getASRStatus(ctx: Context): Promise<void> {
  ctx.body = meetingASRService.status
}

export async function updateASRConfig(ctx: Context): Promise<void> {
  try {
    const profile = resolveMeetingRequestProfile(ctx)
    const config = ctx.request.body as Parameters<typeof meetingASRService.updateConfig>[0]
    const saveLegacy = prepareLegacyMeetingTranscriptionSave(profile, config, { allowCustomEndpoints: ctx.state?.user?.role === 'super_admin' })
    if (profile === 'default') await meetingASRService.updateConfig(config)
    saveLegacy()
    ctx.body = { status: 'ok', message: 'Configuration updated' }
  } catch (error) {
    respondTranscriptionError(ctx, error)
  }
}

// Proxy endpoints
export async function proxyHealthCheck(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/healthz')
}

export async function getCurrentConfig(ctx: Context): Promise<void> {
  try {
    const profile = resolveMeetingRequestProfile(ctx)
    const legacy = await proxyToBackend(ctx, '/api/config')
    if (!legacy || ctx.status >= 400) return
    const config = await readMeetingTranscriptionSetting(profile)
    ctx.body = {
      asr: {
        paraformer_ws_url: config.paraformerWsUrl,
        paraformer_model: config.paraformerModel,
        paraformer_language_hints: config.paraformerLanguageHints,
        paraformer_sample_rate: legacy.asr?.paraformer_sample_rate,
        paraformer_format: legacy.asr?.paraformer_format,
        paraformer_semantic_punctuation: legacy.asr?.paraformer_semantic_punctuation,
        dashscope_api_key: '',
        dashscope_api_key_masked: config.dashscopeKeyConfigured ? '****' : '',
        minimax_asr_model: config.minimaxAsrModel,
        minimax_base_url: config.minimaxBaseUrl,
        minimax_api_key: '',
        minimax_api_key_masked: config.minimaxKeyConfigured ? '****' : '',
      },
      llm: profile === 'default' ? { ...legacy.llm, api_key: '' } : { api_key: '' },
      analysis: profile === 'default' ? legacy.analysis : undefined,
    }
  } catch (error) {
    respondTranscriptionError(ctx, error)
  }
}

export async function updateCurrentConfig(ctx: Context): Promise<void> {
  try {
    const profile = resolveMeetingRequestProfile(ctx)
    const body = ctx.request.body as { asr?: unknown } | undefined
    const saveLegacy = prepareLegacyMeetingTranscriptionSave(profile, body?.asr, { pythonFields: true, allowCustomEndpoints: ctx.state?.user?.role === 'super_admin' })
    if (profile === 'default') {
      await proxyToBackend(ctx, '/api/config', 'POST', body)
      if (ctx.status >= 400) return
    } else {
      ctx.body = { status: 'ok' }
    }
    saveLegacy()
  } catch (error) {
    respondTranscriptionError(ctx, error)
  }
}

// Analysis endpoints
export async function startAnalysis(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/start', 'POST', ctx.request.body)
}

export async function stopAnalysis(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/stop', 'POST')
}

export async function triggerAnalysis(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/trigger', 'POST')
}

export async function getAnalysisStatus(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/status')
}

export async function getAnalysisResult(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/result')
}

export async function getAnalysisHTML(ctx: Context): Promise<void> {
  await proxyToBackend(ctx, '/api/analysis/html')
}

export async function proxyAnalysisStream(ctx: Context): Promise<void> {
  const status = meetingASRService.status
  if (!status.isRunning || !status.asrPort) {
    ctx.status = 503
    ctx.body = { error: 'ASR service is not running' }
    return
  }

  ctx.type = 'text/event-stream'
  ctx.set('Cache-Control', 'no-cache')
  ctx.set('Connection', 'keep-alive')

  try {
    // Same transport rule as proxyToBackend: undici cannot accept the
    // node:https.Agent used for the self-signed backend cert, so the
    // long-lived SSE stream is opened with node:http(s) and piped to Koa.
    const transport = status.useTls ? https : http
    const upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = transport.request(
        {
          host: '127.0.0.1',
          port: status.asrPort!,
          path: '/api/analysis/stream',
          method: 'GET',
          // SSE: no request timeout — the stream stays open for the session.
          timeout: 0,
          ...(status.useTls ? { rejectUnauthorized: false } : {}),
        },
        (res) => resolve(res),
      )
      req.on('error', reject)
      req.end()
    })

    ctx.status = upstream.statusCode || 502
    upstream.on('error', (err) => {
      logger.warn('[meeting-asr-ctrl] analysis stream aborted: %s', err instanceof Error ? err.message : err)
    })
    ctx.body = upstream
  } catch (err) {
    ctx.status = 502
    ctx.body = { error: `Failed to proxy to ASR backend: ${err}` }
  }
}

// Scene templates
export async function getSceneTemplates(ctx: Context): Promise<void> {
  const { SCENE_TEMPLATES } = await import('../services/meeting-asr/scene-templates')
  ctx.body = SCENE_TEMPLATES.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
  }))
}

// Realtime assist
export async function startAssist(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../services/meeting-asr/realtime-assist')
  const body = ctx.request.body as any || {}
  const { sessionId, sceneTemplate, speechContext } = body
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) {
    ctx.status = 400
    ctx.body = { error: 'sessionId is required' }
    return
  }
  const target = meetingAnalysisTarget(ctx, body)
  if (!target) return
  const scene = typeof sceneTemplate === 'string' && sceneTemplate ? sceneTemplate : 'general'
  await realtimeAssistService.startSession(sessionId, scene, target, speechContext, ctx.state.user?.id)
  ctx.body = { status: 'started', sessionId, sceneTemplate: scene, profile: target.profile }
}

export async function stopAssist(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../services/meeting-asr/realtime-assist')
  const { sessionId } = ctx.request.body as any || {}
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) {
    ctx.status = 400
    ctx.body = { error: 'sessionId is required' }
    return
  }
  realtimeAssistService.stopSession(sessionId, ctx.state.user?.id)
  ctx.body = { status: 'stopped', sessionId }
}

export async function updateAssistContext(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../services/meeting-asr/realtime-assist')
  const { sessionId, speechContext } = ctx.request.body as any || {}
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || !speechContext) {
    ctx.status = 400
    ctx.body = { error: 'sessionId and speechContext are required' }
    return
  }
  realtimeAssistService.updateSpeechContext(sessionId, speechContext, ctx.state.user?.id)
  ctx.body = { status: 'ok', sessionId }
}

export async function analyzeAssist(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../services/meeting-asr/realtime-assist')
  const { sessionId, speechContext } = ctx.request.body as any || {}
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) {
    ctx.status = 400
    ctx.body = { error: 'sessionId is required' }
    return
  }
  // 允许随触发请求携带最新演讲上下文（当前倒计时等），先应用再立即分析。
  if (speechContext) {
    realtimeAssistService.updateSpeechContext(sessionId, speechContext, ctx.state.user?.id)
  }
  realtimeAssistService.flushNow(sessionId, ctx.state.user?.id)
  ctx.body = { status: 'ok', sessionId }
}

export async function pushAssistSentence(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../services/meeting-asr/realtime-assist')
  const { sessionId, speaker, text, timestamp } = ctx.request.body as any || {}
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || !text) {
    ctx.status = 400
    ctx.body = { error: 'sessionId and text are required' }
    return
  }
  realtimeAssistService.pushSentence(sessionId, { speaker, text, timestamp }, ctx.state.user?.id)
  ctx.body = { status: 'ok' }
}

// Report generation (SSE streaming)
export async function streamReport(ctx: Context): Promise<void> {
  const { realtimeAssistService } = await import('../services/meeting-asr/realtime-assist')
  const body = (ctx.request.body as Record<string, unknown> | undefined) || {}
  const { sessionId, sceneTemplate, transcript } = body

  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200 ||
      typeof transcript !== 'string' || !transcript.trim()) {
    ctx.status = 400
    ctx.body = { error: 'sessionId and transcript are required' }
    return
  }
  const target = meetingAnalysisTarget(ctx, body)
  if (!target) return
  const scene = typeof sceneTemplate === 'string' && sceneTemplate ? sceneTemplate : 'general'

  ctx.type = 'text/event-stream'
  ctx.set('Cache-Control', 'no-cache')
  ctx.set('Connection', 'keep-alive')
  ctx.status = 200

  const passthrough = new PassThrough()
  const controller = new AbortController()
  passthrough.once('close', () => controller.abort())
  ctx.body = passthrough

  void (async () => {
    try {
      const stream = realtimeAssistService.generateReportStream(sessionId, transcript, scene, target, controller.signal)
      for await (const chunk of stream) {
        if (controller.signal.aborted) return
        const event = chunk === REPORT_FALLBACK_MARKER ? { fallback: true } : { text: chunk }
        passthrough.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      passthrough.write('data: [DONE]\n\n')
    } catch (err) {
      if (controller.signal.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      const errorType = err instanceof Error ? err.name : 'UnknownError'
      passthrough.write(`data: ${JSON.stringify({ error: { message, type: errorType } })}\n\n`)
    } finally {
      passthrough.end()
    }
  })()
}

export async function meetingTitle(ctx: Context): Promise<void> {
  const body = (ctx.request.body as Record<string, unknown> | undefined) || {}
  const { transcript } = body
  if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
    ctx.status = 400
    ctx.body = { error: 'transcript is required' }
    return
  }

  const target = meetingAnalysisTarget(ctx, body)
  if (!target) return
  const { generateMeetingTitle } = await import('../services/meeting-asr/direct-llm')
  ctx.body = { title: await generateMeetingTitle(transcript, target) }
}

// ── Whole-file transcription (batch) ─────────────────────────────────────
// The raw audio body is streamed straight through to the Python backend,
// which starts a background job and answers with a job id. The client polls
// /transcribe/status/:jobId — long recordings can take minutes to transcribe
// and must not hold a single request open.

/** Mirrors the Python-side cap; keeps runaway uploads off the proxy. */
const TRANSCRIBE_MAX_BYTES = Number(process.env.MEETING_TRANSCRIBE_MAX_BYTES) || 250 * 1024 * 1024

/**
 * Pipe the request body to the local ASR backend and resolve with its JSON
 * response. Uses node:http instead of fetch so the stream body can be
 * forwarded without buffering it in memory, and TLS (device images spawn
 * uvicorn with a self-signed cert) can be handled explicitly.
 */
function requestBackendRaw(
  asrPort: number,
  useTls: boolean,
  path: string,
  source: NodeJS.ReadableStream,
  contentType: string,
  contentLength?: number,
  contextHeaders?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const transport = useTls ? https : http
    const headers: Record<string, string> = { 'Content-Type': contentType, ...contextHeaders }
    if (contentLength && Number.isFinite(contentLength)) {
      headers['Content-Length'] = String(contentLength)
    }
    const req = transport.request(
      {
        host: '127.0.0.1',
        port: asrPort,
        path,
        method: 'POST',
        headers,
        // 0 disables the socket timeout: transcription upload can be large.
        timeout: 0,
        ...(useTls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode || 502,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        })
      },
    )
    req.on('error', reject)
    source.on('error', (err: Error) => {
      req.destroy(err)
      reject(err)
    })
    source.pipe(req)
  })
}

/** Map the client's camelCase query keys onto the Python snake_case ones. */
function buildTranscribeQuery(ctx: Context, defaultEngine: string): string {
  const q = ctx.query || {}
  const params = new URLSearchParams()
  const engine = String(q.engine ?? defaultEngine)
  params.set('engine', engine === 'qwen' || engine === 'dashscope' ? 'qwen' : 'minimax')
  const diarize = String(q.diarize ?? 'false')
  params.set('diarize', diarize === 'true' || diarize === '1' ? 'true' : 'false')
  const speakerCount = String(q.speakerCount ?? q.speaker_count ?? '0')
  params.set('speaker_count', /^\d+$/.test(speakerCount) ? speakerCount : '0')
  if (q.language) params.set('language', String(q.language))
  if (q.sessionId) params.set('session_id', String(q.sessionId))
  return params.toString()
}

export async function startFileTranscription(ctx: Context): Promise<void> {
  const status = meetingASRService.status
  if (!status.isRunning || !status.asrPort) {
    ctx.status = 503
    ctx.body = { error: 'ASR service is not running' }
    return
  }

  const declared = Number(ctx.request.length ?? ctx.req.headers['content-length'] ?? 0)
  if (declared && declared > TRANSCRIBE_MAX_BYTES) {
    ctx.status = 413
    ctx.body = { error: `Audio too large: ${declared} > ${TRANSCRIBE_MAX_BYTES} bytes` }
    return
  }

  try {
    const profile = resolveMeetingRequestProfile(ctx)
    const { provider, headers } = await meetingTranscriptionRequestContext(profile, ctx.state?.user?.id)
    const query = buildTranscribeQuery(ctx, provider)
    const result = await requestBackendRaw(
      status.asrPort,
      !!status.useTls,
      `/api/transcribe/file?${query}`,
      ctx.req,
      ctx.request.type || 'application/octet-stream',
      declared || undefined,
      headers,
    )
    ctx.status = result.status
    try {
      ctx.body = result.body ? JSON.parse(result.body) : null
    } catch {
      ctx.body = result.body
    }
  } catch (err) {
    respondTranscriptionError(ctx, err, 502)
  }
}

export async function getFileTranscriptionStatus(ctx: Context): Promise<void> {
  const { jobId } = ctx.params
  if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    ctx.status = 400
    ctx.body = { error: 'invalid jobId' }
    return
  }
  try {
    const profile = resolveMeetingRequestProfile(ctx)
    const { headers } = await meetingTranscriptionRequestContext(profile, ctx.state?.user?.id, 'job-status')
    await proxyToBackend(ctx, `/api/transcribe/status/${jobId}`, 'GET', undefined, headers)
  } catch (error) {
    respondTranscriptionError(ctx, error)
  }
}
