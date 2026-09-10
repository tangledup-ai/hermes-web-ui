import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareRecap, recapTranscript, saveRecap, listRecaps, deleteRecap, parseRecapInput } from '../../packages/server/src/services/trpg/recap'
const input = { meetingId: 'campaign-1', mode: 'literary', tone: '', setting: '', style: '', characters: [{ id: 'elf', name: '银月', player: '小林', card: 'secret' }], sentences: [{ text: '银月举盾。随后箭雨落下。' }] }
const body = { title: '城门', chapters: [{ title: '箭雨', startQuote: '银月举盾。', endQuote: '箭雨落下。', body: '银月举起盾牌。', highlights: [{ characterId: 'elf', action: '举盾', evidence: '银月举盾。' }] }], timeline: [] }
let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'trpg-recap-')); vi.stubEnv('HERMES_WEB_UI_HOME', home) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }) })
describe('recap snapshots and evidence', () => {
  it('persists a snapshot, excludes card secrets, validates and idempotently saves', async () => {
    const { requestId } = await prepareRecap(input, 'default')
    const source = await recapTranscript(input.meetingId, requestId, 'default')
    expect(source.options.tone).toBe('epic')
    expect(JSON.stringify(source)).not.toContain('secret')
    for (let n = 0; n < 2; n++) await saveRecap(input.meetingId, { ...body, requestId }, 'default')
    const entries = await listRecaps(input.meetingId, 'default')
    expect(entries).toHaveLength(1)
    expect(entries[0].chapters[0].highlights[0].name).toBe('【银月】')
    await deleteRecap(input.meetingId, requestId, 'default')
    expect(await listRecaps(input.meetingId, 'default')).toEqual([])
  })
  it('rejects fabricated anchors, unknown actors, oversized chapters and cross-profile access', async () => {
    const { requestId } = await prepareRecap(input, 'one')
    await expect(recapTranscript(input.meetingId, requestId, 'two')).rejects.toThrow('profile_forbidden')
    for (const change of [{ startQuote: '屠龙成功' }, { body: 'x'.repeat(1801) }, { highlights: [{ characterId: 'unknown', action: 'x', evidence: '银月举盾。' }] }]) {
      await expect(saveRecap(input.meetingId, { ...body, requestId, chapters: [{ ...body.chapters[0], ...change }] }, 'one')).rejects.toThrow('invalid_recap')
    }
    expect(await listRecaps(input.meetingId, 'two')).toEqual([])
    await expect(prepareRecap({ ...input, meetingId: '../escape' }, 'one')).rejects.toThrow()
    expect(() => parseRecapInput({ ...input, chapterHint: 9 })).toThrow()
  })
  it('paginates without losing sentences and serializes concurrent saves', async () => {
    const source = { ...input, sentences: Array.from({ length: 15 }, (_, i) => ({ text: `${i}:${'x'.repeat(6000)}` })) }
    const { requestId } = await prepareRecap(source, 'default')
    const first = await recapTranscript(input.meetingId, requestId, 'default')
    const second = await recapTranscript(input.meetingId, requestId, 'default', first.nextCursor!)
    expect([...first.sentences, ...second.sentences]).toEqual(source.sentences.map(s => ({ ...s, speaker: '', timestamp: '' })))
    expect(second.nextCursor).toBeNull()
    const requests = await Promise.all([prepareRecap(input, 'default'), prepareRecap(input, 'default')])
    await Promise.all(requests.map(r => saveRecap(input.meetingId, { ...body, ...r }, 'default')))
    expect(await listRecaps(input.meetingId, 'default')).toHaveLength(2)
  })
})
