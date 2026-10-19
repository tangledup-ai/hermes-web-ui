// Browser automation for the bundled Hermes Agent.
//
// The agent's `browser_exec` tool shells out to the `browser-use` CLI, and that
// CLI only drives a browser that already exposes a Chrome DevTools endpoint. A
// stock desktop install has neither piece, so browser automation failed on the
// first request:
//
//   - the CLI was fetched through `uvx` at request time. That cold install
//     resolves a very large dependency tree (langchain, playwright, lxml, ...)
//     and routinely exceeds the tool's 120-300 s exec timeout, so every attempt
//     was killed mid-install and the cache never warmed up;
//   - once the CLI did exist there was no CDP endpoint to attach to, so it
//     exited with "DevToolsActivePort not found" and the agent fell back to
//     asking the user to open a browser with --remote-debugging-port.
//
// This module closes both gaps at startup, without touching the user's own
// browser or its profile:
//
//   - it writes the `browser-use` shim into $HERMES_HOME/bin, which is the
//     first path the agent's CLI lookup probes. The shim points at the CLI that
//     `scripts/install-hermes.mjs` bundles into the runtime, so no download
//     happens on the user's machine;
//   - it starts the bundled Chromium on a dedicated automation profile with
//     remote debugging enabled and exports BROWSER_CDP_URL, which the agent's
//     browser backend prefers over any value in config.yaml.
//
// The automation profile is separate from both the user's browser profile and
// the desktop's own in-app browser, so no user session or cookie is exposed.
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { bundledAgentBrowserHome, bundledPython, hermesHome, pythonDir, webUiHome } from './paths'

const BROWSER_USE_SITE_DIR = 'browser-use'
const BROWSER_USE_LAUNCHER = 'run_cli.py'
const AUTOMATION_PROFILE_DIR = 'hermes-agent-profile'
const CDP_READY_TIMEOUT_MS = 15_000
const CDP_POLL_INTERVAL_MS = 250

let automationBrowser: ChildProcess | null = null
let stopping = false

/** Directory where `install-hermes.mjs` places the bundled browser-use CLI. */
export function browserUseSiteDir(): string {
  return join(pythonDir(), BROWSER_USE_SITE_DIR)
}

/**
 * Write the `browser-use` shim the agent resolves first ($HERMES_HOME/bin).
 *
 * The shim is regenerated on every launch because the runtime directory moves
 * between installs and upgrades; a copied `browser-use.exe` would keep pointing
 * at the interpreter of the previous runtime.
 */
export function ensureBrowserUseCliShim(): string | null {
  const launcher = join(browserUseSiteDir(), BROWSER_USE_LAUNCHER)
  if (!existsSync(launcher)) return null
  const interpreter = bundledPython()
  if (!existsSync(interpreter)) return null

  const windows = process.platform === 'win32'
  const shimPath = join(hermesHome(), 'bin', windows ? 'browser-use.cmd' : 'browser-use')
  const body = windows
    ? `@echo off\r\n"${interpreter}" "${launcher}" %*\r\n`
    : `#!/bin/sh\nexec "${interpreter}" "${launcher}" "$@"\n`

  try {
    mkdirSync(dirname(shimPath), { recursive: true })
    writeFileSync(shimPath, body, { mode: 0o755 })
    if (!windows) chmodSync(shimPath, 0o755)
    return shimPath
  } catch (error) {
    console.warn('[browser] could not write the browser-use shim:', error)
    return null
  }
}

function systemBrowserCandidates(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return [
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ]
}

/**
 * Chromium binary for the agent's automation profile.
 *
 * Prefers the Chrome for Testing bundle that ships inside the runtime (the same
 * build agent-browser uses), then operator overrides, then a system browser.
 */
export function resolveAutomationChromium(): string | null {
  const override = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim()
  if (override && existsSync(override)) return override

  const candidates: string[] = []
  const browsersRoot = join(bundledAgentBrowserHome(), 'browsers')
  if (existsSync(browsersRoot)) {
    for (const entry of readdirSync(browsersRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('chrome-')) continue
      const root = join(browsersRoot, entry.name)
      candidates.push(
        join(root, 'chrome.exe'),
        join(root, 'chrome-win64', 'chrome.exe'),
        join(root, 'chrome-linux64', 'chrome'),
        join(root, 'chrome-linux', 'chrome'),
        join(root, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(root, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        join(root, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      )
    }
  }
  candidates.push(...systemBrowserCandidates())
  return candidates.find(candidate => existsSync(candidate)) || null
}

async function getFreeTcpPort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => rejectPort(new Error('could not allocate a CDP port')))
        return
      }
      const { port } = address
      server.close(() => resolvePort(port))
    })
  })
}

async function waitForCdp(port: number, deadline: number, child: ChildProcess): Promise<boolean> {
  while (Date.now() < deadline) {
    // A browser that already died will never open the port; fall through to the
    // fallback launch instead of burning the whole timeout.
    if (child.exitCode !== null) return false
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (response.ok) {
        const payload = await response.json() as { webSocketDebuggerUrl?: unknown }
        if (typeof payload.webSocketDebuggerUrl === 'string' && payload.webSocketDebuggerUrl) return true
      }
    } catch {
      // The endpoint is not listening yet; keep polling until the deadline.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, CDP_POLL_INTERVAL_MS))
  }
  return false
}

function automationProfileDir(): string {
  return join(webUiHome(), 'desktop-browser', AUTOMATION_PROFILE_DIR)
}

function launchChromium(chrome: string, profileDir: string, port: number, extraArgs: string[]): ChildProcess {
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    ...extraArgs,
    'about:blank',
  ]
  stopping = false
  const child = spawn(chrome, args, { stdio: 'ignore', windowsHide: true })
  child.once('error', error => console.warn('[browser] automation browser failed to launch:', error))
  child.once('exit', (code, signal) => {
    if (automationBrowser === child) automationBrowser = null
    if (stopping) return
    console.warn(`[browser] automation browser exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)
  })
  return child
}

/**
 * Start the automation browser and export its CDP endpoint for the agent.
 *
 * `BROWSER_CDP_URL` is read by the desktop when it spawns the Web UI server
 * (webui-server.ts spreads process.env), which is how the bundled Hermes Agent
 * receives it. A value already present in the environment always wins so an
 * operator can point the agent at a different browser.
 */
export async function ensureHermesAutomationBrowser(): Promise<void> {
  if (process.env.BROWSER_CDP_URL?.trim()) return
  if (automationBrowser && automationBrowser.exitCode === null) return

  const chrome = resolveAutomationChromium()
  if (!chrome) {
    console.warn('[browser] no Chromium available for agent browser automation')
    return
  }

  const profileDir = automationProfileDir()
  try {
    mkdirSync(profileDir, { recursive: true })
  } catch (error) {
    console.warn('[browser] could not prepare the automation profile:', error)
    return
  }

  let port: number
  try {
    port = await getFreeTcpPort()
  } catch (error) {
    console.warn('[browser] could not allocate a CDP port:', error)
    return
  }

  const deadline = Date.now() + CDP_READY_TIMEOUT_MS
  let child = launchChromium(chrome, profileDir, port, [])
  automationBrowser = child
  if (await waitForCdp(port, deadline, child)) {
    process.env.BROWSER_CDP_URL = `http://127.0.0.1:${port}`
    return
  }

  // Sandboxed/containerized hosts refuse to start Chromium with its sandbox on.
  await stopHermesAutomationBrowser()
  child = launchChromium(chrome, profileDir, port, ['--no-sandbox', '--disable-gpu'])
  automationBrowser = child
  if (await waitForCdp(port, Date.now() + CDP_READY_TIMEOUT_MS, child)) {
    process.env.BROWSER_CDP_URL = `http://127.0.0.1:${port}`
    return
  }

  await stopHermesAutomationBrowser()
  console.warn('[browser] automation browser did not expose a CDP endpoint in time')
}

/** Stop the automation browser; safe to call when it never started. */
export async function stopHermesAutomationBrowser(): Promise<void> {
  const child = automationBrowser
  automationBrowser = null
  if (!child || child.exitCode !== null || !child.pid) return
  stopping = true

  if (process.platform === 'win32') {
    await new Promise<void>(resolveKill => {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.once('exit', () => resolveKill())
      killer.once('error', () => resolveKill())
    })
    return
  }

  try {
    child.kill('SIGTERM')
  } catch {
    // Already gone.
  }
}
