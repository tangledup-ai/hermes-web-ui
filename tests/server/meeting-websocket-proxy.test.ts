import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { Server as SocketIOServer } from 'socket.io'
import { io, type Socket } from 'socket.io-client'
import { WebSocket, WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import type { MeetingLiveEvent, MeetingLiveSession } from '../../packages/shared/meeting-live'

const runtime = vi.hoisted(() => ({
  asrPort: 0, diarizePort: 0,
  ensureReady: vi.fn(async () => {}),
  contexts: [] as unknown[],
  consent: false,
}))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  isAuthEnabled: async () => true,
  authenticateUserToken: async (token: string) => token === 'meeting-user' ? { id: 1, profiles: ['default', 'work'] }
    : token === 'other-user' ? { id: 2, profiles: ['work'] } : null,
  getToken: async () => 'meeting-server-token',
}))
vi.mock('../../packages/server/src/modules/studio/services/meeting-asr', () => ({
  meetingASRService: {
    getASRPort: () => runtime.asrPort,
    getDiarizePort: () => runtime.diarizePort,
    useTls: false,
  },
}))
vi.mock('../../packages/server/src/modules/studio/services/realtime-backend', () => ({
  ensureRealtimeBackendReady: runtime.ensureReady,
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/repositories/meeting-device-consent-store', () => ({
  getDeviceConsentRow: (userId: number, profile: string) => runtime.consent && userId === 1 && profile === 'work',
  writeDeviceConsentRow: (userId: number, profile: string, _provider: string, granted: boolean) => {
    if (userId === 1 && profile === 'work') runtime.consent = granted
  },
}))
import { setupMeetingWebSocketProxy } from '../../packages/server/src/bootstrap/meeting-websocket'
import { setDeviceConsent } from '../../packages/server/src/modules/studio/services/meeting-asr/device-consent'
import { deviceMeetingLiveService } from '../../packages/server/src/modules/studio/services/meeting-asr/device-live'

const servers: Server[] = []
const sockets: WebSocket[] = []
const backends: WebSocketServer[] = []
const spectators: Socket[] = []
const liveServers: SocketIOServer[] = []
async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}
async function backend(label: string) {
  const server = createServer()
  const ws = new WebSocketServer({ server })
  backends.push(ws)
  ws.on('connection', (socket, req) => {
    sockets.push(socket)
    expect(req.headers.authorization).toBeUndefined()
    expect(req.headers.cookie).toBeUndefined()
    expect(req.headers['x-studio-transcription-token']).toMatch(/^[a-f0-9]{64}$/)
    runtime.contexts.push(JSON.parse(Buffer.from(String(req.headers['x-studio-transcription-context']), 'base64url').toString()))
    socket.send(`${label}:${req.url}`)
  })
  return listen(server)
}
afterEach(async () => {
  deviceMeetingLiveService.close()
  spectators.splice(0).forEach(socket => socket.disconnect())
  sockets.splice(0).forEach(socket => socket.terminate())
  backends.splice(0).forEach(server => server.close())
  await Promise.all(liveServers.splice(0).map(ioServer => ioServer.close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  runtime.contexts.length = 0
  runtime.consent = false
  vi.clearAllMocks()
})

it.each(['/ws/asr', '/ws/diarize', '/ws/omni-realtime'])('forwards %s upgrades, retaining query parameters and selecting the managed child', async path => {
  runtime.asrPort = await backend('asr')
  runtime.diarizePort = await backend('diarize')
  const proxy = createServer()
  setupMeetingWebSocketProxy([proxy])
  const port = await listen(proxy)
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}?profile=default`)
  sockets.push(socket)
  const message = await new Promise<string>((resolve, reject) => {
    socket.once('message', value => resolve(String(value)))
    socket.once('error', reject)
  })
  expect(message).toBe(`${path === '/ws/diarize' ? 'diarize' : 'asr'}:${path}?profile=default`)
  expect(runtime.ensureReady).toHaveBeenCalledTimes(path === '/ws/omni-realtime' ? 1 : 0)
  expect(runtime.contexts).toMatchObject([{ owner: JSON.stringify(['default', null]) }])
})

async function proxyServer() {
  runtime.asrPort = await backend('asr')
  const proxy = createServer()
  setupMeetingWebSocketProxy([proxy])
  return listen(proxy)
}

it.each([
  { token: '', expected: 401, origin: '' },
  { token: '?token=meeting-user', expected: 403, origin: 'https://untrusted.invalid' },
  { token: '?token=meeting-user&profile=private', expected: 403, origin: '' },
])('rejects browser upgrades with HTTP $expected before starting ASR', async ({ token, expected, origin }) => {
  const port = await proxyServer()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/omni-realtime${token}`, { origin: origin || `http://127.0.0.1:${port}` })
  sockets.push(socket)
  const status = await new Promise<number | undefined>((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode) })
    socket.on('error', reject)
  })
  expect(status).toBe(expected)
  expect(runtime.ensureReady).not.toHaveBeenCalled()
})

it.each(['meeting-user', 'meeting-server-token'])('accepts valid credentials without forwarding them to Python', async token => {
  const port = await proxyServer()
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/asr?profile=default&token=${token}`, {
    origin: `http://127.0.0.1:${port}`,
    headers: {
      Authorization: `Bearer ${token}`, Cookie: 'session=private',
      'x-studio-transcription-context': 'forged', 'x-studio-transcription-token': 'forged',
    },
  })
  sockets.push(socket)
  const message = await new Promise<string>((resolve, reject) => {
    socket.once('message', value => resolve(String(value)))
    socket.once('error', reject)
  })
  expect(message).toBe('asr:/ws/asr?profile=default')
  expect(runtime.contexts).toMatchObject([{ owner: JSON.stringify(['default', token === 'meeting-user' ? 1 : null]) }])
})

it('requires account consent on native H618 loopback and forwards a signed fixed-provider context', async () => {
  const port = await proxyServer()
  const connect = (token?: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/asr`, {
      headers: { 'X-Keli-Device': 'h618', 'X-Hermes-Profile': 'work', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
    sockets.push(socket)
    const response = new Promise<number | string | undefined>((resolve, reject) => {
      socket.once('unexpected-response', (_, response) => { response.resume(); resolve(response.statusCode) })
      socket.once('message', value => resolve(String(value)))
      socket.once('error', reject)
    })
    return { socket, response }
  }
  expect(await connect().response).toBe(401)
  expect(await connect('meeting-server-token').response).toBe(401)
  expect(await connect('meeting-user').response).toBe(403)
  expect(runtime.contexts).toHaveLength(0)
  runtime.consent = true
  const active = connect('meeting-user')
  expect(await active.response).toBe('asr:/ws/asr')
  expect(runtime.contexts).toMatchObject([{ owner: JSON.stringify(['work', 1]), fixedProvider: true }])
  setDeviceConsent(2, 'work', 'dashscope', false)
  expect(active.socket.readyState).toBe(WebSocket.OPEN)
  const closed = new Promise<void>(resolve => active.socket.once('close', () => resolve()))
  setDeviceConsent(1, 'work', 'dashscope', false)
  await closed
  expect(await connect('meeting-user').response).toBe(403)
})

it('mirrors the existing device ASR stream to the matching account and resumes its same archive ID', async () => {
  const upstreamServer = createServer()
  const upstreamWs = new WebSocketServer({ server: upstreamServer })
  backends.push(upstreamWs)
  upstreamWs.on('connection', ws => sockets.push(ws))
  runtime.asrPort = await listen(upstreamServer)
  runtime.consent = true
  const proxy = createServer()
  const socketServer = new SocketIOServer(proxy)
  liveServers.push(socketServer)
  deviceMeetingLiveService.init(socketServer)
  setupMeetingWebSocketProxy([proxy])
  const port = await listen(proxy)
  const id = 'h618-live-recording'
  const startedAt = Date.now() - 4_000

  function spectator(token: string, profile: string) {
    const socket = io(`http://127.0.0.1:${port}/meeting-live`, {
      autoConnect: false, forceNew: true, transports: ['websocket'], reconnection: false, auth: { token, profile },
    })
    spectators.push(socket)
    return socket
  }
  function snapshot(socket: Socket): Promise<MeetingLiveSession[]> {
    return new Promise(resolve => {
      socket.once('sessions', resolve)
      socket.connect()
    })
  }
  function connectAsr(device: boolean) {
    const upstreamReady = once(upstreamWs, 'connection')
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/asr?profile=work&meetingId=${id}&startedAt=${startedAt}`, {
      headers: {
        Authorization: 'Bearer meeting-user', 'X-Hermes-Profile': 'work', ...(device ? { 'X-Keli-Device': 'h618' } : {}),
      },
    })
    sockets.push(socket)
    return { socket, upstreamReady }
  }

  const unauthorized = spectator('meeting-server-token', 'work')
  const rejected = new Promise<Error>(resolve => unauthorized.once('connect_error', resolve))
  unauthorized.connect()
  expect((await rejected).message).toBe('Authentication failed')
  const otherUser = spectator('other-user', 'work')
  const otherProfile = spectator('meeting-user', 'default')
  expect(await snapshot(otherUser)).toEqual([])
  expect(await snapshot(otherProfile)).toEqual([])
  const crossScope = vi.fn()
  otherUser.on('session', crossScope)
  otherProfile.on('session', crossScope)

  const sameAccount = spectator('meeting-user', 'work')
  expect(await snapshot(sameAccount)).toEqual([])
  const events: MeetingLiveEvent[] = []
  sameAccount.on('session', (event: MeetingLiveEvent) => events.push(event))

  const browser = connectAsr(false)
  const [browserUpstream] = await browser.upstreamReady
  const browserMessage = once(browser.socket, 'message')
  browserUpstream.send(JSON.stringify({ type: 'final', text: 'Browser microphone' }))
  await browserMessage
  expect(events).toEqual([])

  const board = connectAsr(true)
  const [upstream, upstreamRequest] = await board.upstreamReady
  await vi.waitFor(() => expect(events).toContainEqual({
    type: 'upsert', session: { id, source: 'h618', startedAt, status: 'connecting', partial: '', sentences: [] },
  }))
  expect(upstreamRequest.url).toBe('/ws/asr?profile=work')
  const ready = once(board.socket, 'message')
  upstream.send(JSON.stringify({ type: 'ready' }))
  await ready
  board.socket.send(JSON.stringify({ type: 'capture_offset', offsetMs: 2900 }))
  const pcmReceived = once(upstream, 'message')
  const pcm = Buffer.from([1, 2, 3, 4])
  board.socket.send(pcm)
  await expect(pcmReceived).resolves.toEqual([pcm, true])
  upstream.send(JSON.stringify({ type: 'partial', text: '会议进' }))
  await vi.waitFor(() => expect(events).toContainEqual({ type: 'partial', id, text: '会议进' }))
  upstream.send(JSON.stringify({ type: 'final', text: '会议进展。', begin_time: 1200, end_time: 2300 }))
  await vi.waitFor(() => expect(events).toContainEqual({
    type: 'final', id, sentence: { text: '会议进展。', timestamp: expect.any(Number), startTime: 4100, endTime: 5200 },
  }))

  const joinLate = spectator('meeting-user', 'work')
  expect(await snapshot(joinLate)).toMatchObject([{ id, status: 'transcribing', partial: '', sentences: [{ text: '会议进展。' }] }])
  const firstClosed = once(board.socket, 'close')
  board.socket.close()
  await firstClosed
  await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'upsert', session: { id, status: 'disconnected' } }))

  const reconnected = connectAsr(true)
  const [reconnectedUpstream] = await reconnected.upstreamReady
  reconnectedUpstream.send(JSON.stringify({ type: 'ready' }))
  await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'upsert', session: { id, status: 'transcribing', sentences: [{ text: '会议进展。' }] } }))
  reconnectedUpstream.send(JSON.stringify({ type: 'stopped' }))
  await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'upsert', session: { id, status: 'syncing' } }))
  sameAccount.disconnect()
  deviceMeetingLiveService.saved({ userId: 1, profile: 'work' }, id, startedAt)
  expect(await snapshot(sameAccount)).toMatchObject([{ id, status: 'saved', sentences: [{ text: '会议进展。' }] }])
  expect(crossScope).not.toHaveBeenCalled()
})
