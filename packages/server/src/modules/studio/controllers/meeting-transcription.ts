import type { Context } from 'koa'
import { MeetingProfileError, resolveMeetingRequestProfile } from '../services/meeting-asr/profile'
import {
  MeetingTranscriptionSettingsError,
  readMeetingTranscriptionSetting,
  updateMeetingTranscriptionSetting,
} from '../services/meeting-asr/transcription-settings'

async function settingResponse(ctx: Context, update: boolean): Promise<void> {
  if (!ctx.state.user?.id) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return
  }
  try {
    const profile = resolveMeetingRequestProfile(ctx)
    const setting = update
      ? await updateMeetingTranscriptionSetting(profile, ctx.request.body, ctx.state.user.role === 'super_admin')
      : await readMeetingTranscriptionSetting(profile)
    ctx.body = { setting }
  } catch (error) {
    if (!(error instanceof MeetingTranscriptionSettingsError || error instanceof MeetingProfileError)) throw error
    ctx.status = error.status
    ctx.body = { error: error.message }
  }
}

/** Read effective transcription defaults and credential availability for a profile. */
export async function getMeetingTranscriptionSetting(ctx: Context): Promise<void> {
  await settingResponse(ctx, false)
}

/** Save a partial transcription configuration. Omit credentials to keep them or send an empty string to clear them. */
export async function saveMeetingTranscriptionSetting(ctx: Context): Promise<void> {
  await settingResponse(ctx, true)
}
