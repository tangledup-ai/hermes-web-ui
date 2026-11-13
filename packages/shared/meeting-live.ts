export interface MeetingLiveSentence {
  text: string
  timestamp: number
  startTime?: number
  endTime?: number
}

export interface MeetingLiveSession {
  id: string
  source: 'h618'
  startedAt: number
  status: 'connecting' | 'transcribing' | 'disconnected' | 'syncing' | 'saved'
  partial: string
  sentences: MeetingLiveSentence[]
}

export type MeetingLiveEvent =
  | { type: 'upsert'; session: MeetingLiveSession }
  | { type: 'partial'; id: string; text: string }
  | { type: 'final'; id: string; sentence: MeetingLiveSentence }
  | { type: 'remove'; id: string }
