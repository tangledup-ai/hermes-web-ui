import type { Context } from 'koa'
import { meetingStorageService } from '../services/meeting-storage/index'
import fs from 'fs/promises'
import { DEVICE_SOURCE_HEADER, isH618MeetingSource, requireMeetingAccount } from '../services/meeting-asr/device-consent'
import { deviceMeetingLiveService } from '../services/meeting-asr/device-live'
import { MeetingProfileError } from '../services/meeting-asr/profile'
import {
  DeviceRecordingError, deviceMeetingOwner, finishDeviceRecording, matchesMeetingOwner,
  stageDeviceMeeting, stageDeviceTranscript, withMeetingLock,
} from '../services/meeting-storage/device-recording'

function respondDeviceError(ctx: Context, error: unknown): void {
  if (error instanceof DeviceRecordingError) {
    ctx.status = error.status
    ctx.body = { error: error.code }
  } else if (error instanceof MeetingProfileError) {
    ctx.status = error.status
    ctx.body = { error: error.message }
  } else {
    throw error
  }
}

function isDeviceRequest(ctx: Context): boolean {
  return isH618MeetingSource(ctx.get(DEVICE_SOURCE_HEADER))
}

async function protectMeeting(ctx: Context, operation: () => Promise<void>): Promise<void> {
  const id = ctx.params.meetingId
  try {
    if (!id || id === '.' || id === '..' || /[\\/\x00-\x1f\x7f]/.test(id)) {
      throw new DeviceRecordingError('invalid_meeting_id', 400)
    }
    await withMeetingLock(id, async () => {
      const owner = await deviceMeetingOwner(id)
      if (owner && (owner.pending || !ctx.state.user?.id
        || !matchesMeetingOwner(owner, requireMeetingAccount(ctx)))) {
        ctx.status = 404
        ctx.body = { error: 'Meeting not found' }
        return
      }
      await operation()
    })
  } catch (error) {
    respondDeviceError(ctx, error)
  }
}

// Meeting metadata
export async function getMeeting(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  await protectMeeting(ctx, async () => {
    const data = await meetingStorageService.getMeetingMetadata(meetingId)
    if (!data) {
      ctx.status = 404
      ctx.body = { error: 'Meeting not found' }
      return
    }
    // 触摸屏设备端 (keli) 把句子单独写到 transcript.json (metadata.sentences 为空),
    // 读取时合并 transcript, 让 Web UI 侧边栏/详情能直接看到设备端会议内容。
    if (!Array.isArray(data.sentences) || data.sentences.length === 0) {
      const transcript = await meetingStorageService.getTranscript(meetingId)
      if (transcript.length > 0) {
        data.sentences = transcript
      }
    }
    ctx.body = data
  })
}

export async function saveMeeting(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  if (isDeviceRequest(ctx)) {
    try {
      const account = requireMeetingAccount(ctx)
      await stageDeviceMeeting(meetingId, account, ctx.request.body)
      deviceMeetingLiveService.syncing(account, meetingId)
      ctx.body = { status: 'ok' }
    } catch (error) {
      respondDeviceError(ctx, error)
    }
    return
  }
  await protectMeeting(ctx, async () => {
    const data = ctx.request.body
    const previous = await meetingStorageService.getMeetingMetadata(meetingId)
    if (previous?.source === 'h618') {
      data.source = previous.source
      data.markers = previous.markers
      data.captureStatus = previous.captureStatus
    }
    await meetingStorageService.saveMeetingMetadata(meetingId, data)
    ctx.body = { status: 'ok', message: 'Meeting saved' }
  })
}

export async function deleteMeeting(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  await protectMeeting(ctx, async () => {
    await meetingStorageService.deleteMeeting(meetingId)
    ctx.body = { status: 'ok', message: 'Meeting deleted' }
  })
}

export async function listMeetings(ctx: Context): Promise<void> {
  try {
    const meetings = await meetingStorageService.listMeetings()
    const account = ctx.state.user?.id && !ctx.state.runMcpAuthenticated ? requireMeetingAccount(ctx) : null
    const visible = await Promise.all(meetings.map(id => withMeetingLock(id, async () => {
      const owner = await deviceMeetingOwner(id)
      return !owner || (account && !owner.pending && matchesMeetingOwner(owner, account))
    })))
    ctx.body = { meetings: meetings.filter((_, index) => visible[index]) }
  } catch (error) {
    respondDeviceError(ctx, error)
  }
}

// Audio upload limit. A 2-hour meeting at opus 32kbps is ~28 MB; we cap at
// 200 MB to leave headroom for higher bitrate captures while keeping the
// server safe from runaway uploads.
const AUDIO_UPLOAD_MAX_BYTES = Number(process.env.MEETING_AUDIO_MAX_BYTES) || 200 * 1024 * 1024

export async function uploadAudio(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  await protectMeeting(ctx, async () => {
    if (await deviceMeetingOwner(meetingId)) {
      ctx.status = 409
      ctx.body = { error: 'Device audio is immutable' }
      return
    }

    // Reject early when the client declared an oversize Content-Length, before
    // streaming any bytes.
    const declared = Number(ctx.request.length ?? ctx.req.headers['content-length'] ?? 0)
    if (declared && declared > AUDIO_UPLOAD_MAX_BYTES) {
      ctx.status = 413
      ctx.body = { error: `Audio too large: ${declared} > ${AUDIO_UPLOAD_MAX_BYTES} bytes` }
      return
    }

    try {
      const result = await meetingStorageService.saveAudioStream(
        meetingId,
        ctx.req as AsyncIterable<Buffer>,
        AUDIO_UPLOAD_MAX_BYTES,
      )
      ctx.body = { status: 'ok', path: result.path, bytes: result.bytes }
    } catch (err: any) {
      if (/max size/.test(String(err?.message || ''))) {
        ctx.status = 413
        ctx.body = { error: err.message }
        return
      }
      ctx.status = 500
      ctx.body = { error: `Failed to upload audio: ${err}` }
    }
  })
}

export async function uploadDeviceRecording(ctx: Context): Promise<void> {
  try {
    const account = requireMeetingAccount(ctx)
    if (!isDeviceRequest(ctx) || !ctx.is('audio/webm')) {
      ctx.status = 415
      ctx.body = { error: 'Expected H618 audio/webm' }
      return
    }
    const declared = Number(ctx.request.length ?? ctx.req.headers['content-length'] ?? 0)
    if (declared > AUDIO_UPLOAD_MAX_BYTES) throw new DeviceRecordingError('audio_too_large', 413)
    const result = await finishDeviceRecording(
      ctx.params.meetingId, account, ctx.get('x-keli-idempotency-key'), ctx.req, AUDIO_UPLOAD_MAX_BYTES,
    )
    if (!result.reused) deviceMeetingLiveService.saved(account, result.meetingId, result.startedAt)
    ctx.body = { status: 'ok', meetingId: result.meetingId, bytes: result.bytes, sha256: result.sha256, reused: result.reused }
  } catch (error) {
    respondDeviceError(ctx, error)
  }
}

export async function downloadAudio(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  await protectMeeting(ctx, async () => {
    const audioPath = await meetingStorageService.getAudioPath(meetingId)

    if (!audioPath) {
      ctx.status = 404
      ctx.body = { error: 'Audio not found' }
      return
    }

    try {
      const audio = await fs.open(audioPath, 'r')
      try {
        const { size } = await audio.stat()
        const fileName = audioPath.split('/').pop() || 'recording.webm'

        ctx.type = 'audio/webm'
        ctx.length = size
        ctx.set('Content-Disposition', `attachment; filename="${fileName}"`)
        // The stream owns the checked descriptor after the per-meeting lock releases.
        ctx.body = audio.createReadStream()
      } catch (error) {
        await audio.close()
        throw error
      }
    } catch (err) {
      ctx.status = 500
      ctx.body = { error: `Failed to read audio: ${err}` }
    }
  })
}

// Transcript
export async function saveTranscript(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  const sentences = ctx.request.body
  if (isDeviceRequest(ctx)) {
    try {
      await stageDeviceTranscript(meetingId, requireMeetingAccount(ctx), sentences)
      ctx.body = { status: 'ok' }
    } catch (error) {
      respondDeviceError(ctx, error)
    }
    return
  }
  await protectMeeting(ctx, async () => {
    await meetingStorageService.saveTranscript(meetingId, sentences)
    ctx.body = { status: 'ok', message: 'Transcript saved' }
  })
}

export async function getTranscript(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  await protectMeeting(ctx, async () => {
    const sentences = await meetingStorageService.getTranscript(meetingId)
    ctx.body = { sentences }
  })
}

// JSON report
export async function saveJsonReport(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  await protectMeeting(ctx, async () => {
    const data = ctx.request.body
    await meetingStorageService.saveJsonReport(meetingId, data)
    ctx.body = { status: 'ok', message: 'JSON report saved' }
  })
}

export async function downloadJsonReport(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  await protectMeeting(ctx, async () => {
    const data = await meetingStorageService.getJsonReport(meetingId)

    if (!data) {
      ctx.status = 404
      ctx.body = { error: 'JSON report not found' }
      return
    }

    ctx.type = 'application/json'
    ctx.set('Content-Disposition', `attachment; filename="${meetingId}.json"`)
    ctx.body = data
  })
}

// HTML report
export async function saveHtmlReport(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  await protectMeeting(ctx, async () => {
    const { html } = ctx.request.body
    await meetingStorageService.saveHtmlReport(meetingId, html)
    ctx.body = { status: 'ok', message: 'HTML report saved' }
  })
}

export async function downloadHtmlReport(ctx: Context): Promise<void> {
  const { meetingId } = ctx.params
  await protectMeeting(ctx, async () => {
    const html = await meetingStorageService.getHtmlReport(meetingId)

    if (!html) {
      ctx.status = 404
      ctx.body = { error: 'HTML report not found' }
      return
    }

    ctx.type = 'text/html'
    ctx.set('Content-Disposition', `attachment; filename="${meetingId}_report.html"`)
    ctx.body = html
  })
}
