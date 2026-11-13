import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { getWebUiHome } from '../../public/config'
import { getRealtimeModelSetting } from '../../repositories/realtime-settings-store'
import {
  getMeetingTranscriptionSettings,
  saveMeetingTranscriptionSettings,
  type StoredMeetingTranscriptionSettings,
} from '../../repositories/meeting-transcription-settings-store'

const fields = {
  asrProvider: ['ASR_PROVIDER', 'asr_provider', 'dashscope'],
  asrModel: ['ASR_MODEL', 'asr_model', 'paraformer-v2'],
  paraformerModel: ['PARAFORMER_MODEL', 'paraformer_model', 'paraformer-realtime-v2'],
  paraformerWsUrl: ['PARAFORMER_WS_URL', 'paraformer_ws_url', 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'],
  paraformerLanguageHints: ['PARAFORMER_LANGUAGE_HINTS', 'paraformer_language_hints', 'zh,en'],
  minimaxAsrModel: ['MINIMAX_ASR_MODEL', 'minimax_asr_model', 'asr-1.0'],
  minimaxBaseUrl: ['MINIMAX_BASE_URL', 'minimax_base_url', 'https://api.minimaxi.com'],
  ossBucket: ['OSS_BUCKET', 'oss_bucket', ''],
  ossEndpoint: ['OSS_ENDPOINT', 'oss_endpoint', 'oss-cn-beijing.aliyuncs.com'],
  ossPathPrefix: ['OSS_PATH_PREFIX', 'oss_path_prefix', 'meeting-asr-uploads/'],
  dashscopeApiKey: ['DASHSCOPE_API_KEY', 'dashscope_api_key', ''],
  minimaxApiKey: ['MINIMAX_API_KEY', 'minimax_api_key', ''],
  ossAccessKeyId: ['OSS_ACCESS_KEY_ID', 'oss_access_key_id', ''],
  ossAccessKeySecret: ['OSS_ACCESS_KEY_SECRET', 'oss_access_key_secret', ''],
} as const

type Field = keyof typeof fields
type MeetingTranscriptionConfig = Record<Field, string>
type LegacySettings = Partial<MeetingTranscriptionConfig>

const fieldNames = Object.keys(fields) as Field[]
const secretNames = new Set<Field>(['dashscopeApiKey', 'minimaxApiKey', 'ossAccessKeyId', 'ossAccessKeySecret'])
const minimaxHosts = new Set(['api.minimaxi.com', 'api.minimax.io'])

export const TRANSCRIPTION_CONTEXT_HEADER = 'x-studio-transcription-context'
export const TRANSCRIPTION_TOKEN_HEADER = 'x-studio-transcription-token'
export const transcriptionContextToken = randomBytes(32).toString('hex')

export class MeetingTranscriptionSettingsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

async function readLegacySettings(dataDir: string): Promise<LegacySettings> {
  const [json, envText] = await Promise.all([
    readFile(path.join(dataDir, 'config.json'), 'utf8').catch(() => ''),
    readFile(path.join(dataDir, 'config.env'), 'utf8').catch(() => ''),
  ])
  let file: Record<string, unknown> = {}
  try { file = asRecord(JSON.parse(json)) } catch { /* Existing config may be absent. */ }
  const env = parseEnv(envText)
  const asr = asRecord(file.asr)
  const legacy: LegacySettings = {}
  for (const key of fieldNames) {
    const [envKey, fileKey] = fields[key]
    const value = nonempty(asr[fileKey]) ?? nonempty(file[fileKey])
      ?? (key === 'dashscopeApiKey' ? nonempty(asRecord(file.llm).api_key) : undefined)
      ?? nonempty(env[envKey]) ?? nonempty(process.env[envKey])
    if (value) legacy[key] = value
  }
  return legacy
}

async function legacySettings(profile: string): Promise<LegacySettings> {
  const realtime = readSharedRealtimeSettings(profile)
  const shared = {
    asrProvider: realtime?.settings.asrProvider,
    minimaxAsrModel: realtime?.settings.minimaxAsrModel,
    minimaxBaseUrl: realtime?.settings.minimaxBaseUrl,
    dashscopeApiKey: realtime?.secrets.apiKey,
    minimaxApiKey: realtime?.secrets.minimaxApiKey,
  }
  // Legacy deployment files and environment settings are device-wide. Treat
  // them as the default profile's settings so other profiles cannot use them.
  const device = profile === 'default'
    ? await readLegacySettings(process.env.MEETING_ASR_DATA_DIR || path.join(getWebUiHome(), 'meeting-asr'))
    : {}
  return {
    ...device,
    ...Object.fromEntries(Object.entries(shared).filter(([, value]) => value)),
  }
}

function readSharedRealtimeSettings(profile: string) {
  try {
    return getRealtimeModelSetting(profile, { includeSecrets: true })
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('no such table')) throw error
    return null
  }
}

export function prepareLegacyMeetingTranscriptionSave(
  profile: string,
  input: unknown,
  options: { pythonFields?: boolean; allowCustomEndpoints?: boolean } = {},
): () => void {
  const body = asRecord(input)
  const patch: StoredMeetingTranscriptionSettings = {}
  for (const key of fieldNames) {
    const value = nonempty(body[options.pythonFields ? fields[key][1] : key])
    if (value) patch[key] = validateField(key, value, options.allowCustomEndpoints === true)
  }
  return () => {
    if (!Object.keys(patch).length) return
    // Released clients may continue supplying ASR settings through their old
    // routes. Persist those values for profiles that have not used the Models
    // panel, leaving deliberate changes and clears from the new panel intact.
    saveMeetingTranscriptionSettings(profile, patch, 'legacy')
  }
}

async function readEffectiveSettings(profile: string) {
  const legacy = await legacySettings(profile)
  let stored: ReturnType<typeof getMeetingTranscriptionSettings>
  try {
    stored = getMeetingTranscriptionSettings(profile)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('no such table')) throw error
    stored = null
  }
  const config = {} as MeetingTranscriptionConfig
  for (const key of fieldNames) config[key] = stored?.settings[key] ?? legacy[key] ?? fields[key][2]
  if (config.asrProvider !== 'minimax') config.asrProvider = 'dashscope'
  return { config, saved: stored?.saved ?? false }
}

export async function readMeetingTranscriptionSetting(profile: string) {
  const { config, saved } = await readEffectiveSettings(profile)
  const { dashscopeApiKey, minimaxApiKey, ossAccessKeyId, ossAccessKeySecret, ...settings } = config
  return {
    ...settings,
    saved,
    dashscopeKeyConfigured: Boolean(dashscopeApiKey),
    minimaxKeyConfigured: Boolean(minimaxApiKey),
    ossAccessKeyIdConfigured: Boolean(ossAccessKeyId),
    ossAccessKeySecretConfigured: Boolean(ossAccessKeySecret),
    ossConfigured: Boolean(settings.ossBucket && ossAccessKeyId && ossAccessKeySecret),
  }
}

function validateField(key: Field, raw: unknown, allowCustomEndpoints: boolean): string {
  if (typeof raw !== 'string') throw new MeetingTranscriptionSettingsError(`Invalid ${key}`)
  const value = raw.trim()
  if (value.length > (secretNames.has(key) ? 1000 : 300) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new MeetingTranscriptionSettingsError(`Invalid ${key}`)
  }
  if (!value && !secretNames.has(key)) return fields[key][2]
  if (key === 'asrProvider' && value !== 'dashscope' && value !== 'minimax') {
    throw new MeetingTranscriptionSettingsError('Invalid transcription provider')
  }
  if (key === 'minimaxBaseUrl' || key === 'paraformerWsUrl' || key === 'ossEndpoint') {
    const endpoint = key === 'ossEndpoint' && !value.includes('://') ? `https://${value}` : value
    const url = URL.canParse(endpoint) ? new URL(endpoint) : null
    const protocol = key === 'paraformerWsUrl' ? 'wss:' : 'https:'
    if (!url || url.protocol !== protocol || url.username || url.password || url.search || url.hash
      || (key === 'ossEndpoint' && (url.pathname !== '/' || url.port))) {
      throw new MeetingTranscriptionSettingsError(`Invalid ${key}`)
    }
    const official = key === 'minimaxBaseUrl' ? minimaxHosts.has(url.hostname)
      : key === 'paraformerWsUrl' ? /^dashscope(?:-[a-z0-9-]+)?\.aliyuncs\.com$/.test(url.hostname)
      : /^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname)
    if (!allowCustomEndpoints && (!official || url.port)) {
      throw new MeetingTranscriptionSettingsError(`Only a super administrator can set a custom ${key}`, 403)
    }
    if (key === 'ossEndpoint') return url.hostname
  }
  return value
}

export async function updateMeetingTranscriptionSetting(profile: string, input: unknown, allowCustomEndpoints = false) {
  const body = asRecord(input)
  const migration = body.migrateLegacy === true
  const legacy = migration ? await legacySettings(profile) : {}
  const patch: StoredMeetingTranscriptionSettings = {}
  for (const key of fieldNames) {
    if (Object.hasOwn(body, key) && (!migration || (!legacy[key] && body[key] !== ''))) {
      try {
        patch[key] = validateField(key, body[key], allowCustomEndpoints)
      } catch (error) {
        if (!migration || !(error instanceof MeetingTranscriptionSettingsError)) throw error
        // A stale browser-only field must not prevent the remaining valid
        // configuration from being restored on upgrade.
      }
    }
  }
  saveMeetingTranscriptionSettings(profile, patch, migration ? 'migration' : 'panel')
  return readMeetingTranscriptionSetting(profile)
}

export async function meetingTranscriptionRequestContext(
  profile: string,
  userId?: number,
  mode: 'transcription' | 'realtime' | 'job-status' = 'transcription',
  fixedProvider = false,
) {
  const config = mode === 'job-status' ? null : (await readEffectiveSettings(profile)).config
  if (config && mode === 'realtime') {
    config.dashscopeApiKey = readSharedRealtimeSettings(profile)?.secrets.apiKey || config.dashscopeApiKey
  }
  const settings = config ? Object.fromEntries(fieldNames.map(key => [fields[key][1], config[key]])) : {}
  const context = { settings, owner: JSON.stringify([profile, userId ?? null]), fixedProvider }
  return {
    provider: config?.asrProvider || 'dashscope',
    headers: {
      [TRANSCRIPTION_CONTEXT_HEADER]: Buffer.from(JSON.stringify(context)).toString('base64url'),
      [TRANSCRIPTION_TOKEN_HEADER]: transcriptionContextToken,
    },
  }
}
