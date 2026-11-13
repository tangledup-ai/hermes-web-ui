import type { Context } from 'koa'
import { getDeviceConsentRow, writeDeviceConsentRow } from '../../repositories/meeting-device-consent-store'
import { MeetingProfileError, resolveMeetingProfile } from './profile'
import { readMeetingTranscriptionSetting } from './transcription-settings'

export const DEVICE_SOURCE_HEADER = 'x-keli-device'
export const H618_MEETING_SOURCE = 'h618'

export function isH618MeetingSource(header: unknown): boolean {
  return header === H618_MEETING_SOURCE
}

type DeviceProvider = 'dashscope' | 'minimax'

const activeDeviceStreams = new Map<string, Set<() => void>>()

function consentKey(userId: number, profile: string, provider: string): string {
  return JSON.stringify([userId, profile, provider])
}

export function deviceConsentGranted(userId: number, profile: string, provider: string): boolean {
  return getDeviceConsentRow(userId, profile, provider)
}

export function setDeviceConsent(userId: number, profile: string, provider: DeviceProvider, granted: boolean): void {
  writeDeviceConsentRow(userId, profile, provider, granted)
  if (granted) return
  const key = consentKey(userId, profile, provider)
  const active = activeDeviceStreams.get(key)
  activeDeviceStreams.delete(key)
  active?.forEach(disconnect => disconnect())
}

export function trackDeviceTranscription(
  userId: number, profile: string, provider: string, disconnect: () => void,
): (() => void) | null {
  if (!deviceConsentGranted(userId, profile, provider)) return null
  const key = consentKey(userId, profile, provider)
  let active = activeDeviceStreams.get(key)
  if (!active) {
    active = new Set()
    activeDeviceStreams.set(key, active)
  }
  active.add(disconnect)
  return () => {
    active.delete(disconnect)
    if (!active.size && activeDeviceStreams.get(key) === active) activeDeviceStreams.delete(key)
  }
}

export async function getDeviceConsent(userId: number, profile: string) {
  const setting = await readMeetingTranscriptionSetting(profile)
  const provider: DeviceProvider = setting.asrProvider === 'minimax' ? 'minimax' : 'dashscope'
  return { profile, provider, granted: deviceConsentGranted(userId, profile, provider) }
}

export function requireMeetingAccount(ctx: Context) {
  const user = ctx.state.user
  if (!user?.id || ctx.state.modelApiKey || ctx.state.runMcpAuthenticated) {
    throw new MeetingProfileError('A Studio login is required', 401)
  }
  const header = ctx.get('x-hermes-profile').trim()
  const query = typeof ctx.query?.profile === 'string' ? ctx.query.profile.trim() : ''
  if (header && query && header !== query) throw new MeetingProfileError('Conflicting meeting profiles', 400)
  return { userId: user.id as number, profile: resolveMeetingProfile(user, header || query || ctx.state.profile?.name) }
}
