import { request } from '../client'

export type MeetingTranscriptionProvider = 'dashscope' | 'minimax'

export interface MeetingDeviceConsent {
  profile: string
  provider: MeetingTranscriptionProvider
  granted: boolean
}

export function meetingDeviceConsent(profile: string, update?: Pick<MeetingDeviceConsent, 'provider' | 'granted'>) {
  return request<MeetingDeviceConsent>('/api/studio/meeting-asr/device-consent', {
    method: update ? 'PUT' : 'GET',
    headers: { 'X-Hermes-Profile': profile },
    body: update ? JSON.stringify(update) : undefined,
  })
}

interface MeetingTranscriptionSettings {
  asrProvider: MeetingTranscriptionProvider
  asrModel: string
  paraformerModel: string
  paraformerWsUrl?: string
  paraformerLanguageHints?: string
  minimaxAsrModel: string
  minimaxBaseUrl: string
  ossBucket: string
  ossEndpoint: string
  ossPathPrefix: string
}

export interface MeetingTranscriptionSetting extends MeetingTranscriptionSettings {
  saved: boolean
  dashscopeKeyConfigured: boolean
  minimaxKeyConfigured: boolean
  ossAccessKeyIdConfigured: boolean
  ossAccessKeySecretConfigured: boolean
  ossConfigured: boolean
}

export interface MeetingTranscriptionPatch extends Partial<MeetingTranscriptionSettings> {
  dashscopeApiKey?: string
  minimaxApiKey?: string
  ossAccessKeyId?: string
  ossAccessKeySecret?: string
  migrateLegacy?: boolean
}

function settingsPath(profile?: string): string {
  const path = '/api/studio/models/meeting-transcription'
  return profile ? `${path}?${new URLSearchParams({ profile })}` : path
}

export async function fetchMeetingTranscriptionSetting(profile?: string): Promise<MeetingTranscriptionSetting> {
  const { setting } = await request<{ setting: MeetingTranscriptionSetting }>(settingsPath(profile))
  return setting
}

export async function saveMeetingTranscriptionSetting(
  patch: MeetingTranscriptionPatch,
  profile?: string,
): Promise<MeetingTranscriptionSetting> {
  const { setting } = await request<{ setting: MeetingTranscriptionSetting }>(settingsPath(profile), {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
  return setting
}
