import { describe, expect, it } from 'vitest'
import {
  MAX_SNAPSHOT_NODES,
  MAX_SNAPSHOT_TEXT,
  STALE_SNAPSHOT_MESSAGE,
  SnapshotReferenceError,
  SnapshotStaleError,
  SnapshotStore,
  UNKNOWN_REFERENCE_MESSAGE,
} from '../../packages/server/src/services/browser/snapshot'

const TAB_ID = 'tab-1'

interface Command {
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

function axNode(overrides: Record<string, unknown>) {
  return {
    nodeId: String(Math.random()),
    ignored: false,
    ...overrides,
  }
}

function createStore(options: {
  nodes?: unknown[]
  tab?: { url: string, title: string, cdpSessionId: string | null } | null
} = {}) {
  const commands: Command[] = []
  const nodes = options.nodes ?? [
    axNode({ role: { value: 'RootWebArea' }, name: { value: 'Example' }, backendDOMNodeId: 1 }),
    axNode({ ignored: true, role: { value: 'generic' }, backendDOMNodeId: 2 }),
    axNode({
      role: { value: 'button' },
      name: { value: 'Submit' },
      backendDOMNodeId: 3,
      properties: [{ name: 'focused', value: { value: true } }],
    }),
    axNode({
      role: { value: 'textbox' },
      name: { value: 'Password' },
      value: { value: 'super-secret' },
      backendDOMNodeId: 4,
      properties: [{ name: 'protected', value: { value: true } }],
    }),
    axNode({ role: { value: 'generic' }, name: { value: '' }, backendDOMNodeId: 5 }),
    axNode({
      role: { value: 'textbox' },
      name: { value: 'Email' },
      value: { value: 'user@example.com' },
      backendDOMNodeId: 6,
      properties: [{ name: 'disabled', value: { value: true } }],
    }),
    axNode({
      role: { value: 'link' },
      name: { value: 'Docs' },
      description: { value: 'Opens the docs' },
      backendDOMNodeId: 7,
    }),
  ]

  const tab = options.tab === undefined
    ? { url: 'https://example.com/search?token=abc123', title: '  Example   Page  ', cdpSessionId: 'sess-1' }
    : options.tab

  let counter = 0
  const store = new SnapshotStore({
    send: async (method, params, sessionId) => {
      commands.push({ method, params, sessionId })
      if (method === 'Accessibility.getFullAXTree') return { nodes }
      return {}
    },
    getTab: id => (tab && id === TAB_ID ? { id, ...tab } : null),
    randomId: () => `snap-${++counter}`,
  })

  return { store, commands }
}

describe('browser snapshot', () => {
  it('builds refs, keeps the contract shape and drops non-interactive noise', async () => {
    const { store, commands } = createStore()

    const snapshot = await store.take(TAB_ID)

    expect(Object.keys(snapshot).sort()).toEqual(['nodes', 'snapshotId', 'tabId', 'text', 'title', 'url'])
    expect(snapshot.tabId).toBe(TAB_ID)
    expect(snapshot.snapshotId).toBe('snap-1')
    expect(commands[0]).toMatchObject({ method: 'Accessibility.enable', sessionId: 'sess-1' })
    expect(commands[1]).toMatchObject({ method: 'Accessibility.getFullAXTree', sessionId: 'sess-1' })

    expect(snapshot.nodes.map(node => node.ref)).toEqual(['@e1', '@e2', '@e3', '@e4', '@e5'])
    expect(snapshot.nodes.map(node => node.role))
      .toEqual(['RootWebArea', 'button', 'textbox', 'textbox', 'link'])
    expect(snapshot.nodes[1]).toMatchObject({ ref: '@e2', role: 'button', name: 'Submit', focused: true })
    expect(snapshot.nodes[2]).toMatchObject({ role: 'textbox', name: 'Password' })
    expect(snapshot.nodes[3]).toMatchObject({ role: 'textbox', name: 'Email', disabled: true })
    expect(snapshot.nodes[4]).toMatchObject({ description: 'Opens the docs' })
  })

  it('never exposes a protected (password) value or hidden text', async () => {
    const { store } = createStore()

    const snapshot = await store.take(TAB_ID)
    const serialized = JSON.stringify(snapshot)

    expect(serialized).not.toContain('super-secret')
    expect(snapshot.nodes.find(node => node.name === 'Password')?.value).toBeUndefined()
    expect(serialized).not.toContain('dataset')
  })

  it('sanitizes the url and title, and renders the compact text block', async () => {
    const { store } = createStore()

    const snapshot = await store.take(TAB_ID)

    expect(snapshot.url).toContain('token=%5Bredacted%5D')
    expect(snapshot.url).not.toContain('abc123')
    expect(snapshot.title).toBe('Example Page')
    expect(snapshot.text.split('\n')[0]).toBe('@e1 RootWebArea name="Example"')
    expect(snapshot.text).toContain('@e2 button name="Submit"')
  })

  it(`caps the node list at ${MAX_SNAPSHOT_NODES} and the text at ${MAX_SNAPSHOT_TEXT}`, async () => {
    const nodes = Array.from({ length: MAX_SNAPSHOT_NODES + 50 }, (_value, index) => axNode({
      role: { value: 'button' },
      name: { value: `Button ${index} ${'x'.repeat(200)}` },
      backendDOMNodeId: index + 10,
    }))
    const { store } = createStore({ nodes })

    const snapshot = await store.take(TAB_ID)

    expect(snapshot.nodes).toHaveLength(MAX_SNAPSHOT_NODES)
    expect(snapshot.text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_TEXT)
  })

  it('assigns a new snapshot id per call and invalidates the previous refs', async () => {
    const { store } = createStore()

    const first = await store.take(TAB_ID)
    const second = await store.take(TAB_ID)

    expect(first.snapshotId).not.toBe(second.snapshotId)
    expect(() => store.resolveRef(TAB_ID, first.snapshotId, '@e1')).toThrow(SnapshotStaleError)
    expect(() => store.resolveRef(TAB_ID, first.snapshotId, '@e1')).toThrow(STALE_SNAPSHOT_MESSAGE)
    expect(store.resolveRef(TAB_ID, second.snapshotId, '@e1')).toMatchObject({ backendDOMNodeId: 1 })
  })

  it('reports an unknown ref inside a live snapshot', async () => {
    const { store } = createStore()
    const snapshot = await store.take(TAB_ID)

    expect(() => store.resolveRef(TAB_ID, snapshot.snapshotId, '@e99')).toThrow(SnapshotReferenceError)
    expect(() => store.resolveRef(TAB_ID, snapshot.snapshotId, '@e99')).toThrow(UNKNOWN_REFERENCE_MESSAGE)
  })

  it('treats a missing or invalidated snapshot as stale, never as a guess', async () => {
    const { store } = createStore()
    const snapshot = await store.take(TAB_ID)
    store.invalidate(TAB_ID)

    expect(() => store.resolveRef(TAB_ID, snapshot.snapshotId, '@e1')).toThrow(STALE_SNAPSHOT_MESSAGE)
    expect(store.hasSnapshot(TAB_ID, snapshot.snapshotId)).toBe(false)

    const other = await store.take(TAB_ID)
    store.invalidate(TAB_ID)
    expect(() => store.resolveRef(TAB_ID, other.snapshotId, '@e1')).toThrow(STALE_SNAPSHOT_MESSAGE)
  })

  it('refuses to snapshot a closed tab', async () => {
    const { store } = createStore({ tab: null })

    await expect(store.take(TAB_ID)).rejects.toThrow('Browser tab is closed')
  })
})
