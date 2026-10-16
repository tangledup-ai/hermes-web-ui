import { describe, expect, it, vi } from 'vitest'
import {
  WebBrowserService,
  NAVIGATION_SETTLE_TIMEOUT_MS,
} from '../../packages/server/src/services/browser/web-browser-service'
import type { BrokerTabState } from '../../packages/server/src/services/browser/broker-projections'

interface Command {
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

function tab(overrides: Partial<BrokerTabState> = {}): BrokerTabState {
  return {
    id: 'tab-1',
    url: 'about:blank',
    title: 'Tab',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
    agentControl: 'idle',
    ...overrides,
  }
}

function createHarness(options: {
  initialTabs?: BrokerTabState[]
  history?: { currentIndex: number, entries: Array<{ id: number }> }
  /** Simulates a redirect: the navigation lands on this URL instead. */
  redirectTo?: string
} = {}) {
  const commands: Command[] = []
  const tabs: BrokerTabState[] = options.initialTabs ? [...options.initialTabs] : []
  let activeTabId: string | null = tabs[0]?.id ?? null
  let sequence = tabs.length
  let closed = false

  const session = {
    isDisposed: () => false,
    get activeTab() {
      return tabs.find(candidate => candidate.id === activeTabId) ?? null
    },
    listTabs: () => tabs.map(candidate => ({ ...candidate })),
    tabInfo: (tabId: string) => {
      const found = tabs.find(candidate => candidate.id === tabId)
      return found
        ? { id: found.id, url: found.url, title: found.title, cdpSessionId: `sess-${found.id}` }
        : null
    },
    getTab: (tabId: string) => {
      const found = tabs.find(candidate => candidate.id === tabId)
      return found ? { snapshot: () => ({ ...found }) } : null
    },
    findTabIdByCdpSession: () => null,
    createTab: async (url: string, activate = true) => {
      sequence += 1
      const created = tab({ id: `tab-${sequence}`, url })
      tabs.push(created)
      if (activate) activeTabId = created.id
      return { ...created }
    },
    activateTab: (tabId: string) => {
      const found = tabs.find(candidate => candidate.id === tabId)
      if (!found) return null
      activeTabId = tabId
      return { ...found }
    },
    closeTab: async (tabId: string) => {
      const index = tabs.findIndex(candidate => candidate.id === tabId)
      if (index >= 0) tabs.splice(index, 1)
    },
    syncNavigationState: async (tabId: string) => {
      const found = tabs.find(candidate => candidate.id === tabId)
      return found ? { ...found } : null
    },
    setAgentControl: (tabId: string, control: BrokerTabState['agentControl']) => {
      const found = tabs.find(candidate => candidate.id === tabId)
      if (found) found.agentControl = control
      return found ? { ...found } : null
    },
    revokeAgentControl: (tabId: string) => {
      const found = tabs.find(candidate => candidate.id === tabId)
      if (found) found.agentControl = 'idle'
    },
  }

  const client = {
    isClosed: false,
    on: () => () => undefined,
    send: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      commands.push({ method, params, sessionId })
      if (method === 'Page.getNavigationHistory') {
        return options.history ?? { currentIndex: 0, entries: [{ id: 1 }] }
      }
      if (method === 'Page.navigate') {
        const target = tabs.find(candidate => `sess-${candidate.id}` === sessionId)
        if (target) target.url = options.redirectTo ?? String(params?.url || target.url)
      }
      return {}
    },
  }

  const connection = {
    session: session as any,
    client: client as any,
    close: async () => {
      closed = true
    },
  }

  const service = new WebBrowserService({
    connect: async () => connection,
    wait: async () => undefined,
  })

  return { service, commands, tabs, connection, wasClosed: () => closed }
}

describe('web browser service', () => {
  it('reports an empty state before the browser is started', () => {
    const { service } = createHarness()

    expect(service.state()).toEqual({ activeTabId: null, maxTabs: 8, tabs: [] })
  })

  it('creates tabs through the url policy', async () => {
    const { service } = createHarness()

    const created = await service.createTab('example.com', true)

    expect(created.url).toBe('https://example.com/')
    expect(service.state().tabs).toHaveLength(1)

    await expect(service.createTab('file:///etc/passwd', true)).rejects.toThrow(/scheme-not-allowed/)
    expect(service.state().tabs).toHaveLength(1)
  })

  it('navigates through Page.navigate and re-checks the resulting url', async () => {
    const { service, commands, tabs } = createHarness()
    const created = await service.createTab('https://example.com', true)

    const navigated = await service.navigate(created.id, 'https://example.com/next')
    expect(navigated.url).toBe('https://example.com/next')
    expect(commands.filter(command => command.method === 'Page.navigate')).toHaveLength(1)

    await expect(service.navigate(created.id, 'javascript:alert(1)')).rejects.toThrow(/scheme-not-allowed/)
    void tabs

    // A redirect that lands on a blocked host stops loading and fails the call.
    const redirected = createHarness({
      initialTabs: [tab()],
      redirectTo: 'http://169.254.169.254/latest/meta-data/',
    })
    await expect(redirected.service.navigate('tab-1', 'https://example.com/redirect'))
      .rejects.toThrow(/blocked-host/)
    expect(redirected.commands.some(command => command.method === 'Page.stopLoading')).toBe(true)
  })

  it('drives back / forward / reload / stop through CDP', async () => {
    const { service, commands } = createHarness({
      initialTabs: [tab()],
      history: { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    })

    await service.navigationAction('tab-1', 'back')
    await service.navigationAction('tab-1', 'forward')
    await service.navigationAction('tab-1', 'reload')
    await service.navigationAction('tab-1', 'stop')

    const historyCalls = commands.filter(command => command.method === 'Page.navigateToHistoryEntry')
    expect(historyCalls.map(call => call.params?.entryId)).toEqual([1, 3])
    expect(commands.some(command => command.method === 'Page.reload')).toBe(true)
    expect(commands.some(command => command.method === 'Page.stopLoading')).toBe(true)
  })

  it('refuses to act on a closed tab', async () => {
    const { service } = createHarness({ initialTabs: [tab()] })

    await expect(service.navigate('missing', 'https://example.com')).rejects.toThrow('Browser tab is closed')
    await expect(service.snapshot('missing')).rejects.toThrow('Browser tab is closed')
    expect(() => service.activateTab('missing')).toThrow('Browser tab is closed')
  })

  it('tracks agent control and forgets state on cancel', async () => {
    const { service, tabs } = createHarness({ initialTabs: [tab()] })
    await service.ensureConnected()

    service.setAgentControl('tab-1', 'active')
    expect(service.state().tabs[0].agentControl).toBe('active')
    service.revokeAgentControl('tab-1')
    expect(service.state().tabs[0].agentControl).toBe('idle')

    service.cancelAgentOperation('tab-1')
    expect(tabs[0].agentControl).toBe('idle')
    expect(service.hasTab('tab-1')).toBe(true)
  })

  it('closes the runtime connection on dispose', async () => {
    const harness = createHarness({ initialTabs: [tab()] })
    await harness.service.createTab('https://example.com', true)

    await harness.service.dispose()

    expect(harness.wasClosed()).toBe(true)
    expect(harness.service.state().tabs).toEqual([])
  })

  it('waits for a loading tab before re-checking the url, within the settle budget', async () => {
    const harness = createHarness({ initialTabs: [tab({ loading: true })] })
    let waited = 0
    const service = new WebBrowserService({
      connect: async () => harness.connection,
      wait: async () => {
        waited += 1
        // The page finishes loading after the second poll.
        if (waited >= 2) harness.tabs[0].loading = false
      },
    })

    const navigated = await service.navigate('tab-1', 'https://example.com')

    expect(navigated.url).toBe('https://example.com/')
    expect(waited).toBe(2)
    expect(waited).toBeLessThan(NAVIGATION_SETTLE_TIMEOUT_MS / 50)
  })
})
