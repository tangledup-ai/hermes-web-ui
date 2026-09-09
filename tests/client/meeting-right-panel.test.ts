// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
beforeEach(() => setActivePinia(createPinia()))

import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import MeetingRightPanel from '@/components/hermes/meeting/MeetingRightPanel.vue'
import { useMeetingStore } from '@/stores/hermes/meeting'
import { _resetForTesting, meetingPanels } from '@/plugins/registry'

/**
 * Right-panel shell: header + resize handle + 4-slot dispatch.
 *   speech (isSpeechScene) > agent (showAgentPanel) > realtime (showRealtimeDialog) > analysis (default)
 * Toolbar slot only renders in analysis mode (matches parent wiring).
 *
 * Tests guard:
 * - visibility gate (renders aside only when visible=true)
 * - title text per dispatch mode (t('meeting.scene.speech' | 'meeting.agentChat' | 'meeting.realtime.title' | 'meeting.analysis'))
 * - close emit
 * - resize-start emit with pointer event
 * - toolbar slot presence (analysis only)
 * - dispatch: which slot is mounted
 * - scene→plugin auto-bind (sceneTemplate matching a plugin id selects that plugin)
 */
describe('MeetingRightPanel', () => {
  const baseProps = {
    visible: true,
    isSpeechScene: false,
    showAgentPanel: false,
    resizeStyle: { width: '360px' },
  }

  beforeEach(() => {
    _resetForTesting()
  })

  afterEach(() => {
    _resetForTesting()
  })

  it('renders nothing when visible=false', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, visible: false },
    })
    expect(wrapper.find('.right-panel').exists()).toBe(false)
  })

  it('renders the panel chrome when visible=true', () => {
    const wrapper = mount(MeetingRightPanel, { props: baseProps })
    expect(wrapper.find('.right-panel').exists()).toBe(true)
    expect(wrapper.find('.right-panel-resize-handle').exists()).toBe(true)
    expect(wrapper.find('.right-panel-header').exists()).toBe(true)
    expect(wrapper.find('.panel-close-btn').exists()).toBe(true)
  })

  it('shows analysis title by default', () => {
    const wrapper = mount(MeetingRightPanel, { props: baseProps })
    expect(wrapper.find('h2').text()).toBe('meeting.analysis')
  })

  it('shows agent title when showAgentPanel=true', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, showAgentPanel: true },
    })
    expect(wrapper.find('h2').text()).toBe('meeting.agentChat')
  })

  it('shows speech title when isSpeechScene=true', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, isSpeechScene: true },
    })
    expect(wrapper.find('h2').text()).toBe('meeting.scene.speech')
  })

  it('prefers speech over agent (dispatch priority)', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: {
        ...baseProps,
        isSpeechScene: true,
        showAgentPanel: true,
      },
    })
    expect(wrapper.find('h2').text()).toBe('meeting.scene.speech')
  })

  it('emits close when the close button is clicked', async () => {
    const wrapper = mount(MeetingRightPanel, { props: baseProps })
    await wrapper.find('.panel-close-btn').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('emits resize-start with the pointer event when handle is pressed', async () => {
    const wrapper = mount(MeetingRightPanel, { props: baseProps })
    // Note: passing the PointerEvent directly trips @vue/test-utils' event
    // builder (jsdom's PointerEvent has read-only isTrusted). Trigger with
    // an empty options bag and rely on the wrapper's emitted[0][0] being
    // the synthetic PointerEvent — that's enough to prove the event payload
    // round-trips through emit().
    await wrapper.find('.right-panel-resize-handle').trigger('pointerdown')
    expect(wrapper.emitted('resize-start')).toBeTruthy()
    expect(wrapper.emitted('resize-start')).toHaveLength(1)
    const payload = wrapper.emitted('resize-start')![0][0] as Event
    expect(payload).toBeInstanceOf(PointerEvent)
    expect(payload.type).toBe('pointerdown')
  })

  it('renders toolbar slot only in analysis mode', () => {
    const analysisWrapper = mount(MeetingRightPanel, {
      props: baseProps,
      slots: { toolbar: '<button class="custom-tool">tool</button>' },
    })
    expect(analysisWrapper.find('.custom-tool').exists()).toBe(true)

    const agentWrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, showAgentPanel: true },
      slots: { toolbar: '<button class="custom-tool">tool</button>' },
    })
    expect(agentWrapper.find('.right-panel-toolbar').exists()).toBe(false)
    expect(agentWrapper.find('.custom-tool').exists()).toBe(false)

    const speechWrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, isSpeechScene: true },
      slots: { toolbar: '<button class="custom-tool">tool</button>' },
    })
    expect(speechWrapper.find('.right-panel-toolbar').exists()).toBe(false)
  })

  it('mounts analysis slot content in default mode', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: baseProps,
      slots: { analysis: '<div class="analysis-marker">analysis-body</div>' },
    })
    expect(wrapper.find('.analysis-marker').exists()).toBe(true)
    expect(wrapper.find('.analysis-marker').text()).toBe('analysis-body')
  })

  it('mounts agent slot content when showAgentPanel=true', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, showAgentPanel: true },
      slots: { agent: '<div class="agent-marker">agent-body</div>' },
    })
    expect(wrapper.find('.agent-marker').exists()).toBe(true)
    expect(wrapper.find('.analysis-marker').exists()).toBe(false)
  })

  it('mounts speech slot content when isSpeechScene=true', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, isSpeechScene: true },
      slots: { speech: '<div class="speech-marker">speech-body</div>' },
    })
    expect(wrapper.find('.speech-marker').exists()).toBe(true)
    expect(wrapper.find('.agent-marker').exists()).toBe(false)
    expect(wrapper.find('.analysis-marker').exists()).toBe(false)
  })

  it('shows realtime title and mounts realtime slot when showRealtimeDialog=true', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, showRealtimeDialog: true },
      slots: { realtime: '<div class="realtime-marker">realtime-body</div>' },
    })
    expect(wrapper.find('h2').text()).toBe('meeting.realtime.title')
    expect(wrapper.find('.realtime-marker').exists()).toBe(true)
    expect(wrapper.find('.analysis-marker').exists()).toBe(false)
  })

  it('prefers agent over realtime (dispatch priority)', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: {
        ...baseProps,
        showAgentPanel: true,
        showRealtimeDialog: true,
      },
      slots: {
        agent: '<div class="agent-marker">agent-body</div>',
        realtime: '<div class="realtime-marker">realtime-body</div>',
      },
    })
    expect(wrapper.find('h2').text()).toBe('meeting.agentChat')
    expect(wrapper.find('.agent-marker').exists()).toBe(true)
    expect(wrapper.find('.realtime-marker').exists()).toBe(false)
  })

  it('prefers realtime over analysis (dispatch priority)', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, showRealtimeDialog: true },
      slots: {
        realtime: '<div class="realtime-marker">realtime-body</div>',
        analysis: '<div class="analysis-marker">analysis-body</div>',
      },
    })
    expect(wrapper.find('h2').text()).toBe('meeting.realtime.title')
    expect(wrapper.find('.realtime-marker').exists()).toBe(true)
    expect(wrapper.find('.analysis-marker').exists()).toBe(false)
  })

  it('hides toolbar slot when realtime dialog is open', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, showRealtimeDialog: true },
      slots: { toolbar: '<button class="custom-tool">tool</button>' },
    })
    expect(wrapper.find('.right-panel-toolbar').exists()).toBe(false)
    expect(wrapper.find('.custom-tool').exists()).toBe(false)
  })

  it('renders resizeStyle on the aside element', () => {
    const wrapper = mount(MeetingRightPanel, {
      props: { ...baseProps, resizeStyle: { width: '420px' } },
    })
    const aside = wrapper.find('.right-panel')
    expect((aside.element as HTMLElement).style.width).toBe('420px')
  })

  it('auto-selects the plugin whose id matches the active session sceneTemplate', () => {
    const stub = defineComponent({ name: 'TrpgStub', render: () => h('div', { class: 'plugin-marker' }, 'plugin-body') })
    meetingPanels.push({ id: 'trpg', labelKey: 'trpg.title', component: stub as any })

    const store = useMeetingStore()
    const session = store.createSession({ title: 'TRPG run', sceneTemplate: 'trpg' })
    expect(store.activeSession?.id).toBe(session.id)

    const wrapper = mount(MeetingRightPanel, { props: baseProps })
    expect(wrapper.find('h2').text()).toBe('trpg.title')
    expect(wrapper.find('.plugin-marker').exists()).toBe(true)
    expect(wrapper.find('.analysis-marker').exists()).toBe(false)
  })

  it('does not render a manual plugin dropdown even when plugins are installed', () => {
    const stub = defineComponent({ name: 'TrpgStub', render: () => h('div', { class: 'plugin-marker' }, 'plugin-body') })
    meetingPanels.push({ id: 'trpg', labelKey: 'trpg.title', component: stub as any })

    const store = useMeetingStore()
    store.createSession({ title: 'TRPG run', sceneTemplate: 'trpg' })

    const wrapper = mount(MeetingRightPanel, { props: baseProps })
    expect(wrapper.find('select').exists()).toBe(false)
  })

  it('falls back to analysis when sceneTemplate matches no installed plugin', () => {
    const store = useMeetingStore()
    store.createSession({ title: 'general', sceneTemplate: 'general' })

    const wrapper = mount(MeetingRightPanel, {
      props: baseProps,
      slots: { analysis: '<div class="analysis-marker">analysis-body</div>' },
    })
    expect(wrapper.find('h2').text()).toBe('meeting.analysis')
    expect(wrapper.find('.analysis-marker').exists()).toBe(true)
  })
})