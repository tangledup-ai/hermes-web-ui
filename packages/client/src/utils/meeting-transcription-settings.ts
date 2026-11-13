import { fetchMeetingTranscriptionSetting, saveMeetingTranscriptionSetting, type MeetingTranscriptionPatch } from '@/api/studio/meeting-transcription'

const LEGACY_MEETING_KEY = 'hermes.meeting.asrConfig'
const LEGACY_REALTIME_KEY = 'hermes.realtimeModel'
const MIGRATED_MEETING_KEY = 'hermes.meeting.asrConfig.migrated'

function readLegacyStorage(key: string) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null')
  } catch {
    return null
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

export function getLegacyMeetingDashScopeKey(): string | undefined {
  return nonEmpty(readLegacyStorage(LEGACY_MEETING_KEY)?.dashscopeApiKey)
}

/** Import the old browser-only settings into the active profile once. */
export async function loadMeetingTranscriptionSetting(profile: string, activeProfile: string) {
  const setting = await fetchMeetingTranscriptionSetting(profile)
  if (setting.saved || profile !== activeProfile) return setting

  const legacy = readLegacyStorage(MIGRATED_MEETING_KEY) ? null : readLegacyStorage(LEGACY_MEETING_KEY)
  const realtimeCache = readLegacyStorage(LEGACY_REALTIME_KEY)
  const realtime = realtimeCache?.profile === null || realtimeCache?.profile === profile
    ? realtimeCache?.config
    : undefined
  const asrProvider = legacy?.asrProvider ?? realtime?.asrProvider
  const patch: MeetingTranscriptionPatch = {
    asrProvider: asrProvider === 'minimax' || asrProvider === 'dashscope' ? asrProvider : undefined,
    dashscopeApiKey: nonEmpty(legacy?.dashscopeApiKey) || nonEmpty(realtime?.apiKey),
    paraformerModel: nonEmpty(legacy?.paraformerModel),
    paraformerWsUrl: nonEmpty(legacy?.paraformerWsUrl),
    paraformerLanguageHints: nonEmpty(legacy?.languageHints),
    minimaxApiKey: nonEmpty(legacy?.minimaxApiKey) || nonEmpty(realtime?.minimaxApiKey),
    minimaxAsrModel: nonEmpty(legacy?.minimaxAsrModel) || nonEmpty(realtime?.minimaxAsrModel),
    minimaxBaseUrl: nonEmpty(legacy?.minimaxBaseUrl) || nonEmpty(realtime?.minimaxBaseUrl),
    ossBucket: nonEmpty(legacy?.ossBucket),
    ossEndpoint: nonEmpty(legacy?.ossEndpoint),
    ossPathPrefix: nonEmpty(legacy?.ossPathPrefix),
    ossAccessKeyId: nonEmpty(legacy?.ossAccessKeyId),
    ossAccessKeySecret: nonEmpty(legacy?.ossAccessKeySecret),
  }
  if (!Object.values(patch).some(Boolean)) return setting
  const migrated = await saveMeetingTranscriptionSetting({ ...patch, migrateLegacy: true }, profile)
  if (legacy && migrated.saved) {
    try { localStorage.setItem(MIGRATED_MEETING_KEY, 'true') } catch { /* Storage may be disabled. */ }
  }
  return migrated
}
