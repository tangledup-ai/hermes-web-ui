import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getWebUiHome } from '../../public/config'
import type { MeetingData, TranscriptSentence } from './index'

export interface DeviceMeetingAccount {
  userId: number
  profile: string
}

type Receipt = { key: string; bytes: number; sha256: string }

export class DeviceRecordingError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

function isDeviceMeetingId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id)
}

export function validateDeviceMeetingId(id: string): void {
  if (!isDeviceMeetingId(id)) {
    throw new DeviceRecordingError('invalid_meeting_id', 400)
  }
}

function paths(id: string) {
  validateDeviceMeetingId(id)
  const home = getWebUiHome()
  return {
    meetings: path.join(home, 'meetings'),
    complete: path.join(home, 'meetings', id),
    pending: path.join(home, 'device-meetings-pending', id),
  }
}

async function readJson<T>(dir: string, name: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  const tmp = path.join(dir, `.${randomUUID()}.tmp`)
  try {
    await fs.writeFile(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600, flush: true })
    await fs.rename(tmp, path.join(dir, name))
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

const operations = new Map<string, Promise<unknown>>()

export async function withMeetingLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(id) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  operations.set(id, current)
  try {
    return await current
  } finally {
    if (operations.get(id) === current) operations.delete(id)
  }
}

export async function deviceMeetingOwner(id: string) {
  if (!isDeviceMeetingId(id)) return null
  const { complete, pending } = paths(id)
  const staging = await readJson<DeviceMeetingAccount>(pending, 'owner.json')
  if (staging) return { ...staging, pending: true }
  const owner = await readJson<DeviceMeetingAccount>(complete, 'owner.json')
  return owner ? { ...owner, pending: false } : null
}

export function matchesMeetingOwner(owner: DeviceMeetingAccount, account: DeviceMeetingAccount): boolean {
  return owner.userId === account.userId && owner.profile === account.profile
}

function requireOwner(owner: DeviceMeetingAccount | null, account: DeviceMeetingAccount): void {
  if (!owner || !matchesMeetingOwner(owner, account)) throw new DeviceRecordingError('meeting_not_found', 404)
}

function validateMetadata(id: string, data: MeetingData): void {
  const captureStatuses = ['complete', 'partial', 'offline', 'interrupted']
  if (!data || data.source !== 'h618' || data.id !== id || typeof data.title !== 'string' ||
    data.title.length > 300 || !Number.isFinite(data.createdAt) || !Number.isFinite(data.updatedAt) ||
    !Number.isFinite(data.audioDuration) || data.audioDuration < 0 ||
    (data.captureStatus !== undefined && !captureStatuses.includes(data.captureStatus)) ||
    (data.transcriptIncomplete !== undefined && typeof data.transcriptIncomplete !== 'boolean') ||
    !Array.isArray(data.markers) || data.markers.length > 1000 ||
    data.markers.some(marker => !marker || !Number.isSafeInteger(marker.offsetMs) || marker.offsetMs < 0 ||
      marker.offsetMs > Math.ceil(data.audioDuration * 1000) + 1000)) {
    throw new DeviceRecordingError('invalid_device_meeting_metadata', 400)
  }
}

export async function stageDeviceMeeting(id: string, account: DeviceMeetingAccount, data: MeetingData): Promise<void> {
  validateDeviceMeetingId(id)
  validateMetadata(id, data)
  await withMeetingLock(id, async () => {
    const { complete, pending } = paths(id)
    const owner = await deviceMeetingOwner(id)
    if (owner) {
      requireOwner(owner, account)
      if (!owner.pending) return
    } else {
      const exists = await fs.stat(complete).then(() => true, error => {
        if (error.code === 'ENOENT') return false
        throw error
      })
      if (exists) throw new DeviceRecordingError('meeting_id_in_use', 409)
      await fs.mkdir(path.dirname(pending), { recursive: true, mode: 0o700 })
      const tmp = await fs.mkdtemp(path.join(path.dirname(pending), '.create-'))
      try {
        await writeJson(tmp, 'owner.json', account)
        await writeJson(tmp, 'metadata.json', data)
        await fs.rename(tmp, pending)
      } finally {
        await fs.rm(tmp, { recursive: true, force: true })
      }
      return
    }
    await writeJson(pending, 'metadata.json', data)
  })
}

export async function stageDeviceTranscript(id: string, account: DeviceMeetingAccount, sentences: TranscriptSentence[]): Promise<void> {
  validateDeviceMeetingId(id)
  if (!Array.isArray(sentences)) throw new DeviceRecordingError('invalid_device_transcript', 400)
  await withMeetingLock(id, async () => {
    const owner = await deviceMeetingOwner(id)
    requireOwner(owner, account)
    if (owner?.pending) await writeJson(paths(id).pending, 'transcript.json', sentences)
  })
}

export async function finishDeviceRecording(
  id: string, account: DeviceMeetingAccount, key: string, source: AsyncIterable<Buffer>, maxBytes: number,
) {
  validateDeviceMeetingId(id)
  validateDeviceMeetingId(key)
  return withMeetingLock(id, async () => {
    const { complete, pending, meetings } = paths(id)
    const owner = await deviceMeetingOwner(id)
    requireOwner(owner, account)
    if (!owner?.pending) {
      const receipt = await readJson<Receipt>(complete, 'receipt.json')
      if (!receipt || receipt.key !== key) throw new DeviceRecordingError('upload_key_conflict', 409)
      return { meetingId: id, bytes: receipt.bytes, sha256: receipt.sha256, reused: true as const }
    }
    const metadata = await readJson<MeetingData>(pending, 'metadata.json')
    if (!metadata) throw new DeviceRecordingError('device_metadata_required', 409)
    const transcript = await readJson<TranscriptSentence[]>(pending, 'transcript.json')
    if (!transcript) throw new DeviceRecordingError('device_transcript_required', 409)

    const tmp = path.join(pending, `.${randomUUID()}.webm`)
    const handle = await fs.open(tmp, 'wx', 0o600)
    let bytes = 0
    const sha = createHash('sha256')
    try {
      for await (const chunk of source) {
        bytes += chunk.length
        if (bytes > maxBytes) throw new DeviceRecordingError('audio_too_large', 413)
        sha.update(chunk)
        let offset = 0
        while (offset < chunk.length) {
          const written = await handle.write(chunk, offset, chunk.length - offset)
          offset += written.bytesWritten
        }
      }
      if (!bytes) throw new DeviceRecordingError('empty_audio', 400)
      await handle.sync()
      await handle.close()
      const sha256 = sha.digest('hex')
      await fs.rename(tmp, path.join(pending, 'recording_device.webm'))
      await writeJson(pending, 'receipt.json', { key, bytes, sha256 })
      await fs.mkdir(meetings, { recursive: true })
      await fs.rename(pending, complete)
      return { meetingId: id, bytes, sha256, reused: false as const, startedAt: metadata.createdAt }
    } finally {
      await handle.close().catch(() => {})
      await fs.unlink(tmp).catch(() => {})
    }
  })
}
