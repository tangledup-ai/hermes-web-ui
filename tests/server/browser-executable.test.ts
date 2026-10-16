import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_BROWSER_HOME_ENV,
  BROWSER_EXECUTABLE_PATH_ENV,
  BrowserRuntimeMissingError,
  bundledBrowserExecutableNames,
  findBundleExecutables,
  isLauncherScript,
  parseBrowserVersion,
  resolveBrowserExecutable,
  resolveBrowserExecutableWithTrace,
  type BrowserExecutableProbe,
} from '../../packages/server/src/services/browser/executable'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'browser-exec-'))
  tempDirs.push(dir)
  return dir
}

function writeExecutable(path: string, contents = '#!/bin/sh\nexit 0\n'): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
  try {
    chmodSync(path, 0o755)
  } catch {
    // Windows: chmod is a no-op for the existence/stat checks under test
  }
  return path
}

function fakeProbe(overrides: Partial<BrowserExecutableProbe> = {}): BrowserExecutableProbe {
  return {
    runVersion: () => ({ ok: true, version: '154.0.8037.92', detail: 'Chromium 154.0.8037.92' }),
    runSmoke: () => ({ ok: true, detail: 'headless smoke ok' }),
    ...overrides,
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop() as string
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('browser executable resolution', () => {
  it('prefers AGENT_BROWSER_EXECUTABLE_PATH over bundles and system packages', () => {
    const root = tempDir()
    const envPath = writeExecutable(join(root, 'env-chromium'))
    const home = join(root, 'agent-browser')
    writeExecutable(join(home, 'browsers', 'chrome-154.0.1', 'chrome-linux64', 'chrome'))

    const resolution = resolveBrowserExecutableWithTrace({
      env: { [BROWSER_EXECUTABLE_PATH_ENV]: envPath },
      platform: 'linux',
      validate: 'none',
      bundleHomes: [home],
    })

    expect(resolution.executable.source).toBe('env')
    expect(resolution.executable.path).toBe(envPath)
    expect(resolution.executable.launcher).toBe(true)
  })

  it('falls back to the Chrome for Testing bundle under AGENT_BROWSER_HOME', () => {
    const root = tempDir()
    const home = join(root, 'agent-browser')
    const bundled = writeExecutable(join(home, 'browsers', 'chrome-149.0.7827.55', 'chrome-linux64', 'chrome'))

    const resolution = resolveBrowserExecutableWithTrace({
      env: {
        [BROWSER_EXECUTABLE_PATH_ENV]: join(root, 'missing-env-browser'),
        [AGENT_BROWSER_HOME_ENV]: home,
      },
      platform: 'linux',
      validate: 'none',
      bundleHomes: [home],
    })

    expect(resolution.executable.source).toBe('bundle')
    expect(resolution.executable.path).toBe(bundled)
  })

  it('keeps looking after a candidate fails validation', () => {
    const root = tempDir()
    const broken = writeExecutable(join(root, 'broken-browser'))
    const home = join(root, 'agent-browser')
    const bundled = writeExecutable(join(home, 'browsers', 'chrome-154.0.1', 'chrome-linux64', 'chrome'))
    const probe = fakeProbe({
      runVersion: path => (path === broken
        ? { ok: false, version: null, detail: 'exit 1' }
        : { ok: true, version: '154.0.1', detail: 'Chromium 154.0.1' }),
    })

    const resolution = resolveBrowserExecutableWithTrace({
      env: { [BROWSER_EXECUTABLE_PATH_ENV]: broken },
      platform: 'linux',
      probe,
      bundleHomes: [home],
    })

    expect(resolution.executable.path).toBe(bundled)
    expect(resolution.candidates[0]).toMatchObject({ path: broken, ok: false })
    expect(resolution.candidates[1]).toMatchObject({ path: bundled, ok: true })
  })

  it('prefers the newest bundle directory (numeric order, not lexicographic)', () => {
    const home = join(tempDir(), 'agent-browser')
    writeExecutable(join(home, 'browsers', 'chrome-99.0.1', 'chrome-linux64', 'chrome'))
    const newest = writeExecutable(join(home, 'browsers', 'chrome-154.0.1', 'chrome-linux64', 'chrome'))

    expect(findBundleExecutables(home, 'linux')[0]).toBe(newest)
  })

  it.each([
    ['win32', 'chrome.exe'],
    ['darwin', 'Google Chrome for Testing'],
    ['linux', 'chrome'],
  ] as const)('resolves the %s bundle executable name %s', (platform, name) => {
    const home = join(tempDir(), 'agent-browser')
    const bundleDir = platform === 'darwin'
      ? join(home, 'browsers', 'chrome-149.0.7827.55', 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', name)
      : join(home, 'browsers', 'chrome-149.0.7827.55', `chrome-${platform === 'win32' ? 'win64' : 'linux64'}`, name)
    const executable = writeExecutable(bundleDir)

    const resolution = resolveBrowserExecutableWithTrace({
      env: {},
      platform,
      validate: 'none',
      bundleHomes: [home],
    })

    expect(resolution.executable.path).toBe(executable)
    expect(bundledBrowserExecutableNames(platform)).toContain(name)
  })

  it('never falls back to a browser outside the bundle home or system package paths', () => {
    const root = tempDir()
    // A bundle home that exists but holds no browser: resolution must fail
    // instead of scanning the user's own Chrome install.
    mkdirSync(join(root, 'agent-browser', 'browsers', 'chrome-1.0.0'), { recursive: true })

    expect(() => resolveBrowserExecutable({
      env: {},
      platform: 'win32',
      validate: 'none',
      bundleHomes: [join(root, 'agent-browser')],
    })).toThrow(BrowserRuntimeMissingError)
  })

  it('reports the missing runtime with the searched paths', () => {
    const root = tempDir()
    const missing = join(root, 'nope', 'chromium')

    let error: BrowserRuntimeMissingError | null = null
    try {
      resolveBrowserExecutable({
        env: { [BROWSER_EXECUTABLE_PATH_ENV]: missing },
        platform: 'win32',
        validate: 'none',
        bundleHomes: [],
      })
    } catch (err) {
      error = err as BrowserRuntimeMissingError
    }

    expect(error).toBeInstanceOf(BrowserRuntimeMissingError)
    expect(error?.message).toContain('缺少浏览器运行时')
    expect(error?.message).toContain(missing)
    expect(error?.searchedPaths).toContain(missing)
  })

  it.skipIf(process.platform !== 'linux')(
    'only probes package-managed system paths on a linux host',
    () => {
      const resolution = resolveBrowserExecutableWithTrace({
        env: {},
        platform: 'linux',
        validate: 'none',
        bundleHomes: [],
      })

      expect(resolution.executable.source).toBe('system')
      expect(
        resolution.executable.path.startsWith('/usr/')
        || resolution.executable.path.startsWith('/snap/'),
      ).toBe(true)
    },
  )

  it('skips a candidate whose headless smoke test fails', () => {
    const root = tempDir()
    const broken = writeExecutable(join(root, 'broken-browser'))
    const probe = fakeProbe({ runSmoke: () => ({ ok: false, detail: 'exit 13' }) })

    expect(() => resolveBrowserExecutable({
      env: { [BROWSER_EXECUTABLE_PATH_ENV]: broken },
      platform: 'linux',
      probe,
      bundleHomes: [],
    })).toThrow(/headless smoke failed/)
  })

  it('accepts a candidate once version and smoke both pass, recording the version', () => {
    const root = tempDir()
    const good = writeExecutable(join(root, 'good-browser'), 'not a script but fine\n')

    const executable = resolveBrowserExecutable({
      env: { [BROWSER_EXECUTABLE_PATH_ENV]: good },
      platform: 'linux',
      probe: fakeProbe(),
      bundleHomes: [],
    })

    expect(executable.path).toBe(good)
    expect(executable.version).toBe('154.0.8037.92')
    expect(executable.launcher).toBe(false)
  })

  it('detects launcher scripts without reading the whole binary', () => {
    const root = tempDir()
    expect(isLauncherScript(writeExecutable(join(root, 'launcher')))).toBe(true)
    expect(isLauncherScript(writeExecutable(join(root, 'binary'), '\u007fELF binary\n'))).toBe(false)
    expect(isLauncherScript(join(root, 'absent'))).toBe(false)
  })

  it('parses versions out of vendor strings', () => {
    expect(parseBrowserVersion('Chromium 154.0.8037.92')).toBe('154.0.8037.92')
    expect(parseBrowserVersion('Google Chrome 149.0.7827.55')).toBe('149.0.7827.55')
    expect(parseBrowserVersion('no version here')).toBeNull()
  })
})
