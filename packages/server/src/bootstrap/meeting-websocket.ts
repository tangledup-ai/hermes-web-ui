import type http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { authenticateUserToken, getToken, isAuthEnabled } from '../modules/studio/public/auth'
import { config } from '../modules/studio/public/config'
import { meetingASRService } from '../modules/studio/services/meeting-asr'
import { ensureRealtimeBackendReady } from '../modules/studio/services/realtime-backend'
import { logger } from '../modules/studio/public/logging'
import { parseUpgradeRequestUrl, shouldRejectUpgradeOrigin, writeForbiddenOrigin } from '../modules/studio/middleware/security'
import { MeetingProfileError, resolveMeetingProfile } from '../modules/studio/services/meeting-asr/profile'
import { DEVICE_SOURCE_HEADER, isH618MeetingSource, trackDeviceTranscription } from '../modules/studio/services/meeting-asr/device-consent'
import {
  meetingTranscriptionRequestContext,
  TRANSCRIPTION_CONTEXT_HEADER,
  TRANSCRIPTION_TOKEN_HEADER,
} from '../modules/studio/services/meeting-asr/transcription-settings'

export const MEETING_WEBSOCKET_PATHS = new Set(['/ws/asr', '/ws/diarize', '/ws/omni-realtime'])

/** Keep browser-facing TLS termination separate from the managed ASR child. */
export function setupMeetingWebSocketProxy(servers: http.Server[]): void {
  // ASR/DIARIZE WebSocket proxy: forward browser WSS upgrade requests to the
  // Python backend on loopback. Node already terminates browser-facing TLS.
  //
  // The transport (raw TCP vs TLS) follows whatever meetingASRService decided
  // for its uvicorn children — see MeetingASRService.useTls. Keeping the
  // decision inside the service removes the chance of desynced deploy
  // configuration (proxy in one mode, uvicorn in another).
  servers.forEach((httpServer) => {
    httpServer.on('upgrade', async (req: http.IncomingMessage, socket: import('net').Socket, head: Buffer) => {
      const upgradeUrl = parseUpgradeRequestUrl(req)
      if (!upgradeUrl) return
      const pathname = upgradeUrl.pathname
      if (!MEETING_WEBSOCKET_PATHS.has(pathname)) return

      socket.pause()
      if (shouldRejectUpgradeOrigin(req, config.corsOrigins)) {
        writeForbiddenOrigin(socket)
        return
      }
      // Released native Qt clients connect directly on device loopback without
      // Origin. Browser and remote clients must present the existing Studio
      // user JWT or server token; forwarded-IP headers never grant this bypass.
      const address = req.socket.remoteAddress || ''
      const nativeLoopback = !req.headers.origin
        && (address === '::1' || /^127\./.test(address) || /^::ffff:127\./.test(address))
      const authorization = req.headers.authorization || ''
      const h618 = pathname === '/ws/asr' && isH618MeetingSource(req.headers[DEVICE_SOURCE_HEADER])
      const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      const token = h618 ? bearer : upgradeUrl.searchParams.get('token') || bearer
      let user: Awaited<ReturnType<typeof authenticateUserToken>> = null
      let profile: string
      try {
        user = token ? await authenticateUserToken(token) : null
        if (h618 && !user) {
          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
          return
        }
        if (!nativeLoopback && await isAuthEnabled()) {
          const serverToken = token && !user ? await getToken() : ''
          const matchesServerToken = Boolean(token && serverToken && Buffer.byteLength(token) === Buffer.byteLength(serverToken)
            && timingSafeEqual(Buffer.from(token), Buffer.from(serverToken)))
          if (!user && !matchesServerToken) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
            return
          }
        }
        const query = upgradeUrl.searchParams.get('profile') || undefined
        const header = req.headers['x-hermes-profile']
        if (h618 && (Array.isArray(header) || (query && header && query.trim() !== header.trim()))) {
          throw new MeetingProfileError('Conflicting meeting profiles', 400)
        }
        const requestedProfile = h618 && typeof header === 'string' ? header : query
        profile = resolveMeetingProfile(user ?? undefined, nativeLoopback && !user ? undefined : requestedProfile)
      } catch (error) {
        if (error instanceof MeetingProfileError) {
          socket.end(`HTTP/1.1 ${error.status === 403 ? '403 Forbidden' : '400 Bad Request'}\r\nConnection: close\r\n\r\n`)
          return
        }
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        return
      }
      if (socket.destroyed) return
      // Do not send browser credentials to the Python child or its access log.
      upgradeUrl.searchParams.delete('token')
      const upstreamPath = upgradeUrl.pathname + upgradeUrl.search

      const upgradeTimer = setTimeout(() => socket.destroy(), 65_000)
      socket.once('close', () => clearTimeout(upgradeTimer))
      const forward = (upstream: import('net').Socket, contextHeaders: Record<string, string>): void => {
        clearTimeout(upgradeTimer)
        if (socket.destroyed) {
          upstream.destroy()
          return
        }
        const requestLine = `${req.method} ${upstreamPath} HTTP/${req.httpVersion}\r\n`
        const headers = [...Object.entries(req.headers)
          .filter(([key]) => key !== 'authorization' && key !== 'cookie'
            && key !== TRANSCRIPTION_CONTEXT_HEADER && key !== TRANSCRIPTION_TOKEN_HEADER), ...Object.entries(contextHeaders)]
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\r\n')
        upstream.write(`${requestLine}${headers}\r\n\r\n`)
        if (head && head.length > 0) {
          upstream.write(head)
        }
        upstream.pipe(socket)
        socket.pipe(upstream)
        socket.resume()
        socket.on('close', () => upstream.destroy())
        upstream.on('close', () => socket.destroy())
        upstream.on('error', () => socket.destroy())
        socket.on('error', () => upstream.destroy())
      }

      // The native realtime entry can be the first caller after a server restart.
      void (pathname === '/ws/omni-realtime' ? ensureRealtimeBackendReady() : Promise.resolve())
        .then(() => meetingTranscriptionRequestContext(profile, user?.id, pathname === '/ws/omni-realtime' ? 'realtime' : 'transcription', h618))
        .then(({ headers, provider }) => {
          if (socket.destroyed) return
          if (h618) {
            const release = user && trackDeviceTranscription(user.id, profile, provider, () => socket.destroy())
            if (!release) {
              socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
              return
            }
            socket.once('close', release)
          }
          const targetPort = pathname === '/ws/diarize' ? meetingASRService.getDiarizePort() : meetingASRService.getASRPort()
          if (!targetPort) {
            socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
            return
          }
          if (meetingASRService.useTls) {
            // Lazy-load tls only when the device runtime actually needs it.
            import('node:tls').then((tls) => {
              forward(tls.connect({ port: targetPort, host: '127.0.0.1', rejectUnauthorized: false }), headers)
            }).catch((err) => {
              logger.error('[bootstrap] failed to load node:tls for ASR proxy: %s', err?.message || err)
              socket.destroy()
            })
          } else {
            // Dev/local default — uvicorn serves plain HTTP, so a raw TCP relay
            // is correct and avoids TLS handshake failures against non-SSL backends.
            import('net').then((net) => {
              forward(net.connect(targetPort, '127.0.0.1'), headers)
            }).catch((err) => {
              logger.error('[bootstrap] failed to load node:net for ASR proxy: %s', err?.message || err)
              socket.destroy()
            })
          }
        }).catch((err) => {
          logger.warn('[bootstrap] realtime backend unavailable: %s', err?.message || err)
          socket.destroy()
        })
    })
  })

}
