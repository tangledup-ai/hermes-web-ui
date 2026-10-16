import { ensureRealtimeBackendReady } from './services/realtime-backend'
import Koa from 'koa'
import type { Context } from 'koa'
import cors from '@koa/cors'
import serve from 'koa-static'
import send from 'koa-send'
import os from 'os'
import http from 'http'
import https from 'https'
import { join, relative, resolve } from 'path'
import { mkdir } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { config, getLoopbackBaseUrl, getLoopbackPort, shouldCreateWebUiDataDir } from './config'
import { initializeBrowserSurfaceGate } from './config/browser-surface'
import { createBrowserSurfaceProbe } from './services/browser/surface-probe'
import { startWebBrowserBroker } from './services/browser/broker-instance'
import { initLoginLimiter } from './services/login-limiter'
import { bindShutdown } from './services/shutdown'
import { setupTerminalWebSocket } from './routes/hermes/terminal'
import { setupKanbanEventsWebSocket } from './routes/hermes/kanban-events'
import { startVersionCheck } from './routes/health'
import { startReconcileLoop } from './services/update/reconcile'
import { registerRoutes } from './routes'
import { setGroupChatServer } from './routes/hermes/group-chat'
import { setChatRunServer } from './routes/hermes/chat-run'
import { GroupChatServer } from './services/hermes/group-chat'
import {
  getGroupAgentOutboundRelayManager,
  GroupAgentRelayServer,
} from './services/hermes/group-chat/agent-relay'
import { ChatRunSocket } from './services/hermes/run-chat'
import { startChatWebhookDispatcher } from './services/hermes/chat-webhooks'
import { getAgentBridgeManager, startAgentBridgeManager } from './services/hermes/agent-bridge'
import * as hermesCli from './services/hermes/hermes-cli'
import { HermesSkillInjector } from './services/hermes/skill-injector'
import { injectBundledMcpServer } from './services/hermes/studio-mcp-autoinject'
import { ensureProfileGatewaysRunning, startPeriodicGatewayReaper } from './services/hermes/gateway-autostart'
import { refreshConfiguredProviderModelCatalogsInBackground } from './services/hermes/model-catalog-cache'
import { scanLanDevices, selectLanIPv4Address, startLanDiscoveryResponder } from './services/lan-discovery'
import { getLanPeerSocketManager, getLanPeerSocketPath } from './services/lan-peer-socket'
import { startGlobalAgentServer } from './services/global-agent/server'
import { startLocalAppRelayServer } from './services/app-relay/server'
import {
  hasPendingCloudAppConnectionRevocations,
  listAppConnections,
} from './db/hermes/app-connections-store'
import { ensureAppRelayHostClient } from './services/app-relay/connection'
import { setupGlobalEkkoAgent } from './services/ekko-agent/manager'
import { installGradingSocket } from './services/grading/client-requests'
import { WorkflowSocketServer } from './services/workflow-socket'
import { logger } from './services/logger'
import { meetingASRService } from './services/meeting-asr'
import { realtimeAssistService } from './services/meeting-asr/realtime-assist'
import net from 'net'
import { startUSBService } from './services/usb'
import { USBSocketServer } from './services/usb/USBSocketServer'
import { createStaticCompressionMiddleware } from './middleware/static-compression'
import { getStaticCacheControl, SPA_ENTRY_CACHE_CONTROL } from './middleware/static-cache'
import { requireUserJwt, resolveUserProfile } from './middleware/user-auth'
import { createCorsOriginResolver, securityHeaders } from './security'
import type { ShutdownHandler } from './services/shutdown'
import { createRequestBodyParser } from './middleware/request-body-parser'
import {
  migratePersistedPiRuntimeMcpConfigs,
  restorePersistedPiProxyTargets,
  getDshHost,
  shutdownDshHosts,
} from './services/coding-agents'

// Injected by esbuild at build time; fallback to reading package.json in dev mode
declare const __APP_VERSION__: string
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : (() => { try { return JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')).version } catch { return 'dev' } })()

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('FATAL: Uncaught exception')
  console.error(err)
  logger.fatal(err, 'Uncaught exception')
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection')
  console.error(reason)
  logger.error(reason, 'Unhandled rejection')
})

let server: any = null
let servers: any[] = []
let chatRunServer: any = null
let workflowSocketServer: WorkflowSocketServer | null = null
let groupAgentRelayServer: GroupAgentRelayServer | null = null
let agentBridgeManager: any = null
let usbSocketServer: USBSocketServer | null = null
let desktopShutdownHandler: ShutdownHandler | null = null

interface ListenResult {
  primary: any
  servers: any[]
}

function listen(app: Koa, port: number, host: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = app.listen(port, host)
    s.once('listening', () => resolve(s))
    s.once('error', reject)
  })
}

async function listenWithFallback(app: Koa, port: number, host?: string): Promise<ListenResult> {
  const bindHost = host || '0.0.0.0'
  const certDir = resolve(__dirname, '../../certs')
  const certPath = join(certDir, 'server.crt')
  const keyPath = join(certDir, 'server.key')

  if (existsSync(certPath) && existsSync(keyPath)) {
    const httpsOptions: https.ServerOptions = {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    }
    // Protocol-sniffing single-port server: bind once on `port` and dispatch each
    // connection by its first byte. TLS ClientHello records always start with
    // 0x16 (22); plain HTTP requests start with an ASCII method letter. This lets
    // http://<lan-ip>:6060 and https://<lan-ip>:6060 both work on the same port —
    // browsers pick HTTPS when the user clicks "meeting mode", while normal usage
    // stays on HTTP with no self-signed-cert warning.
    const httpHandler = http.createServer(app.callback())
    const httpsHandler = https.createServer(httpsOptions, app.callback())
    const sniffer = net.createServer((socket) => {
      socket.once('readable', () => {
        const first = socket.read(1)
        if (!first) {
          socket.destroy()
          return
        }
        // Put the byte back so the target handler can parse the full stream.
        socket.unshift(first)
        const target = first[0] === 0x16 ? httpsHandler : httpHandler
        target.emit('connection', socket)
      })
    })
    const primary = await new Promise<any>((resolve, reject) => {
      sniffer.listen(port, bindHost)
      sniffer.once('listening', () => {
        console.log(`[bootstrap] protocol-sniffing HTTP/HTTPS listening on ${bindHost}:${port}`)
        resolve(sniffer)
      })
      sniffer.once('error', reject)
    })
    // Keep a plain-HTTP loopback server bound to 127.0.0.1 so on-device
    // processes (Node clients, Python agents, shell/curl scripts) never have to
    // negotiate the self-signed cert. Socket.IO and WS upgrade handlers attach
    // to every server in the returned `servers` array below.
    const loopbackPort = getLoopbackPort()
    const loopbackServer = http.createServer(app.callback())
    await new Promise<void>((resolveLoopback, rejectLoopback) => {
      loopbackServer.once('error', rejectLoopback)
      loopbackServer.listen(loopbackPort, '127.0.0.1', () => resolveLoopback())
    })
    console.log(`[bootstrap] internal loopback HTTP listening on 127.0.0.1:${loopbackPort}`)
    return { primary, servers: [primary, httpHandler, httpsHandler, loopbackServer] }
  }

  // Dev fallback: HTTP when certs not available
  console.log('[bootstrap] TLS certs not found, falling back to HTTP')
  const httpServer = http.createServer(app.callback())
  const primary = await new Promise<any>((resolve, reject) => {
    httpServer.listen(port, bindHost)
    httpServer.once('listening', () => {
      console.log(`[bootstrap] HTTP listening on ${bindHost}:${port}`)
      resolve(httpServer)
    })
    httpServer.once('error', reject)
  })
  return { primary, servers: [primary] }
}

/**
 * 安全获取网络接口信息（兼容 Termux/proot 环境）
 * 在 proot 环境中 os.networkInterfaces() 会抛出权限错误（errno 13）
 */
function safeNetworkInterfaces() {
  try {
    return os.networkInterfaces()
  } catch {
    return {}
  }
}

function isDesktopRuntime(): boolean {
  return String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
}

function isLoopbackAddress(address?: string | null): boolean {
  if (!address) return false
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('::ffff:127.')
}

function bearerToken(ctx: Context): string {
  const header = ctx.get('authorization')
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function registerDesktopShutdownRoute(app: Koa): void {
  app.use(async (ctx, next) => {
    if (ctx.method !== 'POST' || ctx.path !== '/api/desktop/shutdown') {
      await next()
      return
    }

    if (!isDesktopRuntime()) {
      ctx.status = 404
      ctx.body = { error: 'not_found' }
      return
    }

    const remoteAddress = ctx.req.socket.remoteAddress
    if (!isLoopbackAddress(remoteAddress)) {
      ctx.status = 403
      ctx.body = { error: 'forbidden' }
      return
    }

    const expectedToken = String(process.env.AUTH_TOKEN || '').trim()
    if (!expectedToken || bearerToken(ctx) !== expectedToken) {
      ctx.status = 401
      ctx.body = { error: 'unauthorized' }
      return
    }

    if (!desktopShutdownHandler) {
      ctx.status = 503
      ctx.body = { error: 'shutdown_not_ready' }
      return
    }

    ctx.status = 202
    ctx.body = { ok: true }
    setTimeout(() => {
      void desktopShutdownHandler?.('desktop-api')
    }, 50).unref?.()
  })
}

function envFlagEnabled(name: string): boolean {
  const value = String(process.env[name] || '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(value)
}

function gatewayAutostartDisabled(): boolean {
  return envFlagEnabled('HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART')
}

function skillInjectionDisabled(): boolean {
  return envFlagEnabled('HERMES_WEB_UI_DISABLE_SKILL_INJECTION')
}

async function startRuntimeServicesBeforeListen(): Promise<void> {
  if (gatewayAutostartDisabled()) {
    console.log('[bootstrap] profile gateway check disabled by HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART')
  } else {
    void ensureProfileGatewaysRunning()
      .then(() => {
        console.log('[bootstrap] profile gateways checked')
        // ★ ADR-0011: start the cross-platform gateway reaper so stale
        // PID files and ghost PIDs are swept even on Linux/ARMbian where
        // the Windows-only startup recovery does not run.
        startPeriodicGatewayReaper()
      })
      .catch((err) => {
        logger.warn(err, '[bootstrap] failed to ensure profile gateways')
        console.warn('[bootstrap] failed to ensure profile gateways:', err instanceof Error ? err.message : err)
      })
  }

  try {
    // Local dev: timeout the agent bridge start after 15s so the server
    // isn't blocked when the Python process starts slowly or hangs.
    const timeoutMs = parseInt(process.env.AGENT_BRIDGE_TIMEOUT || '15000', 10)
    await Promise.race([
      startAgentBridgeManager(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`agent bridge start timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ])
    agentBridgeManager = getAgentBridgeManager()
    console.log('[bootstrap] agent bridge started')
  } catch (err) {
    logger.warn(err, '[bootstrap] agent bridge failed to start')
    console.warn('[bootstrap] agent bridge failed to start:', err instanceof Error ? err.message : err)
  }
}

function startRuntimeServicesAfterListen(): void {
  if (gatewayAutostartDisabled()) {
    console.log('[bootstrap] profile gateway check disabled by HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART')
  } else {
    void (async () => {
      try {
        await ensureProfileGatewaysRunning()
        console.log('[bootstrap] profile gateways checked')
      } catch (err) {
        logger.warn(err, '[bootstrap] failed to ensure profile gateways')
        console.warn('[bootstrap] failed to ensure profile gateways:', err instanceof Error ? err.message : err)
      }
    })()
  }

  void (async () => {
    try {
      agentBridgeManager = await startAgentBridgeManager()
      console.log('[bootstrap] agent bridge started')
    } catch (err) {
      logger.warn(err, '[bootstrap] agent bridge failed to start')
      console.warn('[bootstrap] agent bridge failed to start:', err instanceof Error ? err.message : err)
      return
    }
  })()
}

function startLanDiscovery(): void {
  const discoverySocket = startLanDiscoveryResponder({ httpPort: config.port })
  let initialScanStarted = false
  const runInitialScan = () => {
    if (initialScanStarted) return
    initialScanStarted = true
    void scanLanDevices().catch(err => logger.warn(err, '[lan-discovery] initial scan failed'))
  }

  if (discoverySocket) {
    discoverySocket.once('listening', runInitialScan)
    const fallbackTimer = setTimeout(runInitialScan, 500)
    fallbackTimer.unref?.()
  } else {
    runInitialScan()
  }
}

export async function bootstrap() {
  console.log(`hermes-web-ui v${APP_VERSION} starting...`)
  await mkdir(config.uploadDir, { recursive: true })
  if (shouldCreateWebUiDataDir()) {
    await mkdir(config.dataDir, { recursive: true })
  }

  // Web Agent browser surface (spec-01): evaluate the off|local gate once and
  // freeze it. Later init steps read the frozen decision through
  // isBrowserSurfaceEnabled() instead of re-reading the environment. The probe
  // below plugs in the spec-02 executable resolver (system chromium first) and
  // records the version it resolved.
  initializeBrowserSurfaceGate({ probe: createBrowserSurfaceProbe() })

  // Web Browser Broker (spec-05): a loopback RPC endpoint the MCP layer finds
  // through the shared descriptor file. It costs one listening socket — no
  // browser process starts until a tab is created — and nothing at all starts
  // when the gate is off (desktop mode keeps Electron as the only broker).
  await startWebBrowserBroker()

  await initLoginLimiter()
  if (skillInjectionDisabled()) {
    console.log('[bootstrap] bundled skill injection disabled by HERMES_WEB_UI_DISABLE_SKILL_INJECTION')
  } else {
    try {
      const skillInjector = new HermesSkillInjector()
      const injectionResult = await skillInjector.injectMissingSkills()
      if (injectionResult.injected.length > 0) {
        logger.info({
          injected: [...new Set(injectionResult.injected)],
          targetCount: injectionResult.targets.length,
        }, '[bootstrap] bundled skills injected')
      }
      if (injectionResult.updated.length > 0) {
        logger.info({
          updated: [...new Set(injectionResult.updated)],
          targetCount: injectionResult.targets.length,
        }, '[bootstrap] bundled skills updated')
      }
    } catch (err) {
      logger.warn(err, '[bootstrap] failed to inject bundled skills')
      console.warn('[bootstrap] failed to inject bundled skills:', err instanceof Error ? err.message : err)
    }
  }

  try {
    await injectBundledMcpServer()
  } catch (err) {
    logger.warn(err, '[bootstrap] failed to inject bundled MCP server')
    console.warn('[bootstrap] failed to inject bundled MCP server:', err instanceof Error ? err.message : err)
  }

  try {
    const migratedPiMcpConfigs = await migratePersistedPiRuntimeMcpConfigs()
    if (migratedPiMcpConfigs > 0) {
      console.log(`[bootstrap] migrated ${migratedPiMcpConfigs} persisted Pi MCP runtime config(s) to proxy mode`)
    }
  } catch (err) {
    logger.warn(err, '[bootstrap] failed to migrate persisted Pi MCP runtime configs')
  }

  try {
    const restoredPiProxyTargets = await restorePersistedPiProxyTargets()
    if (restoredPiProxyTargets > 0) {
      console.log(`[bootstrap] restored ${restoredPiProxyTargets} persisted Pi proxy target(s)`)
    }
  } catch (err) {
    logger.warn(err, '[bootstrap] failed to restore persisted Pi proxy targets')
  }

  setupGlobalEkkoAgent()
  console.log('[bootstrap] ekko-agent setup complete')

  if (!isDesktopRuntime()) {
    await startRuntimeServicesBeforeListen()
  }

  const app = new Koa()
  // Initialize all web-ui SQLite tables
  const { initAllStores } = await import('./db/hermes/init')
  initAllStores()
  startChatWebhookDispatcher()
  console.log('[bootstrap] all stores initialized')
  try {
    const { migrateLegacyDeviceBinding } = await import('./services/wechat-binding-migration')
    await migrateLegacyDeviceBinding()
  } catch (err) {
    logger.warn(err, '[bootstrap] wechat binding migration failed')
  }
  try {
    startUSBService()
    console.log('[bootstrap] usb service initialized')
  } catch (err) {
    logger.warn(err, '[bootstrap] failed to initialize usb service')
    console.warn('[bootstrap] failed to initialize usb service:', err instanceof Error ? err.message : err)
  }

  app.use(securityHeaders())
  app.use(cors({ origin: createCorsOriginResolver(config.corsOrigins) }))
  // Raise body limits above the default 1mb: profile avatars and MiMo voice-clone
  // reference audio are posted as base64 data URLs before reaching handlers.
  app.use(createRequestBodyParser())
  console.log('[bootstrap] cors + bodyParser registered')

  registerDesktopShutdownRoute(app)

  // Register all routes (handles auth internally)
  registerRoutes(app, [requireUserJwt, resolveUserProfile])
  console.log('[bootstrap] routes registered')

  // SPA fallback
  const distDir = resolve(__dirname, '..', 'client')
  app.use(createStaticCompressionMiddleware())
  app.use(serve(distDir, {
    setHeaders(res, filePath) {
      const cacheControl = getStaticCacheControl(relative(distDir, filePath))
      if (cacheControl) res.setHeader('Cache-Control', cacheControl)
    },
  }))
  app.use(async (ctx) => {
    if ((ctx.method === 'GET' || ctx.method === 'HEAD') &&
      !ctx.path.startsWith('/api') &&
      ctx.path !== '/health' &&
      ctx.path !== '/upload') {
      ctx.set('Cache-Control', SPA_ENTRY_CACHE_CONTROL)
      await send(ctx, 'index.html', { root: distDir })
    }
  })
  console.log('[bootstrap] SPA fallback registered')

  // Start server using the configured bind host. Default is IPv4 for WSL stability.
  const listenResult = await listenWithFallback(app, config.port, config.host)
  server = listenResult.primary
  servers = listenResult.servers
  console.log('[bootstrap] app.listen called')

  // Fire-and-forget: pre-warm the Hermes CLI version cache so the first
  // /health probe after a service restart (e.g. immediately after an update
  // cutover) does not pay the cold-start cost of spawning the Python
  // interpreter. Concurrent callers share one in-flight refresh.
  hermesCli.prewarmHermesCliVersion()

  setupTerminalWebSocket(servers)
  setupKanbanEventsWebSocket(servers)
  getLanPeerSocketManager().setupServer(servers)
  // DSH plugin UI gateway owns the WebSocket tunnel to the native runtime.
  void (async () => {
    try {
      const host = await getDshHost()
      host.ui.attach(servers)
    } catch (err) {
      logger.warn(err, '[dsh] plugin UI gateway attach failed')
    }
  })()
  console.log('[bootstrap] terminal + kanban + LAN peer websocket setup')

  const loopbackBaseUrl = getLoopbackBaseUrl()

  // Group chat Socket.IO (must be after server is created)
  const groupChatServer = new GroupChatServer(servers)
  setGroupChatServer(groupChatServer)
  groupAgentRelayServer = new GroupAgentRelayServer(groupChatServer.getIO(), groupChatServer)

  // Chat run Socket.IO — shares the same Server instance, just adds /chat-run namespace
  chatRunServer = new ChatRunSocket(groupChatServer.getIO())
  setChatRunServer(chatRunServer)
  groupChatServer.setChatRunService(chatRunServer)
  chatRunServer.init()
  startLocalAppRelayServer(groupChatServer.getIO(), { localBaseUrl: loopbackBaseUrl })
  console.log('[bootstrap] local App relay server ready')
  if (
    listAppConnections().some(connection => connection.connection_type === 'cloud')
    || hasPendingCloudAppConnectionRevocations()
  ) {
    void ensureAppRelayHostClient().catch(err => logger.warn(err, '[app-relay] cloud host restore failed'))
  }
  void getGroupAgentOutboundRelayManager(() => groupChatServer.getChatRunService()).restore()

  // A process restart loses in-memory scheduler, approval, and runner ownership.
  // Persist a fail-closed terminal state before exposing workflow sockets, then abort
  // any surviving session runners through the now-registered ChatRun service.
  const { getWorkflowManager } = await import('./services/workflow-manager')
  const recoveredWorkflows = await getWorkflowManager().recoverActiveRuns()
  if (recoveredWorkflows.runs > 0) {
    logger.warn('Recovered %d orphaned workflow runs and aborted %d sessions', recoveredWorkflows.runs, recoveredWorkflows.sessions)
  }
  const { getWorkflowScheduleService } = await import('./services/workflow-schedule-service')
  getWorkflowScheduleService().start()

  workflowSocketServer = new WorkflowSocketServer(groupChatServer.getIO())
  installGradingSocket(groupChatServer.getIO())
  workflowSocketServer.init()

  // USB socket bridge shares the same io instance and reports to /usb namespace
  usbSocketServer = new USBSocketServer(groupChatServer.getIO())
  usbSocketServer.init()
  startUSBService()

  // Meeting realtime assist Socket.IO namespace
  realtimeAssistService.init(groupChatServer.getIO())

  startGlobalAgentServer(groupChatServer.getIO(), { localBaseUrl: loopbackBaseUrl })
  console.log('[bootstrap] global agent server ready')

  // Session deleter — periodically drain pending session deletes
  const { SessionDeleter } = await import('./services/hermes/session-deleter')
  const sessionDeleter = SessionDeleter.getInstance()
  const activeProfile = process.env.PROFILE || 'default'
  sessionDeleter.start(activeProfile)
  console.log('[bootstrap] session deleter started, profile=%s', activeProfile)

  // ASR/DIARIZE WebSocket proxy: forward browser WSS upgrade requests to the
  // Python backend on loopback. Node already terminates browser-facing TLS.
  //
  // The transport (raw TCP vs TLS) follows whatever meetingASRService decided
  // for its uvicorn children — see MeetingASRService.useTls. Keeping the
  // decision inside the service removes the chance of desynced deploy
  // configuration (proxy in one mode, uvicorn in another).
  servers.forEach((httpServer) => {
    httpServer.on('upgrade', (req: http.IncomingMessage, socket: import('net').Socket, head: Buffer) => {
      let targetPort: number | null = null
      if (req.url === '/ws/asr') {
        targetPort = meetingASRService.getASRPort() || 8000
      } else if (req.url === '/ws/diarize') {
        targetPort = meetingASRService.getDiarizePort() || 8001
      } else if (req.url === '/ws/omni-realtime') {
        // Omni-Realtime shares the main ASR port (same Python uvicorn process).
        // The endpoint /ws/omni-realtime is routed inside FastAPI in main.py.
        targetPort = meetingASRService.getASRPort() || 8000
      }
      if (!targetPort) return // fall through to catch-all

      const upgradeTimer = setTimeout(() => socket.destroy(), 65_000)
      socket.once('close', () => clearTimeout(upgradeTimer))
      const forward = (upstream: import('net').Socket): void => {
        clearTimeout(upgradeTimer)
        const requestLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
        const headers = Object.entries(req.headers)
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

      socket.pause()
      // Realtime uses the managed ASR child. Node reloads stop that child;
      // lazily restore it instead of forwarding into a closed port forever.
      void (req.url === '/ws/omni-realtime'
        // Realtime 接入前补推一次持久化的 DashScope key：设备端 Qt 客户端只开 WS、
        // 不像浏览器那样把 key 显式下发，若后端先以空 key 启动（用户后来才在
        // 「设置 → 模型 → Realtime 模型」里填 key），这里让它无需重启即可生效。
        ? ensureRealtimeBackendReady().then(() => meetingASRService.ensureDashScopeKeyPushed())
        : Promise.resolve())
        .then(() => {
          if (socket.destroyed) return
          if (req.url === '/ws/omni-realtime') targetPort = meetingASRService.getASRPort() || 8000
          if (meetingASRService.useTls) {
            // Lazy-load tls only when the device runtime actually needs it.
            import('node:tls').then((tls) => {
              forward(tls.connect({ port: targetPort!, host: '127.0.0.1', rejectUnauthorized: false }))
            }).catch((err) => {
              logger.error('[bootstrap] failed to load node:tls for ASR proxy: %s', err?.message || err)
              socket.destroy()
            })
          } else {
            // Dev/local default — uvicorn serves plain HTTP, so a raw TCP relay
            // is correct and avoids TLS handshake failures against non-SSL backends.
            import('net').then((net) => {
              forward(net.connect(targetPort!, '127.0.0.1'))
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

  // Catch-all: destroy upgrade requests not handled by terminal, Socket.IO, or ASR proxy
  servers.forEach((httpServer) => {
    httpServer.on('upgrade', (req: any, socket: any) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`)
      if (url.pathname !== '/api/hermes/terminal' &&
        url.pathname !== '/api/hermes/kanban/events' &&
        url.pathname !== getLanPeerSocketPath() &&
        !url.pathname.startsWith('/socket.io/') &&
        url.pathname !== '/ws/asr' &&
        url.pathname !== '/ws/diarize' &&
        url.pathname !== '/ws/omni-realtime') {
        socket.destroy()
      }
    })
  })

const interfaces = safeNetworkInterfaces()
  const localIp = Object.values(interfaces).flat().find(i => i?.family === 'IPv4' && !i?.internal)?.address || 'localhost'
  console.log(`Server: https://localhost:${config.port} (LAN: https://${localIp}:${config.port})`)
  console.log(`Log: ${config.appHome}/logs/server.log`)
  logger.info('Server: https://localhost:%d (LAN: https://%s:%d)', config.port, localIp, config.port)
  startLanDiscovery()
  refreshConfiguredProviderModelCatalogsInBackground('bootstrap')

  if (isDesktopRuntime()) {
    agentBridgeManager = getAgentBridgeManager()
    startRuntimeServicesAfterListen()
  }

  // Restore group chat agents after server is ready.
  groupChatServer.restoreWhenReady()

  servers.forEach((httpServer) => {
    httpServer.on('error', (err: any) => {
      console.error('[bootstrap] server error:', err.code || err.message)
      logger.error({ err }, 'Server error')
    })
  })

  desktopShutdownHandler = bindShutdown(servers, groupChatServer, chatRunServer, agentBridgeManager, usbSocketServer as any)
  void shutdownDshHosts().catch(err => logger.warn(err, '[dsh] shutdown failed'))
  startVersionCheck()
  startReconcileLoop()
}

bootstrap().catch((error) => {
  console.error('FATAL: Failed to start Hermes Web UI')
  console.error(error)
  logger.fatal(error, 'Fatal error during bootstrap')
  process.exit(1)
})
