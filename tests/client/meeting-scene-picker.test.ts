// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import SceneTemplatePicker from '@/components/hermes/meeting/SceneTemplatePicker.vue'
import { SCENE_IDS } from '@/components/hermes/meeting/scene-templates'
import { _resetForTesting, sceneTemplateContributions } from '@/plugins/registry'

/**
 * The template picker is the entry point users reach when creating a meeting:
 * pick a scene → the meeting is created with that sceneTemplate and opens in
 * the matching scene page. Guard the six pickable templates (speech restored
 * for the Toastmasters evaluation flow), the selection contract, that every
 * option still exists in the registry, and that plugins can contribute their
 * own scene cards via PluginContext.addSceneTemplate().
 */
describe('SceneTemplatePicker', () => {
  beforeEach(() => {
    _resetForTesting()
  })

  afterEach(() => {
    _resetForTesting()
  })

  function cards(wrapper: ReturnType<typeof mount>) {
    return wrapper.findAll<HTMLElement>('button[role="radio"]')
  }

  it('renders exactly the six registered scene ids, including speech', () => {
    const wrapper = mount(SceneTemplatePicker, { props: { modelValue: 'general' } })
    const buttons = cards(wrapper)
    expect(buttons).toHaveLength(SCENE_IDS.length)
    expect(buttons).toHaveLength(6)
    const texts = buttons.map(b => b.text())
    // 演讲评分（speech）卡片必须存在——它对应 SpeechEvaluationPanel + 波形浮层
    expect(texts.some(text => /meeting\.scene\.speech|speech/.test(text))).toBe(true)
  })

  it('checks the card matching modelValue and unchecks the others', () => {
    const wrapper = mount(SceneTemplatePicker, { props: { modelValue: 'business' } })
    const checked = cards(wrapper).filter(b => b.attributes('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
    expect(checked[0].text()).toContain('business')
  })

  it.each(SCENE_IDS)('emits the chosen id on click (%s)', async (id) => {
    // Start from a different selection so the target card is never pre-checked
    // (clicking an already-selected card intentionally does not re-emit).
    const initial = id === 'general' ? 'business' : 'general'
    const wrapper = mount(SceneTemplatePicker, { props: { modelValue: initial } })
    const target = cards(wrapper).find(b => b.text().includes(id))!
    await target.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toHaveLength(1)
    expect(wrapper.emitted('update:modelValue')![0]).toEqual([id])
  })

  it('does not re-emit when clicking the already-selected card', async () => {
    const wrapper = mount(SceneTemplatePicker, { props: { modelValue: 'general' } })
    await cards(wrapper)[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('appends plugin-contributed scenes after the six core ones', () => {
    sceneTemplateContributions.push({
      id: 'trpg',
      labelKey: 'trpg.sceneLabel',
      descriptionKey: 'trpg.sceneDesc',
      iconSvg: '<polygon points="12,2 22,9 18.5,20 5.5,20 2,9"/>',
    })
    const wrapper = mount(SceneTemplatePicker, { props: { modelValue: 'general' } })
    const buttons = cards(wrapper)
    expect(buttons).toHaveLength(SCENE_IDS.length + 1)
    const lastText = buttons[buttons.length - 1].text()
    expect(lastText).toContain('trpg.sceneLabel')
    expect(lastText).toContain('trpg.sceneDesc')
  })

  it('emits a plugin-contributed scene id on click', async () => {
    sceneTemplateContributions.push({
      id: 'trpg',
      labelKey: 'trpg.sceneLabel',
      descriptionKey: 'trpg.sceneDesc',
      iconSvg: '<polygon points="12,2 22,9 18.5,20 5.5,20 2,9"/>',
    })
    const wrapper = mount(SceneTemplatePicker, { props: { modelValue: 'general' } })
    const target = cards(wrapper).find(b => b.text().includes('trpg.sceneLabel'))!
    await target.trigger('click')
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['trpg'])
  })

  it('checks the card matching a plugin-contributed scene id', () => {
    sceneTemplateContributions.push({
      id: 'trpg',
      labelKey: 'trpg.sceneLabel',
      descriptionKey: 'trpg.sceneDesc',
      iconSvg: '<polygon points="12,2 22,9 18.5,20 5.5,20 2,9"/>',
    })
    const wrapper = mount(SceneTemplatePicker, { props: { modelValue: 'trpg' } })
    const checked = cards(wrapper).filter(b => b.attributes('aria-checked') === 'true')
    expect(checked).toHaveLength(1)
    expect(checked[0].text()).toContain('trpg.sceneLabel')
  })
})
