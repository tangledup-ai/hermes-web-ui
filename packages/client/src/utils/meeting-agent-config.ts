import type { MeetingSession } from '@/stores/hermes/meeting'

export function resolveMeetingAgent(session?: MeetingSession | null) {
  const config = session?.agentConfig
  const agentType = (config?.agentType === 'hermes' || (!config && session?.analysisMode === 'hermes'))
    ? 'hermes' as const
    : 'ekko' as const
  const provider = config?.provider || session?.customProvider
  const model = config?.model || session?.customModel
  return {
    agentType,
    profile: config?.profile || session?.hermesProfile,
    ...(provider && model ? { provider, model } : {}),
  }
}
