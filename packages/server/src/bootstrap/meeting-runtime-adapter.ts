import { PassThrough } from 'node:stream'
import { createModelClient, resolveModelProviderConfigs, type ModelClient } from '../../../ekko-agent/src'
import { getGlobalEkkoAgent } from '../modules/ekko/services/manager'
import { createEkkoAuthorizedProviderFetch, resolveEkkoProviderRuntimeConfig } from '../modules/ekko/services/provider-runtime'
import { getAvailableModelConfigForProfile } from '../modules/hermes/controllers/models'
import { HermesSkillInjector } from '../modules/hermes/services/skills/injector'
import { resolveProviderCatalogApiMode } from '../modules/studio/contracts/providers'
import { configureMeetingRuntime, type MeetingModelRequest } from '../modules/studio/public/meeting-runtime'

type ModelGroup = Awaited<ReturnType<typeof getAvailableModelConfigForProfile>>['groups'][number]

function modelApiMode(group: ModelGroup, model: string) {
  return group.api_mode_by_model?.[model] || group.api_mode || resolveProviderCatalogApiMode(group.provider, model)
}

function supportsMeetingModel(group: ModelGroup, model: string): boolean {
  return group.provider !== 'moa' && !group.model_meta?.[model]?.disabled &&
    !['bedrock_converse', 'codex_app_server'].includes(modelApiMode(group, model) || '')
}

async function* streamEkkoMeetingRun(input: MeetingModelRequest, modelClient: ModelClient, model: string): AsyncGenerator<string> {
  const controller = new AbortController()
  const timeout = AbortSignal.timeout(input.purpose === 'meeting-report' ? 180_000 : 30_000)
  const signal = AbortSignal.any([controller.signal, timeout, ...(input.signal ? [input.signal] : [])])
  signal.throwIfAborted()
  const chunks = new PassThrough({ objectMode: true })
  let streamedLength = 0
  const agent = getGlobalEkkoAgent(input.profile)
  const run = agent.runIsolated({
    modelClient,
    systemPrompt: input.systemPrompt,
    toolsEnabled: false,
    skillsEnabled: false,
    backgroundDelegationEnabled: false,
    recoveryDirective: () => ({ active: false, automaticToolCalls: [], allowedToolNames: [], reminder: '' }),
    maxSteps: 1,
    maxModelRetries: 0,
  }, {
    messages: [{ role: 'user', content: input.userPrompt }],
    model,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    metadata: { purpose: input.purpose },
    toolExecutionGuidelinesEnabled: false,
    memoryEnabled: false,
    skillReviewEnabled: false,
    ephemeralContext: true,
    signal,
    onEvent(event) {
      if (event.type === 'model.delta') {
        streamedLength += event.text.length
        chunks.write(event.text)
      }
    },
  }).then(result => {
    signal.throwIfAborted()
    const output = result.output
    if (!output.content.trim() || output.toolCalls?.length || output.finishReason === 'max_steps') {
      throw new Error('Meeting model did not return a complete text response')
    }
    const remainder = output.content.slice(streamedLength)
    if (remainder) chunks.write(remainder)
    chunks.end()
  }).catch(error => {
    chunks.destroy(error instanceof Error ? error : new Error(String(error)))
  })
  try {
    for await (const chunk of chunks) yield chunk
  } finally {
    controller.abort()
    await run
  }
}

async function streamConfiguredModel(input: MeetingModelRequest): Promise<AsyncIterable<string> | null> {
  input.signal?.throwIfAborted()
  const catalog = await getAvailableModelConfigForProfile(input.profile)
  const selectedModel = input.model || catalog.default
  const selectedProvider = input.provider || catalog.default_provider
  const selectedGroup = catalog.groups.find(group =>
    group.provider === selectedProvider && group.models.includes(selectedModel))
    ?? (!input.provider ? catalog.groups.find(group => group.models.includes(selectedModel)) : undefined)
  const defaultGroup = input.model || selectedGroup ? undefined : catalog.groups.find(group =>
    group.models.some(model => supportsMeetingModel(group, model)))
  const group = selectedGroup ?? defaultGroup
  const model = selectedGroup ? selectedModel : group?.models.find(model => supportsMeetingModel(group, model))
  if (!group || !model) {
    if (input.provider || input.model) throw new Error('Meeting model is unavailable in this profile')
    return null
  }
  if (!supportsMeetingModel(group, model)) throw new Error('The configured meeting model does not support text analysis')
  const config = await resolveEkkoProviderRuntimeConfig({
    profile: input.profile,
    provider: group.provider,
    model,
    apiMode: modelApiMode(group, model),
  })
  const { providerConfig } = resolveModelProviderConfigs({ ...config, model })
  if (!providerConfig.baseUrl) throw new Error('The configured meeting model has no provider endpoint')
  const client = createModelClient(providerConfig, {
    fetch: createEkkoAuthorizedProviderFetch({ profile: input.profile, provider: group.provider, model, accessToken: config.apiKey }),
  })
  return streamEkkoMeetingRun(input, client, model)
}

configureMeetingRuntime({
  resolveBundledSkillsDirectory: () => HermesSkillInjector.resolveSourceDir(),
  streamConfiguredModel,
})
