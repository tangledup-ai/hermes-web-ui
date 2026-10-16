import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WebBrowserBroker,
  type BrokerBrowserService,
} from '../../packages/server/src/services/browser/broker-server'
import type {
  BrokerAgentControl,
  BrokerStateInput,
  BrokerTabState,
} from '../../packages/server/src/services/browser/broker-projections'
import type {
  BrowserConsoleEntry,
  BrowserInteractAction,
  BrowserReadTextOptions,
  BrowserReadTextResult,
  BrowserScreenshot,
} from '../../packages/server/src/services/browser/automation'
import type { BrowserSnapshot } from '../../packages/server/src/services/browser/snapshot'
import { normalizeBrowserUrl } from '../../packages/server/src/services/browser/url-policy'

const root = join(__dirname, '..', '..')
const fixture = JSON.parse(
  readFileSync(join(root, 'tests', 'fixtures', 'browser-broker-contract.json'), 'utf8'),
) as {
  paths: { rpc: string, session: string }
  methods: string[]
  publicTabKeys: string[]
  publicStateKeys: string[]
  snapshotKeys: string[]
  readTextKeys: string[]
  screenshotKeys: string[]
  consoleEntryKeys: string[]
  screenshotMediaType: string
  maxTabs: number
  maxRequestBodyBytes: number
  errors: Record<string, string>
  statusCodes: Record<string, number>
  descriptor: { dirName: string, fileName: string, requiredKeys: string[] }
}

class FakeService implements BrokerBrowserService {
  readonly calls: Array<{ method: string, args: unknown[] }> = []
  readonly tabs: BrokerTabState[] = []
  readonly controls = new Map<string, BrokerAgentControl>()
  readonly failures = new Map<string, Error>()
  activeTabId: string | null = null
  navigationGate: Promise<void> | null = null
  private sequence = 0
  activeOperations = 0
  maxConcurrentOperations = 0

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }

  private failIfConfigured(method: string): void {
    const failure = this.failures.get(method)
    if (failure) throw failure
  }

  state(): BrokerStateInput {
    return { activeTabId: this.activeTabId, maxTabs: fixture.maxTabs, tabs: this.tabs.map(tab => ({ ...tab })) }
  }

  hasTab(tabId: string): boolean {
    return this.tabs.some(tab => tab.id === tabId)
  }

  private mutate(tabId: string): BrokerTabState {
    const tab = this.tabs.find(candidate => candidate.id === tabId)
    if (!tab) throw new Error('Browser tab is closed')
    return tab
  }

  async createTab(url: string, activate: boolean): Promise<BrokerTabState> {
    // The real service applies the URL policy; the fake does too so the broker
    // test exercises the same end-to-end contract.
    const target = normalizeBrowserUrl(url || 'about:blank')
    this.record('createTab', target, activate)
    this.failIfConfigured('tabs.create')
    if (this.tabs.length >= fixture.maxTabs) {
      throw new Error(`Browser supports at most ${fixture.maxTabs} tabs per profile`)
    }
    this.sequence += 1
    const tab: BrokerTabState = {
      id: `tab-${this.sequence}`,
      url: target,
      title: `Title ${this.sequence}`,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      agentControl: 'idle',
    }
    this.tabs.push(tab)
    if (activate || !this.activeTabId) this.activeTabId = tab.id
    return { ...tab }
  }

  activateTab(tabId: string): void {
    this.record('activateTab', tabId)
    this.activeTabId = this.mutate(tabId).id
  }

  async closeTab(tabId: string): Promise<void> {
    this.record('closeTab', tabId)
    const index = this.tabs.findIndex(tab => tab.id === tabId)
    if (index >= 0) this.tabs.splice(index, 1)
    if (this.activeTabId === tabId) this.activeTabId = this.tabs[0]?.id ?? null
  }

  async navigate(tabId: string, url: string): Promise<BrokerTabState> {
    const target = normalizeBrowserUrl(url)
    this.record('navigate', tabId, target)
    this.failIfConfigured('navigate')
    if (this.navigationGate) await this.navigationGate
    const tab = this.mutate(tabId)
    tab.url = target
    return { ...tab }
  }

  async navigationAction(tabId: string, action: string): Promise<BrokerTabState> {
    this.record('navigationAction', tabId, action)
    return { ...this.mutate(tabId) }
  }

  async snapshot(tabId: string): Promise<BrowserSnapshot> {
    this.record('snapshot', tabId)
    this.failIfConfigured('snapshot')
    const tab = this.mutate(tabId)
    return {
      tabId,
      snapshotId: 'snapshot-1',
      url: tab.url,
      title: tab.title,
      nodes: [{ ref: '@e1', role: 'button', name: 'Go' }],
      text: '@e1 button name="Go"',
    }
  }

  async readText(
    tabId: string,
    options: BrowserReadTextOptions & { snapshotId: string, ref: string },
  ): Promise<BrowserReadTextResult> {
    this.record('readText', tabId, options)
    return {
      tabId,
      snapshotId: options.snapshotId,
      ref: options.ref,
      mode: options.mode ?? 'innerText',
      offset: options.offset ?? 0,
      limit: options.limit ?? 4_000,
      text: 'body text',
      totalLength: 9,
      returnedLength: 9,
      hasMore: false,
    }
  }

  async interact(tabId: string, action: BrowserInteractAction): Promise<BrokerTabState> {
    this.record('interact', tabId, action)
    this.failIfConfigured('interact')
    return { ...this.mutate(tabId) }
  }

  async screenshot(tabId: string, fullPage: boolean): Promise<BrowserScreenshot> {
    this.record('screenshot', tabId, fullPage)
    const tab = this.mutate(tabId)
    return {
      tabId,
      url: tab.url,
      title: tab.title,
      mediaType: 'image/png',
      data: Buffer.from('png').toString('base64'),
      width: 800,
      height: 600,
    }
  }

  consoleEntries(tabId: string): BrowserConsoleEntry[] {
    this.record('consoleEntries', tabId)
    return [{
      level: 2,
      message: 'x'.repeat(2_500),
      sourceId: 'https://example.com/app.js?token=abc123',
      line: 3,
      timestamp: '2026-10-16T00:00:00.000Z',
    }]
  }

  clearConsole(tabId: string): void {
    this.record('clearConsole', tabId)
  }

  setAgentControl(tabId: string, control: BrokerAgentControl): void {
    this.record('setAgentControl', tabId, control)
    this.controls.set(tabId, control)
    const tab = this.tabs.find(candidate => candidate.id === tabId)
    if (tab) tab.agentControl = control
  }

  revokeAgentControl(tabId: string): void {
    this.record('revokeAgentControl', tabId)
    this.controls.set(tabId, 'idle')
    const tab = this.tabs.find(candidate => candidate.id === tabId)
    if (tab) tab.agentControl = 'idle'
  }

  cancelAgentOperation(tabId: string): void {
    this.record('cancelAgentOperation', tabId)
  }

  enterOperation(): void {
    this.activeOperations += 1
    this.maxConcurrentOperations = Math.max(this.maxConcurrentOperations, this.activeOperations)
  }

  exitOperation(): void {
    this.activeOperations -= 1
  }
}

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'broker-home-'))
  tempDirs.push(dir)
  return dir
}

interface Harness {
  broker: WebBrowserBroker
  service: FakeService
  home: string
  endpoint: string
  token: string
  descriptorPath: string
}

async function startBroker(service = new FakeService()): Promise<Harness> {
  const home = tempHome()
  const broker = new WebBrowserBroker({ service, webUiHome: home, warn: vi.fn() })
  const descriptor = await broker.start()
  return {
    broker,
    service,
    home,
    endpoint: descriptor.endpoint,
    token: descriptor.token,
    descriptorPath: join(home, fixture.descriptor.dirName, fixture.descriptor.fileName),
  }
}

async function register(harness: Harness, clientPid = process.pid) {
  const response = await fetch(new URL(fixture.paths.session, harness.endpoint), {
    method: 'POST',
    headers: { Authorization: `Bearer ${harness.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: 'hermes-studio-mcp', client_pid: clientPid }),
  })
  const payload = await response.json()
  return {
    status: response.status,
    payload: payload as { client_id?: string, session_token?: string, error?: string },
  }
}

async function rpc(
  harness: Harness,
  session: { clientId: string, token: string },
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await fetch(harness.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
      'X-Hermes-Browser-Client': session.clientId,
    },
    body: JSON.stringify({ method, params, operation_id: 'op-1' }),
  })
  const payload = await response.json()
  return { status: response.status, payload: payload as any }
}

async function session(h: Harness) {
  const registration = await register(h)
  return { clientId: registration.payload.client_id as string, token: registration.payload.session_token as string }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe('web browser broker HTTP surface', () => {
  it('binds loopback, exposes /v1 and writes the shared descriptor', async () => {
    const harness = await startBroker()
    try {
      expect(harness.endpoint.startsWith('http://127.0.0.1:')).toBe(true)
      expect(new URL(harness.endpoint).pathname).toBe(fixture.paths.rpc)
      expect(existsSync(harness.descriptorPath)).toBe(true)

      const descriptor = JSON.parse(readFileSync(harness.descriptorPath, 'utf8'))
      for (const key of fixture.descriptor.requiredKeys) {
        expect(descriptor, `descriptor is missing ${key}`).toHaveProperty(key)
      }
      expect(descriptor.schema).toBe(fixture.descriptor.schema)
      expect(descriptor.desktopPid).toBe(process.pid)
    } finally {
      await harness.broker.stop()
    }
    expect(existsSync(harness.descriptorPath)).toBe(false)
  })

  it('answers 404 for anything but POST /v1 and /v1/session', async () => {
    const harness = await startBroker()
    try {
      const getResponse = await fetch(harness.endpoint)
      expect(getResponse.status).toBe(fixture.statusCodes.notFound)
      expect(await getResponse.json()).toEqual({ error: fixture.errors.notFound })

      const otherPath = await fetch(new URL('/v1/other', harness.endpoint), { method: 'POST' })
      expect(otherPath.status).toBe(fixture.statusCodes.notFound)
    } finally {
      await harness.broker.stop()
    }
  })

  it('rejects browser origins and sets the JSON no-store headers', async () => {
    const harness = await startBroker()
    try {
      const response = await fetch(harness.endpoint, {
        method: 'POST',
        headers: { Origin: 'https://evil.example' },
      })
      expect(response.status).toBe(fixture.statusCodes.originRejected)
      expect(await response.json()).toEqual({ error: fixture.errors.originRejected })
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(response.headers.get('cache-control')).toBe('no-store')
    } finally {
      await harness.broker.stop()
    }
  })

  it('requires the descriptor token for a session and the session headers for RPC', async () => {
    const harness = await startBroker()
    try {
      const badSession = await fetch(new URL(fixture.paths.session, harness.endpoint), {
        method: 'POST',
        headers: { Authorization: 'Bearer nope' },
        body: '{}',
      })
      expect(badSession.status).toBe(fixture.statusCodes.unauthorized)
      expect(await badSession.json()).toEqual({ error: fixture.errors.unauthorized })

      const noSessionHeader = await fetch(harness.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${harness.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'state' }),
      })
      expect(noSessionHeader.status).toBe(fixture.statusCodes.unauthorized)

      const wrongClient = await fetch(harness.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${harness.token}`,
          'Content-Type': 'application/json',
          'X-Hermes-Browser-Client': 'unknown-client',
        },
        body: JSON.stringify({ method: 'state' }),
      })
      expect(wrongClient.status).toBe(fixture.statusCodes.unauthorized)
    } finally {
      await harness.broker.stop()
    }
  })

  it('registers clients with a session token', async () => {
    const harness = await startBroker()
    try {
      const registration = await register(harness)
      expect(registration.status).toBe(fixture.statusCodes.ok)
      expect(registration.payload.client_id).toMatch(/^[0-9a-f-]{36}$/)
      expect(registration.payload.session_token).toMatch(/^[A-Za-z0-9_-]{20,}$/)

      const badPid = await register(harness, -5)
      expect(badPid.status).toBe(fixture.statusCodes.businessError)
      expect(badPid.payload.error).toBe(fixture.errors.clientPid)
    } finally {
      await harness.broker.stop()
    }
  })

  it('enforces the 1 MB body limit and object requirement', async () => {
    const harness = await startBroker()
    const client = await session(harness)
    try {
      const tooLarge = await fetch(harness.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${client.token}`,
          'Content-Type': 'application/json',
          'X-Hermes-Browser-Client': client.clientId,
        },
        body: JSON.stringify({ method: 'state', params: { padding: 'x'.repeat(fixture.maxRequestBodyBytes) } }),
      })
      expect(tooLarge.status).toBe(fixture.statusCodes.businessError)
      expect((await tooLarge.json()).error).toBe(fixture.errors.bodyTooLarge)

      const notAnObject = await fetch(harness.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${client.token}`,
          'Content-Type': 'application/json',
          'X-Hermes-Browser-Client': client.clientId,
        },
        body: '"just a string"',
      })
      expect(notAnObject.status).toBe(fixture.statusCodes.businessError)
      expect((await notAnObject.json()).error).toBe(fixture.errors.bodyNotObject)
    } finally {
      await harness.broker.stop()
    }
  })
})

describe('web browser broker methods', () => {
  it('implements every fixture method and rejects unknown ones', async () => {
    const harness = await startBroker()
    const client = await session(harness)
    try {
      const created = await rpc(harness, client, 'tabs.create', { url: 'https://example.com' })
      expect(created.status).toBe(fixture.statusCodes.ok)
      expect(created.payload.operation_id).toBe('op-1')
      const tabId = created.payload.result.id as string

      const calls: Array<[string, Record<string, unknown>]> = [
        ['state', {}],
        ['tabs.list', {}],
        ['tabs.activate', { tab_id: tabId }],
        ['navigate', { tab_id: tabId, url: 'https://example.com/next' }],
        ['navigation.action', { tab_id: tabId, action: 'reload' }],
        ['snapshot', { tab_id: tabId }],
        ['text.read', { tab_id: tabId, snapshot_id: 'snapshot-1', ref: '@e1' }],
        ['interact', { tab_id: tabId, action: { action: 'scroll', direction: 'down' } }],
        ['screenshot', { tab_id: tabId }],
        ['console.read', { tab_id: tabId }],
        ['console.clear', { tab_id: tabId }],
        ['lease.release', { tab_id: tabId }],
      ]

      for (const [method, params] of calls) {
        const response = await rpc(harness, client, method, params)
        expect(response.status, `${method} failed: ${JSON.stringify(response.payload)}`)
          .toBe(fixture.statusCodes.ok)
      }

      const unknown = await rpc(harness, client, 'tabs.something')
      expect(unknown.status).toBe(fixture.statusCodes.businessError)
      expect(unknown.payload.error).toBe(`${fixture.errors.unknownMethodPrefix}tabs.something`)

      expect(fixture.methods).toContain('lease.release')
    } finally {
      await harness.broker.stop()
    }
  })

  it('projects tabs without leaking internal fields', async () => {
    const harness = await startBroker()
    const client = await session(harness)
    try {
      harness.service.tabs.push({
        id: 'tab-1',
        url: 'https://example.com/cb?token=secret-value',
        title: 'x'.repeat(900),
        loading: true,
        canGoBack: true,
        canGoForward: false,
        crashed: false,
        agentControl: 'idle',
      })

      const response = await rpc(harness, client, 'state')

      expect(Object.keys(response.payload.result).sort()).toEqual([...fixture.publicStateKeys].sort())
      const tab = response.payload.result.tabs[0]
      expect(Object.keys(tab).sort()).toEqual([...fixture.publicTabKeys].sort())
      expect(tab.url).toBe('https://example.com/cb?token=%5Bredacted%5D')
      expect(tab.title).toHaveLength(500)
      expect(tab.agentControl).toBe('idle')
      for (const forbidden of ['faviconUrl', 'profileId', 'agentLabel', 'agentAction', 'sessionPath', 'downloadPath']) {
        expect(tab).not.toHaveProperty(forbidden)
      }
    } finally {
      await harness.broker.stop()
    }
  })

  it('keeps the snapshot, text, screenshot and console shapes from the fixture', async () => {
    const harness = await startBroker()
    const client = await session(harness)
    try {
      const created = await rpc(harness, client, 'tabs.create', { url: 'https://example.com' })
      const tabId = created.payload.result.id as string

      const snapshot = await rpc(harness, client, 'snapshot', { tab_id: tabId })
      expect(Object.keys(snapshot.payload.result).sort()).toEqual([...fixture.snapshotKeys].sort())
      expect(snapshot.payload.result.snapshotId).toBe('snapshot-1')
      expect(snapshot.payload.result).not.toHaveProperty('snapshot_id')

      const text = await rpc(harness, client, 'text.read', {
        tab_id: tabId,
        snapshot_id: 'snapshot-1',
        ref: '@e1',
      })
      for (const key of fixture.readTextKeys) {
        expect(text.payload.result).toHaveProperty(key)
      }
      const forwarded = harness.service.calls.filter(call => call.method === 'readText').pop()
      expect(forwarded?.args[1]).toMatchObject({
        snapshotId: 'snapshot-1',
        ref: '@e1',
        mode: 'innerText',
        offset: 0,
        limit: 4_000,
      })

      const badMode = await rpc(harness, client, 'text.read', {
        tab_id: tabId,
        snapshot_id: 'snapshot-1',
        ref: '@e1',
        mode: 'outerHTML',
      })
      expect(badMode.status).toBe(fixture.statusCodes.businessError)
      expect(badMode.payload.error).toBe('mode must be innerText or textContent')

      const screenshot = await rpc(harness, client, 'screenshot', { tab_id: tabId, full_page: true })
      expect(Object.keys(screenshot.payload.result).sort()).toEqual([...fixture.screenshotKeys].sort())
      expect(screenshot.payload.result.mediaType).toBe(fixture.screenshotMediaType)
      expect(harness.service.calls.filter(call => call.method === 'screenshot').pop()?.args[1]).toBe(true)

      const consoleRead = await rpc(harness, client, 'console.read', { tab_id: tabId })
      const entry = consoleRead.payload.result[0]
      expect(Object.keys(entry).sort()).toEqual([...fixture.consoleEntryKeys].sort())
      expect(entry.message).toHaveLength(2_000)
      expect(entry.sourceId).toContain('token=%5Bredacted%5D')

      const cleared = await rpc(harness, client, 'console.clear', { tab_id: tabId })
      expect(cleared.payload.result).toEqual({ ok: true })
    } finally {
      await harness.broker.stop()
    }
  })

  it('validates navigation input and rejects unsafe urls', async () => {
    const harness = await startBroker()
    const client = await session(harness)
    try {
      const created = await rpc(harness, client, 'tabs.create', { url: 'https://example.com' })
      const tabId = created.payload.result.id as string

      const unsafe = await rpc(harness, client, 'navigate', { tab_id: tabId, url: 'file:///etc/passwd' })
      expect(unsafe.status).toBe(fixture.statusCodes.businessError)
      expect(unsafe.payload.error).toContain('scheme-not-allowed')

      const localhost = await rpc(harness, client, 'navigate', { tab_id: tabId, url: 'http://127.0.0.1:6060/' })
      expect(localhost.status).toBe(fixture.statusCodes.businessError)
      expect(localhost.payload.error).toContain('blocked-host')

      const badAction = await rpc(harness, client, 'navigation.action', { tab_id: tabId, action: 'spin' })
      expect(badAction.payload.error).toBe('Invalid browser navigation action')

      const missingTab = await rpc(harness, client, 'snapshot', {})
      expect(missingTab.payload.error).toBe('tab_id is required')
    } finally {
      await harness.broker.stop()
    }
  })

  it('maps business errors to 400 and lease/control/cancel errors to 409', async () => {
    const harness = await startBroker()
    const client = await session(harness)
    try {
      const created = await rpc(harness, client, 'tabs.create', { url: 'https://example.com' })
      const tabId = created.payload.result.id as string

      harness.service.failures.set('tabs.create', new Error('Browser supports at most 8 tabs per profile'))
      const capped = await rpc(harness, client, 'tabs.create', { url: 'about:blank' })
      expect(capped.status).toBe(fixture.statusCodes.businessError)

      harness.service.failures.set('snapshot', new Error(fixture.errors.staleSnapshot))
      const stale = await rpc(harness, client, 'snapshot', { tab_id: tabId })
      expect(stale.status).toBe(fixture.statusCodes.businessError)
      expect(stale.payload.error).toBe(fixture.errors.staleSnapshot)

      harness.service.failures.set('interact', new Error('control channel unavailable'))
      const control = await rpc(harness, client, 'interact', {
        tab_id: tabId,
        action: { action: 'press', key: 'Enter' },
      })
      expect(control.status).toBe(fixture.statusCodes.leaseOrCancelled)
    } finally {
      await harness.broker.stop()
    }
  })

  it('enforces one mutating client per tab through leases', async () => {
    const harness = await startBroker()
    const first = await session(harness)
    const second = await session(harness)
    try {
      const created = await rpc(harness, first, 'tabs.create', { url: 'https://example.com' })
      const tabId = created.payload.result.id as string

      const claimed = await rpc(harness, first, 'navigate', { tab_id: tabId, url: 'https://example.com/a' })
      expect(claimed.status).toBe(fixture.statusCodes.ok)
      expect(harness.service.controls.get(tabId)).toBe('active')

      const conflict = await rpc(harness, second, 'navigate', { tab_id: tabId, url: 'https://example.com/b' })
      expect(conflict.status).toBe(fixture.statusCodes.leaseOrCancelled)
      expect(conflict.payload.error)
        .toBe(`${fixture.errors.leaseConflictPrefix}navigate`)

      const foreignRelease = await rpc(harness, second, 'lease.release', { tab_id: tabId })
      expect(foreignRelease.status).toBe(fixture.statusCodes.leaseOrCancelled)
      expect(foreignRelease.payload.error).toBe(fixture.errors.leaseOwnership)

      const reads = await rpc(harness, second, 'console.read', { tab_id: tabId })
      expect(reads.status).toBe(fixture.statusCodes.ok)

      const released = await rpc(harness, first, 'lease.release', { tab_id: tabId })
      expect(released.payload.result).toEqual({ ok: true })
      expect(harness.service.controls.get(tabId)).toBe('idle')

      const afterRelease = await rpc(harness, second, 'navigate', { tab_id: tabId, url: 'https://example.com/c' })
      expect(afterRelease.status).toBe(fixture.statusCodes.ok)
    } finally {
      await harness.broker.stop()
    }
  })

  it('aborts an in-flight operation after a user takeover', async () => {
    const harness = await startBroker()
    const client = await session(harness)
    try {
      const created = await rpc(harness, client, 'tabs.create', { url: 'https://example.com' })
      const tabId = created.payload.result.id as string

      let release!: () => void
      harness.service.navigationGate = new Promise<void>(resolve => {
        release = resolve
      })

      const inFlight = rpc(harness, client, 'navigate', { tab_id: tabId, url: 'https://example.com/slow' })
      await new Promise(resolve => setTimeout(resolve, 20))
      harness.broker.revokeTab(tabId)
      release()

      const response = await inFlight
      expect(response.status).toBe(fixture.statusCodes.leaseOrCancelled)
      expect(response.payload.error).toBe(fixture.errors.takeoverCancelled)
      expect(harness.service.calls.some(call => call.method === 'cancelAgentOperation')).toBe(true)
    } finally {
      await harness.broker.stop()
    }
  })

  it('runs at most 4 operations concurrently', async () => {
    const harness = await startBroker()
    const client = await session(harness)
    try {
      const originalCreate = harness.service.createTab.bind(harness.service)
      harness.service.createTab = async (url: string, activate: boolean) => {
        harness.service.enterOperation()
        try {
          await new Promise(resolve => setTimeout(resolve, 25))
          return await originalCreate(url, activate)
        } finally {
          harness.service.exitOperation()
        }
      }

      // `tabs.create` carries no tab_id, so it goes through the global capacity gate.
      const responses = await Promise.all(Array.from({ length: 8 }, (_value, index) => (
        rpc(harness, client, 'tabs.create', { url: `https://example.com/${index}` })
      )))

      expect(responses.filter(response => response.status === fixture.statusCodes.ok)).toHaveLength(8)
      expect(harness.service.maxConcurrentOperations).toBe(4)
      expect(harness.service.tabs).toHaveLength(8)
    } finally {
      await harness.broker.stop()
    }
  })
})
