import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../../packages/ekko-agent/src'
import { streamConfiguredMeetingModel, type MeetingModelRequest } from '../../packages/server/src/modules/studio/public/meeting-runtime'
import { analyzeMeetingBatch, generateMeetingTitle } from '../../packages/server/src/modules/studio/services/meeting-asr/direct-llm'
import { realtimeAssistService } from '../../packages/server/src/modules/studio/services/meeting-asr/realtime-assist'
import { getSceneTemplateOrDefault } from '../../packages/server/src/modules/studio/services/meeting-asr/scene-templates'
import '../../packages/server/src/bootstrap/meeting-runtime-adapter'

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  provider: vi.fn(),
  fetch: vi.fn(),
  isolated: vi.fn(),
  bridge: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/hermes/controllers/models', () => ({ getAvailableModelConfigForProfile: mocks.catalog }))
vi.mock('../../packages/server/src/modules/ekko/services/provider-runtime', () => ({
  resolveEkkoProviderRuntimeConfig: mocks.provider,
  createEkkoAuthorizedProviderFetch: () => mocks.fetch,
}))
vi.mock('../../packages/server/src/modules/ekko/services/manager', () => ({
  getGlobalEkkoAgent: () => ({ runIsolated: mocks.isolated }),
}))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({ createPrimaryAgentBridge: mocks.bridge }))
vi.mock('../../packages/server/src/modules/studio/services/meeting-asr/skill-resolver', () => ({
  prepareAnalysisSkillSection: async () => 'Meeting profile skill instructions',
}))

const groups = [
  { provider: 'custom:fixture', models: ['fixture-model', 'other-model'], api_mode: 'chat_completions' },
  { provider: 'anthropic', models: ['claude-fixture'], api_mode_by_model: { 'claude-fixture': 'anthropic_messages' } },
]
const profile = 'team'
const transcript = 'The team approved the design.'

function setup() {
  mocks.catalog.mockResolvedValue({ default: 'fixture-model', default_provider: 'custom:fixture', groups })
  mocks.provider.mockImplementation(async ({ provider, apiMode }) => ({
    provider, apiMode, baseUrl: 'https://example.test/v1', apiKey: 'fixture-key',
  }))
  mocks.isolated.mockImplementation((options: ConstructorParameters<typeof AgentRuntime>[0], input: Parameters<AgentRuntime['run']>[0]) =>
    new AgentRuntime(options).run(input))
}

function sse(...frames: unknown[]): Response {
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}`).join('\n\n'), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

afterEach(() => vi.resetAllMocks())

describe('meeting Ekko runtime', () => {
  it('streams report deltas through an isolated run using the profile default', async () => {
    setup()
    mocks.fetch.mockResolvedValue(sse(
      { choices: [{ delta: { content: '# Report\n' } }] },
      { choices: [{ message: { content: 'Design approved.' }, finish_reason: 'stop' }] },
    ))

    const report = realtimeAssistService.generateReportStream('one', transcript, 'general', { profile })
    expect((await report.next()).value).toBe('# Report\n')
    expect((await report.next()).value).toBe('Design approved.')
    expect((await report.next()).done).toBe(true)
    expect(mocks.bridge).not.toHaveBeenCalled()
    expect(mocks.catalog).toHaveBeenCalledWith(profile)
    expect(mocks.isolated).toHaveBeenCalledWith(
      expect.objectContaining({ toolsEnabled: false, skillsEnabled: false, maxSteps: 1 }),
      expect.objectContaining({ memoryEnabled: false, ephemeralContext: true }),
    )
    const [url, init] = mocks.fetch.mock.calls[0]
    expect(url).toBe('https://example.test/v1/chat/completions')
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'fixture-model',
      messages: [expect.objectContaining({ role: 'system', content: expect.stringContaining('Meeting profile skill instructions') }),
        { role: 'user', content: expect.stringContaining(transcript) }],
    })
    expect(JSON.parse(init.body).messages[0].content).toContain('## 待办事项')
    expect(JSON.parse(init.body).messages[0].content).toContain('[00:27](#meeting-source-9)')
    expect(JSON.parse(init.body).tools).toBeUndefined()
  })

  it('shares the selected model with live analysis and title generation', async () => {
    setup()
    mocks.fetch
      .mockResolvedValueOnce(sse({ choices: [{ delta: { content: '{"keyPoint":"Design approved","analysis":"Document the decision","priority":"normal"}' } }] }))
      .mockResolvedValueOnce(sse({ choices: [{ delta: { content: '「Design approval」' } }] }))
    const target = { profile, provider: 'custom:fixture', model: 'other-model' }

    const result = await analyzeMeetingBatch(transcript, getSceneTemplateOrDefault('general'), target)
    expect(result).toMatchObject({ keyPoint: 'Design approved', analysis: 'Document the decision' })
    await expect(generateMeetingTitle(transcript, target)).resolves.toBe('Design approval')
    expect(mocks.provider).toHaveBeenCalledTimes(2)
    expect(mocks.provider).toHaveBeenLastCalledWith({ ...target, apiMode: 'chat_completions' })
    expect(mocks.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).model)).toEqual(['other-model', 'other-model'])
  })

  it('uses the selected model protocol and rejects an unavailable override', async () => {
    setup()
    mocks.fetch.mockResolvedValue(new Response([
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Anthropic report"}}',
      'data: {"type":"message_stop"}',
    ].join('\n\n') + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } }))
    const request: MeetingModelRequest = {
      profile, provider: 'anthropic', model: 'claude-fixture', purpose: 'meeting-report',
      systemPrompt: 'Write a report', userPrompt: transcript, maxTokens: 4000, temperature: 0.4,
    }

    const stream = (await streamConfiguredMeetingModel(request))!
    const output: string[] = []
    for await (const chunk of stream) output.push(chunk)
    expect(output.join('')).toBe('Anthropic report')
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://example.test/v1/messages')
    await expect(streamConfiguredMeetingModel({ ...request, model: 'unavailable' })).rejects.toThrow(/unavailable/)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects a partial report when the provider sends an in-band failure', async () => {
    setup()
    let sendFailure!: () => void
    const failureReady = new Promise<void>(resolve => { sendFailure = resolve })
    const encoder = new TextEncoder()
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Partial report"}}]}\n\n'))
        await failureReady
        controller.enqueue(encoder.encode('data: {"error":{"message":"Provider request failed"}}'))
        controller.close()
      },
    })))
    const report = realtimeAssistService.generateReportStream('one', transcript, 'general', { profile })
    expect((await report.next()).value).toBe('Partial report')
    sendFailure()
    await expect(report.next()).rejects.toThrow('Provider request failed')
  })

  it('rejects max_steps when the provider returns an unsolicited tool call', async () => {
    setup()
    mocks.fetch.mockResolvedValue(sse({
      choices: [{ finish_reason: 'tool_calls', delta: { tool_calls: [
        { index: 0, id: 'unexpected', function: { name: 'terminal', arguments: '{}' } },
      ] } }],
    }))
    const report = realtimeAssistService.generateReportStream('one', transcript, 'general', { profile })
    await expect(report.next()).rejects.toThrow('Meeting model did not return a complete text response')
  })
})
