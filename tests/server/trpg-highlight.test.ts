import { describe, it, expect, vi } from 'vitest'
import { characterName, parseInput, generateHighlight } from '../../packages/server/src/services/trpg/highlight'
const input = { transcript: '小林：银月举起盾牌挡住箭矢。', setting: '城门', style: '水彩', characters: [{ id: 'elf', name: '【银月】', player: '小林', appearance: '银发', card: '秘密：王族' }] }
const loadConfig = async () => ({ apiKey: 'secret', baseUrl: 'https://example.invalid/v1/', model: 'test' })
const output = { scene: '月下城门，低机位', actions: [{ characterId: 'elf', action: '举盾挡箭', evidence: '银月举起盾牌挡住箭矢。' }] }
function deps(value: unknown) { return { loadConfig, fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }))) as unknown as typeof fetch } }
describe('TRPG highlight', () => {
  it('normalizes names and emits explicit actions without leaking character card secrets', async () => {
    expect(characterName('【银月】\n')).toBe('【银月】')
    const d = deps(output)
    const result = await generateHighlight(parseInput(input), undefined, d)
    expect(result.prompt).toContain('【银月】：外观：银发。动作：举盾挡箭')
    expect(result.prompt).not.toContain('王族')
    expect(result.actions[0].evidence).toBe(output.actions[0].evidence)
    expect(d.fetchImpl).toHaveBeenCalledWith('https://example.invalid/v1/chat/completions', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
  it('rejects empty transcripts, duplicate formatted names and oversized data', () => {
    for (const v of [{ ...input, transcript: '' }, { ...input, transcript: 'x'.repeat(12001) }, { ...input, characters: [...input.characters, { ...input.characters[0], id: 'b', name: '银月' }] }, { ...input, characters: [{ ...input.characters[0], name: '【】' }] }]) expect(() => parseInput(v)).toThrow('invalid_input')
  })
  it('rejects unknown characters and fabricated quotes', async () => {
    for (const action of [{ ...output.actions[0], characterId: 'unknown' }, { ...output.actions[0], evidence: '击败巨龙' }]) {
      await expect(generateHighlight(parseInput(input), undefined, deps({ ...output, actions: [action] }))).rejects.toThrow('invalid_output')
    }
  })
  it('reports no highlight and unavailable model distinctly', async () => {
    await expect(generateHighlight(parseInput(input), undefined, deps(null))).rejects.toThrow('no_highlight')
    await expect(generateHighlight(parseInput(input), undefined, { loadConfig: async () => null })).rejects.toThrow('llm_not_configured')
  })
  it('does not expose provider error bodies', async () => {
    await expect(generateHighlight(parseInput(input), undefined, { loadConfig, fetchImpl: vi.fn(async () => new Response('secret', { status: 500 })) as unknown as typeof fetch })).rejects.toThrow('generation_failed')
  })

  it('uses meeting config directly and never silently switches to an Agent', async () => {
    await expect(generateHighlight(parseInput(input), 'default', { loadConfig: async () => null })).rejects.toThrow('llm_not_configured')
    const d = deps(output)
    const config = { apiKey: 'meeting-secret', baseUrl: 'https://meeting.invalid/v1', model: 'meeting-model' }
    await generateHighlight(parseInput({ ...input, llmConfig: config }), 'default', d)
    const [url, init] = (d.fetchImpl as any).mock.calls[0]
    expect(url).toBe('https://meeting.invalid/v1/chat/completions')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('meeting-model')
    expect(JSON.stringify(body.messages)).not.toContain('meeting-secret')
  })
})
