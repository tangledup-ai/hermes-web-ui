import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { deviceMeetingLiveService } from '../modules/studio/services/meeting-asr/device-live'

const h618SocketServer = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 })
const MAX_QUEUED_BYTES = 1024 * 1024

export function bridgeDeviceMeetingWebSocket(input: {
  req: IncomingMessage
  socket: Socket
  head: Buffer
  upstreamPath: string
  targetPort: number
  useTls: boolean
  contextHeaders: Record<string, string>
  account: { userId: number; profile: string }
  meetingId: string | null
  startedAt: string | null
}): void {
  const { req, socket, head, upstreamPath, targetPort, useTls, contextHeaders, account, meetingId, startedAt } = input
  h618SocketServer.handleUpgrade(req, socket, head, device => {
    const live = deviceMeetingLiveService.begin(account, meetingId, startedAt)
    device.pause()
    const upstream = new WebSocket(`${useTls ? 'wss' : 'ws'}://127.0.0.1:${targetPort}${upstreamPath}`, {
      headers: contextHeaders,
      handshakeTimeout: 10_000,
      maxPayload: 128 * 1024,
      perMessageDeflate: false,
      ...(useTls ? { rejectUnauthorized: false } : {}),
    })
    function close() {
      live?.close()
      device.terminate()
      upstream.terminate()
    }
    upstream.once('open', () => device.resume())
    device.on('message', (data, binary) => {
      if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > MAX_QUEUED_BYTES) return close()
      if (!binary && live) {
        try {
          const message = JSON.parse(String(data))
          if (message?.type === 'capture_offset') {
            live.captureOffset(message.offsetMs)
            return
          }
        } catch {
          // The ASR backend owns errors for malformed audio control messages.
        }
      }
      upstream.send(data, { binary })
    })
    upstream.on('message', (data, binary) => {
      if (device.readyState !== WebSocket.OPEN || device.bufferedAmount > MAX_QUEUED_BYTES) return close()
      device.send(data, { binary })
      if (!binary) live?.caption(String(data))
    })
    for (const ws of [device, upstream]) {
      ws.once('close', close)
      ws.on('error', close)
    }
  })
}
