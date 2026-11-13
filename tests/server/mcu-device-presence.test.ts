import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io, type Socket } from 'socket.io-client'
import { expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: async (token: string) => token === 'studio-user' ? { id: 1, role: 'super_admin' } : null,
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../packages/server/src/modules/studio/services/global-agent/mcu-webhook-events', () => ({
  bindMcuWebhookEvents: vi.fn(),
}))

import { GlobalAgentServer } from '../../packages/server/src/modules/studio/sockets/global-agent'

it('tracks authenticated physical presence for gateways and preserves legacy MCU presence', async () => {
  const http = createServer()
  const sockets = new Server(http)
  const agents = new GlobalAgentServer(sockets)
  agents.init()
  const clients: Socket[] = []
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port

  const connect = async (deviceCode: string, devicePresence?: string) => {
    const client = io(`http://127.0.0.1:${port}/global-agent`, {
      autoConnect: false,
      reconnection: false,
      transports: ['websocket'],
      auth: { token: 'studio-user', role: 'hermes-studio', deviceCode, devicePresence },
    })
    clients.push(client)
    await new Promise<void>((resolve, reject) => client.once('connect', resolve).once('connect_error', reject).connect())
    return client
  }

  try {
    await connect('legacy-box')
    const gateway = await connect('xiaozhi-box', 'reported')
    expect(agents.hasMcuDeviceCode('legacy-box')).toBe(true)
    expect(agents.hasMcuDeviceCode('xiaozhi-box')).toBe(false)

    const rejected = new Promise(resolve => gateway.once('auth.invalid', resolve))
    gateway.emit('mcu.status', { apiToken: 'invalid', deviceConnected: true })
    await rejected
    expect(agents.hasMcuDeviceCode('xiaozhi-box')).toBe(false)

    gateway.emit('mcu.ready', { apiToken: 'studio-user', deviceConnected: true })
    await expect.poll(() => agents.hasMcuDeviceCode('xiaozhi-box')).toBe(true)
    gateway.emit('mcu.status', { apiToken: 'studio-user', deviceConnected: false })
    await expect.poll(() => agents.hasMcuDeviceCode('xiaozhi-box')).toBe(false)
    expect(gateway.connected).toBe(true)
  } finally {
    clients.forEach(client => client.disconnect())
    await sockets.close()
  }
})

it('preserves the per-turn mute request and streams answer text without calling TTS', async () => {
  const http = createServer()
  const sockets = new Server(http)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
  const agents = new GlobalAgentServer(sockets, { localBaseUrl: `http://127.0.0.1:${port}`, fetchImpl })
  agents.init()
  sockets.of('/chat-run').on('connection', socket => {
    socket.on('run', (payload: { input: string; queue_id: string }) => {
      socket.emit('run.started', { queue_id: payload.queue_id })
      const output = payload.input === '返回空结果' ? '' : '这是一条静音回答。'
      socket.emit('run.completed', { queue_id: payload.queue_id, output })
    })
  })
  const client = io(`http://127.0.0.1:${port}/global-agent`, {
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
    auth: { token: 'studio-user', role: 'hermes-studio', instanceId: 'muted-box' },
  })

  try {
    await new Promise<void>((resolve, reject) => client.once('connect', resolve).once('connect_error', reject).connect())
    const interactionId = 'muted-turn'
    const emit = (event: string, payload: Record<string, unknown>) => client.emit(event, {
      apiToken: 'studio-user', interactionId, ...payload,
    })
    emit('voice.stream.start', { channels: 1, speechEnabled: false })
    emit('voice.stream.chunk', { offset: 0, bytes: 2, data: 'AAA=' })
    emit('voice.stream.end', { bytes: 2 })
    await expect.poll(() => fetchImpl.mock.calls.length).toBe(1)
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('X-Hermes-Mcu-Speech-Enabled')).toBe('false')

    const events: Array<{ status: string; text?: string }> = []
    client.on('interaction.status', event => {
      if (event.interactionId === interactionId) events.push(event)
    })
    agents.startMcuVoiceChatTurn({
      userToken: 'studio-user', profile: 'default', clientId: 'muted-box',
      interactionId, transcript: '测试一下', speechEnabled: false,
    })
    await expect.poll(() => events.map(event => event.status)).toContain('completed')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'speaking', text: '这是一条静音回答。' }),
    ]))
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const emptyTurnId = 'empty-turn'
    const emptyEvents: Array<{ status: string; text?: string }> = []
    client.on('interaction.status', event => {
      if (event.interactionId === emptyTurnId) emptyEvents.push(event)
    })
    agents.startMcuVoiceChatTurn({
      userToken: 'studio-user', profile: 'default', clientId: 'muted-box',
      interactionId: emptyTurnId, transcript: '返回空结果',
    })
    await expect.poll(() => emptyEvents.map(event => event.status)).toContain('failed')
    expect(emptyEvents).not.toEqual(expect.arrayContaining([expect.objectContaining({ status: 'completed' })]))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  } finally {
    client.disconnect()
    await sockets.close()
  }
})
