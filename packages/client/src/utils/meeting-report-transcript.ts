import type { TranscriptSentence } from '@/stores/hermes/meeting'
import { formatMeetingOffset } from './meeting-time'

export function formatTranscriptForReport(
  sentences: readonly TranscriptSentence[],
  speakerMap: Readonly<Record<string, string>> = {},
): string {
  const lines: string[] = []
  for (const [index, sentence] of sentences.entries()) {
    const text = sentence.text?.trim().replace(/\s+/g, ' ')
    if (!text) continue
    const speaker = (sentence.speakerId && speakerMap[sentence.speakerId]) || sentence.speaker
    const startTime = sentence.startTime
    const offset = typeof startTime === 'number' && Number.isFinite(startTime) && startTime >= 0
      ? ` [${formatMeetingOffset(startTime)}]`
      : ''
    const speakerLabel = speaker ? ` [${speaker.replace(/[\r\n\[\]]/g, ' ').trim()}]` : ''
    lines.push(`[${index + 1}]${offset}${speakerLabel} ${text}`)
  }
  return lines.join('\n')
}

export function meetingReportSourceIndex(href: string): number | null {
  const match = /^#meeting-source-([1-9]\d*)$/.exec(href)
  if (!match) return null
  const number = Number(match[1])
  return Number.isSafeInteger(number) ? number - 1 : null
}
