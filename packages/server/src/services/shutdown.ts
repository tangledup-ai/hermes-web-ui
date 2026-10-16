import { logger } from './logger'
import { closeDb } from '../db'
import { stopPreviewRuntime } from '../controllers/update'
import { codingAgentRunManager } from './coding-agents/runtime/run-manager'
import { shutdownManagedGateways } from './hermes/gateway-runner'
import { stopPeriodicGatewayReaper } from './hermes/gateway-autostart'
import { shutdownLocalSttRuntime } from './hermes/local-stt-model-manager'
import { stopOutboundRelayClient } from './global-agent/outbound-relay-client'
import { stopUSBService } from './usb'
import { stopHeadlessBrowserRuntime } from './browser/runtime'
import { stopWebBrowserBroker } from './browser/broker-instance'
import { stopAppRelayClient } from './app-relay/client'
import { closeGlobalEkkoAgent } from './ekko-agent/manager'
import { stopChatWebhookDispatcher } from './hermes/chat-webhooks'

const DEFAULT_SHUTDOWN_FORCE_EXIT_MS = 15_000
const DEFAULT_DESKTOP_SHUTDOWN_FORCE_EXIT_MS = 15_000

function envPositiveInt(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function getShutdownForceExitMs(): number {
  const override = envPositiveInt('HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS')
  if (override) return override
  const desktop = String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
  return desktop ? DEFAULT_DESKTOP_SHUTDOWN_FORCE_EXIT_MS : DEFAULT_SHUTDOWN_FORCE_EXIT_MS
}

export function shouldStopAgentBridgeOnShutdown(_signal: string): boolean {
  const raw = String(process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN || '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false

  // Restart now defaults to a fresh bridge so package/runtime upgrades do not
  // attach to stale brokers. Operators can opt back into restart resume with
  // HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN=0.
  return true
}

export function shouldStopManagedGatewaysOnShutdown(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN || '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false

  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production'
}

export type ShutdownHandler = (signal: string) => Promise<void>

export function createShutdownHandler(server: any, groupChatServer?: any, chatRunServer?: any, agentBridgeManager?: any, usbSocketServer?: { close?: () => void }): ShutdownHandler {
  let isShuttingDown = false

  return async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    const stopAgentBridge = Boolean(agentBridgeManager && shouldStopAgentBridgeOnShutdown(signal))

    // Force exit only if graceful cleanup hangs. The bridge can take up to 10s
    // to stop worker subprocesses, so this cap must be longer than that.
    const forceExitTimer = setTimeout(() => {
      if (stopAgentBridge) {
        try {
          agentBridgeManager?.forceStop?.()
        } catch (err) {
          logger.warn(err, 'Failed to force-stop agent bridge during shutdown timeout')
        }
      }
      process.exit(0)
    }, getShutdownForceExitMs())

    logger.info('Shutting down (%s)...', signal)
    console.log(`[shutdown] Received signal: ${signal}`)

    try {
      try {
        await stopPreviewRuntime()
        logger.info('Preview runtime stopped')
      } catch (err) {
        logger.warn(err, 'Failed to stop preview runtime (non-fatal)')
      }

      // ★ ADR-0011: stop the periodic reaper *before* killing managed
      // gateways so the timer can't fire mid-shutdown and race with the
      // stop signals.
      try {
        stopPeriodicGatewayReaper()
      } catch (err) {
        logger.warn(err, 'Failed to stop periodic gateway reaper (non-fatal)')
      }
      try {
        await shutdownLocalSttRuntime()
        logger.info('Local STT runtime stopped')
      } catch (err) {
        logger.warn(err, 'Failed to stop local STT runtime (non-fatal)')
      }

      if (shouldStopManagedGatewaysOnShutdown()) {
        try {
          const result = await shutdownManagedGateways()
          logger.info('[shutdown] managed gateways stopped result=%j', result)
        } catch (err) {
          logger.warn(err, 'Failed to stop managed gateways (non-fatal)')
        }
      } else {
        logger.info('[shutdown] leaving managed gateways running')
      }

      // Stop accepting/routing chat work before stopping the bridge. This lets
      // ChatRunSocket release any claimed background completion back to Hermes
      // while the broker is still reachable.
      if (chatRunServer) {
        await chatRunServer.close()
        logger.info('ChatRunSocket closed')
      }
      stopChatWebhookDispatcher()
      logger.info('Chat webhook dispatcher stopped')

      if (stopAgentBridge) {
        try {
          await agentBridgeManager.stop()
          logger.info('Agent bridge stopped')
        } catch (err) {
          logger.warn(err, 'Failed to stop agent bridge (non-fatal)')
        }
      } else if (agentBridgeManager) {
        logger.info('Leaving agent bridge running across Web UI shutdown')
      }

      stopOutboundRelayClient()
      logger.info('Outbound relay clients closed')
      stopAppRelayClient()
      logger.info('App relay clients closed')

      codingAgentRunManager.shutdown()
      logger.info('Coding agent hidden sessions closed')

      try {
        await stopUSBService()
        logger.info('USB service stopped')
      } catch (err) {
        logger.warn(err, 'Failed to stop USB service (non-fatal)')
      }

      // spec-05/spec-02: the broker and the headless browser runtime are owned
      // by the server, so they must not outlive it. The broker removes only its
      // own descriptor file; the runtime is bounded by stopTimeoutMs (5s) + 1s.
      try {
        await stopWebBrowserBroker()
        logger.info('Web browser broker stopped')
      } catch (err) {
        logger.warn(err, 'Failed to stop the web browser broker (non-fatal)')
      }

      try {
        await stopHeadlessBrowserRuntime()
        logger.info('Headless browser runtime stopped')
      } catch (err) {
        logger.warn(err, 'Failed to stop headless browser runtime (non-fatal)')
      }

      try {
        usbSocketServer?.close?.()
        logger.info('USB socket server closed')
      } catch (err) {
        logger.warn(err, 'Failed to close USB socket server (non-fatal)')
      }

      // Disconnect Socket.IO before HTTP server to prevent hanging
      if (groupChatServer) {
        await groupChatServer.agentClients.disconnectAll()
        groupChatServer.getIO().close()
        logger.info('Socket.IO closed')
      }

      const servers = Array.isArray(server) ? server : [server].filter(Boolean)
      if (servers.length) {
        await Promise.all(servers.map((httpServer) => (
          new Promise<void>((resolve) => {
            httpServer.close(() => {
              logger.info('HTTP server closed')
              resolve()
            })
          })
        )))
      }
    } catch (err) {
      logger.error(err, 'Shutdown error')
    }

    closeGlobalEkkoAgent()
    closeDb()
    clearTimeout(forceExitTimer)
    process.exit(0)
  }
}

export function bindShutdown(server: any, groupChatServer?: any, chatRunServer?: any, agentBridgeManager?: any, usbSocketServer?: { close?: () => void }): ShutdownHandler {
  const shutdown = createShutdownHandler(server, groupChatServer, chatRunServer, agentBridgeManager, usbSocketServer)

  process.once('SIGUSR2', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return shutdown
}
