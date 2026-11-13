import { describe, expect, it } from 'vitest'
import { formatTranscriptForReport, meetingReportSourceIndex } from '../../packages/client/src/utils/meeting-report-transcript'

describe('meeting report source references', () => {
  it('keeps the transcript line indices and uses only known recording offsets', () => {
    expect(formatTranscriptForReport([
      { text: ' Launch approved. ', timestamp: 10, startTime: 0, speakerId: '0', speaker: 'Speaker 1' },
      { text: ' ', timestamp: 20 },
      { text: 'Review\non Friday.', timestamp: 30, startTime: 3_661_650 },
      { text: 'Owner to confirm.', timestamp: 40, startTime: -1 },
    ], { '0': 'Rosa' })).toBe([
      '[1] [00:00] [Rosa] Launch approved.',
      '[3] [01:01:01] Review on Friday.',
      '[4] Owner to confirm.',
    ].join('\n'))
  })

  it('matches source references without treating arbitrary links as transcript indices', () => {
    expect(meetingReportSourceIndex('#meeting-source-3')).toBe(2)
    expect(meetingReportSourceIndex('#meeting-source-0')).toBeNull()
    expect(meetingReportSourceIndex('#meeting-source-9007199254740992')).toBeNull()
    expect(meetingReportSourceIndex('https://example.com/#meeting-source-3')).toBeNull()
  })
})
