export const recapModes = ['literary', 'documentary', 'journal'] as const
export const recapTones = ['epic', 'gritty', 'comedic', 'noir', 'mystery'] as const
export interface RecapOptions {
  mode: typeof recapModes[number]
  tone: typeof recapTones[number]
  chapterHint?: number
  characters: { id: string; name: string; player?: string }[]
  setting: string
  style: string
}
export interface RecapEntry extends RecapOptions {
  id: string
  meetingId: string
  title: string
  chapters: { id: string; title: string; startQuote: string; endQuote: string; body: string; highlights: { characterId: string; name: string; action: string; evidence: string }[] }[]
  timeline: { time: string; text: string }[]
  generatedAt: number
  skillUsed: string
}
