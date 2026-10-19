import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ home: '', runtime: '' }))
const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/desktop/src/main/paths', async () => {
  const { join: joinPath } = await import('node:path')
  return {
    bundledPython: () => joinPath(state.runtime, 'venv', 'Scripts', 'python.exe'),
    bundledAgentBrowserHome: () => joinPath(state.runtime, 'agent-browser'),
    pythonDir: () => state.runtime,
    hermesHome: () => state.home,
    webUiHome: () => state.home,
  }
})

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}))

const {
  ensureBrowserUseCliShim,
  ensureHermesAutomationBrowser,
  resolveAutomationChromium,
  stopHermesAutomationBrowser,
} = await import('../../packages/desktop/src/main/hermes-browser')

const tempDirs: string[] = []
let servers: Server[] = []
const originalEnv = { ...process.env }

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-browser-'))
  tempDirs.push(dir)
  return dir
}

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null as number | null,
    kill: vi.fn(),
  })
}

beforeEach(() => {
  state.home = tempDir()
  state.runtime = tempDir()
  delete process.env.BROWSER_CDP_URL
  delete process.env.AGENT_BROWSER_EXECUTABLE_PATH
  spawnMock.mockReset()
})

afterEach(async () => {
  await stopHermesAutomationBrowser()
  for (const server of servers) {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  }
  servers = []
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
  process.env = { ...originalEnv }
})

describe('browser-use CLI shim', () => {
  it('is skipped when the runtime has no bundled CLI', () => {
    expect(ensureBrowserUseCliShim()).toBeNull()
  })

  it('points the shim at the current interpreter and bundled launcher', () => {
    const launcher = join(state.runtime, 'browser-use', 'run_cli.py')
    mkdirSync(dirname(launcher), { recursive: true })
    writeFileSync(launcher, '')
    const interpreter = join(state.runtime, 'venv', 'Scripts', 'python.exe')
    mkdirSync(dirname(interpreter), { recursive: true })
    writeFileSync(interpreter, '')

    const shim = ensureBrowserUseCliShim()

    expect(shim).toBe(join(state.home, 'bin', process.platform === 'win32' ? 'browser-use.cmd' : 'browser-use'))
    const content = readFileSync(shim as string, 'utf-8')
    expect(content).toContain(interpreter)
    expect(content).toContain(launcher)
  })
})

describe('automation browser discovery', () => {
  it('prefers the Chromium bundled with the runtime', () => {
    const bundled = join(state.runtime, 'agent-browser', 'browsers', 'chrome-149.0.7827.55', 'chrome.exe')
    mkdirSync(dirname(bundled), { recursive: true })
    writeFileSync(bundled, '')

    expect(resolveAutomationChromium()).toBe(bundled)
  })

  it('honours AGENT_BROWSER_EXECUTABLE_PATH', () => {
    const override = join(state.runtime, 'custom-chrome.exe')
    writeFileSync(override, '')
    process.env.AGENT_BROWSER_EXECUTABLE_PATH = override

    expect(resolveAutomationChromium()).toBe(override)
  })
})

describe('automation browser startup', () => {
  it('leaves an existing CDP override untouched', async () => {
    process.env.BROWSER_CDP_URL = 'http://127.0.0.1:9333'

    await ensureHermesAutomationBrowser()

    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.env.BROWSER_CDP_URL).toBe('http://127.0.0.1:9333')
  })

  it('launches Chromium on a dedicated profile and exports BROWSER_CDP_URL', async () => {
    const bundled = join(state.runtime, 'agent-browser', 'browsers', 'chrome-149.0.7827.55', 'chrome.exe')
    mkdirSync(dirname(bundled), { recursive: true })
    writeFileSync(bundled, '')

    spawnMock.mockImplementation((command: string, args: string[]) => {
      if (command !== 'taskkill') {
        const port = Number(args.find(arg => arg.startsWith('--remote-debugging-port='))?.split('=')[1])
        const profileDir = args.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
        expect(profileDir).toBe(join(state.home, 'desktop-browser', 'hermes-agent-profile'))
        const server = createServer((_request, response) => {
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }))
        })
        servers.push(server)
        server.listen(port, '127.0.0.1')
      }
      return fakeChild()
    })

    await ensureHermesAutomationBrowser()

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0][0]).toBe(bundled)
    expect(process.env.BROWSER_CDP_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

})
