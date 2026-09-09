// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/api/client', () => ({
  request: vi.fn(),
}))

import CharacterEditor from '../../packages/client/src/plugins/trpg/CharacterEditor.vue'
import { request } from '../../packages/client/src/api/client'

describe('CharacterEditor draft button', () => {
  beforeEach(() => {
    vi.mocked(request).mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mountEditor() {
    const card = { id: 'c1', name: '', player: '', appearance: '', card: '', sheet: {} }
    return mount(CharacterEditor, {
      props: { card, disabled: false },
      global: { stubs: { SheetFields: true } },
    })
  }

  it('disables the draft button when both text and file are empty', async () => {
    const wrapper = mountEditor()
    const button = wrapper.findAll('button').find(b => b.text().includes('trpg.draft'))!
    expect(button.attributes('disabled')).toBeDefined()
  })

  it('enables the draft button after typing text', async () => {
    const wrapper = mountEditor()
    const textarea = wrapper.find('textarea[aria-label="trpg.sourceText"]')
    await textarea.setValue('银发女精灵，弓手，秩序善良')
    await nextTick()
    const button = wrapper.findAll('button').find(b => b.text().includes('trpg.draft'))!
    expect(button.attributes('disabled')).toBeUndefined()
  })

  it('fires the request with text and undefined image when only text is provided', async () => {
    vi.mocked(request).mockResolvedValueOnce({ draft: { name: '银月', player: '', appearance: '', card: '', sheet: {} } })
    const wrapper = mountEditor()
    const textarea = wrapper.find('textarea[aria-label="trpg.sourceText"]')
    await textarea.setValue('银发女精灵')
    await nextTick()
    const button = wrapper.findAll('button').find(b => b.text().includes('trpg.draft'))!
    await button.trigger('click')
    expect(request).toHaveBeenCalledTimes(1)
    const [, options] = vi.mocked(request).mock.calls[0]
    const body = JSON.parse((options as RequestInit).body as string)
    expect(body.text).toBe('银发女精灵')
    expect(body.image).toBeUndefined()
  })

  it('surfaces the draftFailed error when the request rejects', async () => {
    vi.mocked(request).mockRejectedValueOnce(new Error('network'))
    const wrapper = mountEditor()
    const textarea = wrapper.find('textarea[aria-label="trpg.sourceText"]')
    await textarea.setValue('银发女精灵')
    await nextTick()
    const button = wrapper.findAll('button').find(b => b.text().includes('trpg.draft'))!
    await button.trigger('click')
    await nextTick()
    expect(wrapper.find('[role="alert"]').text()).toContain('trpg.draftFailed')
  })

  it('shows the review section when the request resolves with a draft', async () => {
    vi.mocked(request).mockResolvedValueOnce({ draft: { name: '银月', player: '小林', appearance: '银发', card: '王族', sheet: { classLevel: '游侠 3' } } })
    const wrapper = mountEditor()
    const textarea = wrapper.find('textarea[aria-label="trpg.sourceText"]')
    await textarea.setValue('银发女精灵')
    await nextTick()
    const button = wrapper.findAll('button').find(b => b.text().includes('trpg.draft'))!
    await button.trigger('click')
    await nextTick()
    expect(wrapper.find('.draft-review').exists()).toBe(true)
    const nameArea = wrapper.find('.draft-review textarea')
    expect((nameArea.element as HTMLTextAreaElement).value).toBe('银月')
  })

  it('renders the error inline next to the draft button', async () => {
    vi.mocked(request).mockRejectedValueOnce(Object.assign(new Error('net'), { code: 'llm_not_configured' }))
    const wrapper = mountEditor()
    const textarea = wrapper.find('textarea[aria-label="trpg.sourceText"]')
    await textarea.setValue('银发女精灵')
    await nextTick()
    const button = wrapper.findAll('button').find(b => b.text().includes('trpg.draft'))!
    await button.trigger('click')
    await nextTick()
    const inlineError = wrapper.find('.ai-workshop .status-line.error')
    expect(inlineError.exists()).toBe(true)
    expect(inlineError.text()).toContain('trpg.llm_not_configured')
  })

  it('surfaces agent_unreachable when Hermes Agent bridge is down', async () => {
    vi.mocked(request).mockRejectedValueOnce(Object.assign(new Error('bridge down'), { code: 'agent_unreachable' }))
    const wrapper = mountEditor()
    const textarea = wrapper.find('textarea[aria-label="trpg.sourceText"]')
    await textarea.setValue('银发女精灵')
    await nextTick()
    const button = wrapper.findAll('button').find(b => b.text().includes('trpg.draft'))!
    await button.trigger('click')
    await nextTick()
    expect(wrapper.find('.ai-workshop .status-line.error').text()).toContain('trpg.agent_unreachable')
  })

  it('appends the server message after the i18n key when present', async () => {
    vi.mocked(request).mockRejectedValueOnce(Object.assign(new Error('API Error 502: Profile "x" does not exist'), { code: 'generation_failed' }))
    const wrapper = mountEditor()
    const textarea = wrapper.find('textarea[aria-label="trpg.sourceText"]')
    await textarea.setValue('银发女精灵')
    await nextTick()
    const button = wrapper.findAll('button').find(b => b.text().includes('trpg.draft'))!
    await button.trigger('click')
    await nextTick()
    const text = wrapper.find('.ai-workshop .status-line.error').text()
    expect(text).toContain('trpg.draftFailed')
    expect(text).toContain('Profile "x" does not exist')
  })

  it('renders a diff summary in the draft review with new / overwrite / unchanged counts', async () => {
    // Card already has strength: 12 + classLevel: '法师 1'.
    // Draft sets strength: 16 (overwrite) + classLevel: '法师 2' (overwrite) + dexterity: 14 (new).
    const card = { id: 'c1', name: '', player: '', appearance: '', card: '', sheet: { strength: '12', classLevel: '法师 1' } }
    const wrapper = mount(CharacterEditor, {
      props: { card, disabled: false },
      global: { stubs: { SheetFields: false } },
    })
    vi.mocked(request).mockResolvedValueOnce({
      draft: { name: '银月', player: '', appearance: '银发', card: '', sheet: { strength: '16', classLevel: '法师 2', dexterity: '14' } },
    })
    const textarea = wrapper.find('textarea[aria-label="trpg.sourceText"]')
    await textarea.setValue('银发女精灵')
    await nextTick()
    const button = wrapper.findAll('button').find(b => b.text().includes('trpg.draft'))!
    await button.trigger('click')
    await nextTick()
    // The diff-summary element is rendered with the i18n key. The mock t()
    // returns the key, so we can only check the element exists and binds the
    // key. Real i18n interpolation is covered by the template binding.
    expect(wrapper.find('.diff-summary').exists()).toBe(true)
    expect(wrapper.find('.diff-summary').text()).toBe('trpg.diffSummary')
    // Verify the diff prop was actually computed: SheetFields receives
    //   1 new (dexterity), 2 overwrite (strength + classLevel), 0 unchanged.
    const sheetFields = wrapper.findComponent({ name: 'SheetFields' })
    const diff = sheetFields.props('diff') as Record<string, { kind: string; from?: string }>
    expect(diff.dexterity).toEqual({ kind: 'new' })
    expect(diff.strength).toMatchObject({ kind: 'overwrite' })
    expect(diff.classLevel).toMatchObject({ kind: 'overwrite' })
  })
})