export interface MeetingModelTarget {
  profile: string
  provider?: string
  model?: string
}

export interface MeetingModelRequest extends MeetingModelTarget {
  purpose: 'meeting-analysis' | 'meeting-report' | 'meeting-title'
  systemPrompt: string
  userPrompt: string
  temperature: number
  maxTokens: number
  signal?: AbortSignal
}

export interface MeetingRuntimeDependencies {
  resolveBundledSkillsDirectory(): string
  streamConfiguredModel(input: MeetingModelRequest): Promise<AsyncIterable<string> | null>
}

let dependencies: MeetingRuntimeDependencies | undefined

export function configureMeetingRuntime(next: MeetingRuntimeDependencies): void {
  dependencies = next
}

export function resolveBundledMeetingSkillsDirectory(): string {
  if (!dependencies) throw new Error('Studio meeting runtime has not been configured')
  return dependencies.resolveBundledSkillsDirectory()
}

export async function streamConfiguredMeetingModel(input: MeetingModelRequest): Promise<AsyncIterable<string> | null> {
  return dependencies?.streamConfiguredModel(input) ?? null
}
