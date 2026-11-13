import { randomUUID } from 'node:crypto'
import type { Namespace, Server } from 'socket.io'
import type { MeetingLiveEvent, MeetingLiveSentence, MeetingLiveSession } from '../../../../../../shared/meeting-live'
import { authenticateUserToken } from '../../public/auth'
import { resolveMeetingProfile } from './profile'

interface Account {
  userId: number
  profile: string
}

interface DeviceLiveRecord {
  session: MeetingLiveSession
  stream?: symbol
  lastPartialAt: number
  pendingPartial?: ReturnType<typeof setTimeout>
  expiry?: ReturnType<typeof setTimeout>
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
const MAX_SENTENCES = 120
const MAX_SESSIONS_PER_ROOM = 12
const PARTIAL_INTERVAL_MS = 180
const RETENTION_MS = 5 * 60_000
const MAX_TEXT_LENGTH = 2_000

function roomFor({ userId, profile }: Account): string {
  return JSON.stringify([userId, profile])
}

function asMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function parseCaptionMessage(raw: string): Record<string, unknown> | null {
  if (raw.length > 16_384) return null
  try {
    const result: unknown = JSON.parse(raw)
    return result && typeof result === 'object' ? result as Record<string, unknown> : null
  } catch {
    return null
  }
}

class DeviceMeetingLiveService {
  private namespace?: Namespace
  private rooms = new Map<string, Map<string, DeviceLiveRecord>>()

  init(io: Server): void {
    const namespace = io.of('/meeting-live')
    this.namespace = namespace
    namespace.use(async (socket, next) => {
      const { token, profile } = socket.handshake.auth
      try {
        const user = typeof token === 'string' ? await authenticateUserToken(token) : null
        if (!user?.id || typeof profile !== 'string' || !profile.trim()) throw new Error('Invalid credentials')
        socket.data.meetingLiveRoom = roomFor({ userId: user.id, profile: resolveMeetingProfile(user, profile) })
        next()
      } catch {
        next(new Error('Authentication failed'))
      }
    })
    namespace.on('connection', async socket => {
      const room: string = socket.data.meetingLiveRoom
      await socket.join(room)
      socket.emit('sessions', Array.from(this.rooms.get(room)?.values() ?? [], item => item.session))
    })
  }

  close(): void {
    this.namespace = undefined
    for (const [room, records] of this.rooms) {
      for (const record of records.values()) {
        record.stream = undefined
        this.remove(room, record)
      }
    }
  }

  begin(account: Account, requestedId: string | null, requestedStart: string | null) {
    const room = roomFor(account)
    const id = requestedId && SESSION_ID.test(requestedId) ? requestedId : randomUUID()
    const startedAt = asMs(Number(requestedStart)) || Date.now()
    const record = this.getOrCreate(room, id, Math.min(startedAt, Date.now()), 'connecting')
    if (!record || record.session.status === 'saved') return null
    const stream = Symbol(id)
    record.stream = stream
    clearTimeout(record.expiry)
    this.setStatus(room, record, 'connecting')
    let offset: number | undefined
    return {
      caption: (raw: string) => {
        if (record.stream !== stream) return
        const message = parseCaptionMessage(raw)
        if (message?.type === 'ready' || message?.type === 'started') {
          offset ??= Math.max(0, Date.now() - record.session.startedAt)
          if (record.session.status === 'connecting') this.setStatus(room, record, 'transcribing')
        } else if (message?.type === 'stopped') {
          this.setStatus(room, record, 'syncing')
        } else if (message?.type === 'partial' && typeof message.text === 'string') {
          this.partial(room, record, message.text.slice(0, MAX_TEXT_LENGTH))
        } else if (message?.type === 'final' && typeof message.text === 'string') {
          const text = message.text.trim().slice(0, MAX_TEXT_LENGTH)
          if (!text) return
          this.clearPartial(record)
          const begin = asMs(message.begin_time)
          const end = asMs(message.end_time)
          const sentence: MeetingLiveSentence = { text, timestamp: Date.now() }
          if (begin !== undefined) sentence.startTime = (offset ?? 0) + begin
          if (end !== undefined) sentence.endTime = (offset ?? 0) + end
          record.session.sentences.push(sentence)
          if (record.session.sentences.length > MAX_SENTENCES) record.session.sentences.shift()
          this.emit(room, { type: 'final', id, sentence })
        }
      },
      captureOffset: (value: unknown) => {
        const ms = asMs(value)
        if (record.stream === stream && ms !== undefined) offset = ms
      },
      close: () => {
        if (record.stream !== stream) return
        record.stream = undefined
        if (record.session.status !== 'syncing') this.setStatus(room, record, 'disconnected')
        this.expire(room, record)
      },
    }
  }

  saved(account: Account, id: string, startedAt: number): void {
    const room = roomFor(account)
    const record = this.getOrCreate(room, id, startedAt, 'saved')
    if (!record) return
    record.session.startedAt = startedAt
    record.stream = undefined
    this.setStatus(room, record, 'saved')
    this.expire(room, record)
  }

  syncing(account: Account, id: string): void {
    const room = roomFor(account)
    const record = this.rooms.get(room)?.get(id)
    if (!record || record.session.status === 'saved' || record.session.status === 'syncing') return
    record.stream = undefined
    this.setStatus(room, record, 'syncing')
    this.expire(room, record)
  }

  private getOrCreate(room: string, id: string, startedAt: number, status: MeetingLiveSession['status']) {
    let records = this.rooms.get(room)
    if (!records) {
      records = new Map()
      this.rooms.set(room, records)
    }
    const existing = records.get(id)
    if (existing) return existing
    if (records.size >= MAX_SESSIONS_PER_ROOM) {
      const expired = [...records.values()].find(record => !record.stream)
      if (!expired) return null
      this.remove(room, expired)
    }
    const record: DeviceLiveRecord = { session: { id, source: 'h618', startedAt, status, partial: '', sentences: [] }, lastPartialAt: 0 }
    records.set(id, record)
    return record
  }

  private setStatus(room: string, record: DeviceLiveRecord, status: MeetingLiveSession['status']): void {
    this.clearPartial(record)
    record.session.status = status
    this.emit(room, { type: 'upsert', session: record.session })
  }

  private partial(room: string, record: DeviceLiveRecord, text: string): void {
    if (record.session.partial === text) return
    record.session.partial = text
    if (record.pendingPartial) return
    const broadcast = () => {
      record.lastPartialAt = Date.now()
      record.pendingPartial = undefined
      this.emit(room, { type: 'partial', id: record.session.id, text: record.session.partial })
    }
    const delay = PARTIAL_INTERVAL_MS - (Date.now() - record.lastPartialAt)
    if (delay > 0) record.pendingPartial = setTimeout(broadcast, delay).unref()
    else broadcast()
  }

  private clearPartial(record: DeviceLiveRecord): void {
    clearTimeout(record.pendingPartial)
    record.pendingPartial = undefined
    record.session.partial = ''
  }

  private expire(room: string, record: DeviceLiveRecord): void {
    clearTimeout(record.expiry)
    record.expiry = setTimeout(() => this.remove(room, record), RETENTION_MS).unref()
  }

  private remove(room: string, record: DeviceLiveRecord): void {
    const records = this.rooms.get(room)
    if (!records?.delete(record.session.id)) return
    if (!records.size) this.rooms.delete(room)
    clearTimeout(record.expiry)
    this.clearPartial(record)
    this.emit(room, { type: 'remove', id: record.session.id })
  }

  private emit(room: string, event: MeetingLiveEvent): void {
    this.namespace?.to(room).emit('session', event)
  }
}

export const deviceMeetingLiveService = new DeviceMeetingLiveService()
