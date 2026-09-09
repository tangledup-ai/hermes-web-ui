// @vitest-environment jsdom
import { beforeEach, describe, it, expect } from 'vitest'
import { installClientPlugins, meetingPanels, sceneTemplateContributions, _resetForTesting } from '../../packages/client/src/plugins/registry'
import plugin from '../../packages/client/src/plugins/trpg'
import { reactive } from 'vue'
import { recentTranscript, snapshotCampaign, emptyCampaign } from '../../packages/client/src/plugins/trpg/storage'
import { messages } from '../../packages/client/src/plugins/trpg/messages'
beforeEach(() => { localStorage.clear(); _resetForTesting() })
describe('TRPG plugin', () => {
  it('registers only an enabled, lazy meeting panel', async () => {
    const i18n = { global: { getLocaleMessage: () => ({}), setLocaleMessage: () => {} } }
    await installClientPlugins({} as any, {} as any, i18n, [{ plugin, enabledByDefault: false }])
    expect(meetingPanels).toHaveLength(0)
    expect(sceneTemplateContributions).toHaveLength(0)
    await installClientPlugins({} as any, {} as any, i18n, [{ plugin, enabledByDefault: true }])
    expect(meetingPanels.map(p => p.id)).toEqual(['trpg'])
    expect(sceneTemplateContributions.map(s => s.id)).toEqual(['trpg'])
    await installClientPlugins({} as any, {} as any, i18n, [{ plugin, enabledByDefault: true }])
    expect(meetingPanels).toHaveLength(1)
    expect(sceneTemplateContributions).toHaveLength(1)
  })
  it('contributes the trpg scene with i18n keys and an svg icon', async () => {
    const i18n = { global: { getLocaleMessage: () => ({}), setLocaleMessage: () => {} } }
    await installClientPlugins({} as any, {} as any, i18n, [{ plugin, enabledByDefault: true }])
    const scene = sceneTemplateContributions[0]
    expect(scene).toMatchObject({
      id: 'trpg',
      labelKey: 'trpg.sceneLabel',
      descriptionKey: 'trpg.sceneDesc',
    })
    expect(scene.iconSvg).toMatch(/<polygon/)
  })
  it('uses the recent finalized transcript within bounded context', () => {
    const text = recentTranscript(Array.from({ length: 100 }, (_, i) => ({ text: `line ${i}`, speaker: 'GM' })))
    expect(text).toContain('[GM] line 99')
    expect(text).not.toContain('line 39')
    expect(recentTranscript([{ text: 'a'.repeat(15000) }])).toHaveLength(12000)
  })
  it('serializes filtered reactive cards into plain storage records', () => {
    const value = reactive(emptyCampaign())
    value.characters.push({ id: '1', name: 'A', player: '', appearance: '', card: '' })
    value.characters = value.characters.filter(() => true)
    expect(() => structuredClone(snapshotCampaign(value))).not.toThrow()
  })
  it('provides every message for every supported locale', () => {
    expect(Object.keys(messages)).toHaveLength(11)
    for (const value of Object.values(messages)) expect(Object.keys(value).sort()).toEqual(Object.keys(messages.en).sort())
    expect(messages.en).toHaveProperty('sceneLabel')
    expect(messages.en).toHaveProperty('sceneDesc')
    expect(messages.zh).toHaveProperty('sceneLabel')
    expect(messages.zh).toHaveProperty('sceneDesc')
  })
})
