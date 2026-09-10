// @vitest-environment jsdom
import { mount, flushPromises } from '@vue/test-utils'
import { it, expect, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), list: vi.fn(), create: vi.fn(), remote: vi.fn(), push: vi.fn(), switch: vi.fn(), send: vi.fn() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (s: string) => s }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => ({ activeSessionId: 'chat', createSession: mocks.create, switchSession: mocks.switch, sendMessage: mocks.send }) }))
vi.mock('@/api/hermes/sessions', () => ({ createSessionServer: mocks.remote }))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'table' }))
vi.mock('@/api/hermes/meetings', () => ({ listRecaps: mocks.list, prepareRecap: mocks.prepare, deleteRecap: vi.fn() }))
import RecapSection from '../../packages/client/src/plugins/trpg/RecapSection.vue'
it('snapshots public character data, creates a server session, then navigates and sends the skill instruction', async () => {
  mocks.list.mockResolvedValue({ recaps: [] }); mocks.prepare.mockResolvedValue({ requestId: 'snapshot' }); mocks.create.mockReturnValue({ id: 'chat', profile: 'table' })
  const wrapper = mount(RecapSection, { props: { meetingId: 'meeting', sentences: [{ text: '举盾' }], characters: [{ id: 'elf', name: '银月', player: '小林', card: 'SECRET', appearance: '', image: new Blob() }], setting: '城门', style: '' } })
  await flushPromises()
  await wrapper.find('button.primary').trigger('click'); await flushPromises()
  expect(mocks.create).toHaveBeenCalledWith({ source: 'trpg_recap', agent: 'hermes', profile: 'table' })
  expect(mocks.push).toHaveBeenCalledWith({ name: 'hermes.session', params: { sessionId: 'chat' } })
  const text = mocks.send.mock.calls[0][0]
  expect(text).toContain('trpg-recap'); expect(text).toContain('snapshot'); expect(text).toContain('epic')
  expect(text).not.toContain('SECRET'); expect(JSON.stringify(mocks.prepare.mock.calls)).not.toContain('image')
  expect(mocks.remote.mock.invocationCallOrder[0]).toBeLessThan(mocks.push.mock.invocationCallOrder[0])
  expect(mocks.push.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[0])
  wrapper.unmount()
})
