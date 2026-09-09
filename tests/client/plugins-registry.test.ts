// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetForTesting,
  installClientPlugins,
  listSidebarItems,
  sceneTemplateContributions,
} from '../../packages/client/src/plugins/registry'
import {
  PLUGIN_STATE_STORAGE_KEY,
  isPluginEnabled,
  readPluginEnabledMap,
  writePluginEnabledMap,
} from '../../packages/client/src/plugins/types'
import type { HermesClientPlugin, PluginRegistration } from '../../packages/client/src/plugins/types'

function makeStubPlugin(id: string, opts: Partial<HermesClientPlugin> = {}): HermesClientPlugin {
  return {
    id,
    name: id,
    version: '0.0.0',
    description: `${id} plugin`,
    install: vi.fn(),
    ...opts,
  }
}

function makeFakeRouter() {
  const added: any[] = []
  const hasRoute = vi.fn((name: string) => added.some(r => r.name === name))
  return {
    addRoute: vi.fn((route: any) => { added.push(route) }),
    hasRoute,
    routes: added,
  }
}

function makeFakeI18n() {
  const messages: Record<string, Record<string, unknown>> = {}
  return {
    global: {
      getLocaleMessage: vi.fn((locale: string) => messages[locale] || {}),
      setLocaleMessage: vi.fn((locale: string, m: Record<string, unknown>) => {
        messages[locale] = m
      }),
      _messages: messages,
    },
  }
}

beforeEach(() => {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(PLUGIN_STATE_STORAGE_KEY)
  }
  _resetForTesting()
})

afterEach(() => {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(PLUGIN_STATE_STORAGE_KEY)
  }
  _resetForTesting()
})

describe('plugin registry', () => {
  it('installs enabled-by-default plugins and exposes sidebar items', async () => {
    const plugin = makeStubPlugin('sample', {
      install: vi.fn((ctx) => {
        ctx.addSidebarItem({
          routeName: 'plugin-sample.view',
          group: 'Tools',
          labelKey: 'sample.label',
          iconPath: 'M1 1',
        })
        ctx.addRoute({ path: '/sample', name: 'plugin-sample.view', component: {} as any })
        ctx.addI18nMessages('en', { sample: { label: 'Sample' } })
      }),
    })
    const registrations: PluginRegistration[] = [{ plugin, enabledByDefault: true }]
    const result = await installClientPlugins({} as any, makeFakeRouter() as any, makeFakeI18n() as any, registrations)
    expect(result.installedIds).toEqual(['sample'])
    expect(result.sidebarItems).toHaveLength(1)
    expect(listSidebarItems()).toHaveLength(1)
    expect(plugin.install).toHaveBeenCalledTimes(1)
  })

  it('skips plugins disabled at runtime via localStorage override', async () => {
    const plugin = makeStubPlugin('sample')
    writePluginEnabledMap({ sample: false })
    expect(isPluginEnabled('sample', true)).toBe(false)
    const result = await installClientPlugins({} as any, makeFakeRouter() as any, makeFakeI18n() as any, [{ plugin, enabledByDefault: true }])
    expect(result.installedIds).toEqual([])
    expect(plugin.install).not.toHaveBeenCalled()
  })

  it('keeps disabled-by-default plugins off until the runtime override flips them on', async () => {
    const plugin = makeStubPlugin('opt-in')
    expect(isPluginEnabled('opt-in', false)).toBe(false)
    writePluginEnabledMap({ 'opt-in': true })
    expect(isPluginEnabled('opt-in', false)).toBe(true)
    const result = await installClientPlugins({} as any, makeFakeRouter() as any, makeFakeI18n() as any, [{ plugin, enabledByDefault: false }])
    expect(result.installedIds).toEqual(['opt-in'])
  })

  it('does not re-run install when invoked twice (HMR / double-mount safe)', async () => {
    const plugin = makeStubPlugin('sample')
    const ctx = { router: makeFakeRouter(), i18n: makeFakeI18n() } as any
    await installClientPlugins({} as any, ctx.router, ctx.i18n, [{ plugin, enabledByDefault: true }])
    await installClientPlugins({} as any, ctx.router, ctx.i18n, [{ plugin, enabledByDefault: true }])
    expect(plugin.install).toHaveBeenCalledTimes(1)
  })

  it('deep-merges i18n messages per locale without clobbering other plugins', async () => {
    const pluginA = makeStubPlugin('a', {
      install: vi.fn((ctx) => ctx.addI18nMessages('en', { a: { hello: 'A' } })),
    })
    const pluginB = makeStubPlugin('b', {
      install: vi.fn((ctx) => ctx.addI18nMessages('en', { b: { hello: 'B' } })),
    })
    const i18n = makeFakeI18n()
    await installClientPlugins({} as any, makeFakeRouter() as any, i18n as any, [
      { plugin: pluginA, enabledByDefault: true },
      { plugin: pluginB, enabledByDefault: true },
    ])
    expect(i18n.global._messages.en).toEqual({
      a: { hello: 'A' },
      b: { hello: 'B' },
    })
  })

  it('isolates install failures from other plugins', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken = makeStubPlugin('broken', { install: vi.fn(() => { throw new Error('boom') }) })
    const ok = makeStubPlugin('ok', { install: vi.fn() })
    const result = await installClientPlugins({} as any, makeFakeRouter() as any, makeFakeI18n() as any, [
      { plugin: broken, enabledByDefault: true },
      { plugin: ok, enabledByDefault: true },
    ])
    expect(result.installedIds).toEqual(['ok'])
    consoleSpy.mockRestore()
  })

  it('readPluginEnabledMap tolerates corrupt storage', () => {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(PLUGIN_STATE_STORAGE_KEY, 'not-json')
    expect(readPluginEnabledMap()).toEqual({})
  })

  it('addSceneTemplate registers and dedupes by id across plugins and HMR', async () => {
    const pluginA = makeStubPlugin('plugin-a', {
      install: vi.fn((ctx) => ctx.addSceneTemplate({
        id: 'trpg',
        labelKey: 'trpg.sceneLabel',
        descriptionKey: 'trpg.sceneDesc',
        iconSvg: '<polygon points="12,2 22,9 18.5,20 5.5,20 2,9"/>',
      })),
    })
    const pluginB = makeStubPlugin('plugin-b', {
      install: vi.fn((ctx) => ctx.addSceneTemplate({
        id: 'trpg',
        labelKey: 'trpg.sceneLabel',
        descriptionKey: 'trpg.sceneDesc',
        iconSvg: '<polygon points="12,2 22,9 18.5,20 5.5,20 2,9"/>',
      })),
    })
    await installClientPlugins({} as any, makeFakeRouter() as any, makeFakeI18n() as any, [
      { plugin: pluginA, enabledByDefault: true },
      { plugin: pluginB, enabledByDefault: true },
    ])
    expect(sceneTemplateContributions.map(s => s.id)).toEqual(['trpg'])
    // HMR-safe: reinstalling the same plugin does not push a duplicate
    await installClientPlugins({} as any, makeFakeRouter() as any, makeFakeI18n() as any, [
      { plugin: pluginA, enabledByDefault: true },
    ])
    expect(sceneTemplateContributions).toHaveLength(1)
  })

  it('addSceneTemplate is skipped when the plugin is disabled', async () => {
    const plugin = makeStubPlugin('plugin', {
      install: vi.fn((ctx) => ctx.addSceneTemplate({
        id: 'plugin-scene',
        labelKey: 'plugin.sceneLabel',
        descriptionKey: 'plugin.sceneDesc',
        iconSvg: '<circle cx="12" cy="12" r="10"/>',
      })),
    })
    writePluginEnabledMap({ plugin: false })
    await installClientPlugins({} as any, makeFakeRouter() as any, makeFakeI18n() as any, [
      { plugin, enabledByDefault: true },
    ])
    expect(sceneTemplateContributions).toHaveLength(0)
  })
})

it('does not install a dependent grading plugin when scanner is disabled or fails', async () => {
  const scanner = makeStubPlugin('scanner')
  const grading = makeStubPlugin('paper-grading', { dependencies: ['scanner'] })
  writePluginEnabledMap({ scanner: false, 'paper-grading': true })
  const registrations = [{ plugin: scanner, enabledByDefault: true }, { plugin: grading, enabledByDefault: false }]
  await installClientPlugins({} as any, makeFakeRouter() as any, makeFakeI18n(), registrations)
  expect(grading.install).not.toHaveBeenCalled()
  writePluginEnabledMap({ scanner: true, 'paper-grading': true })
  await installClientPlugins({} as any, makeFakeRouter() as any, makeFakeI18n(), registrations)
  expect(grading.install).toHaveBeenCalledOnce()
})
