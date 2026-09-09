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

  it('falls back to Hermes Agent bridge when loadLLMConfig is empty and profile is given', async () => {
    const streamResults = [{
      run_id: 'r1', session_id: 's1', status: 'complete',
      delta: JSON.stringify(output), cursor: 0, output: '', done: true,
      result: undefined, error: null, events: [], event_cursor: 0,
    }]
    async function* gen() { for (const c of streamResults) yield c }
    const fakeBridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'r1', session_id: 's1', status: 'accepted' }),
      streamOutput: () => gen(),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    const result = await generateHighlight(parseInput(input), 'default', {
      loadConfig: async () => null,
      createBridge: () => fakeBridge,
    })
    expect(result.prompt).toContain('【银月】：外观：银发。动作：举盾挡箭')
    expect(fakeBridge.chat).toHaveBeenCalledTimes(1)
    const [, message, , instructions, profile] = fakeBridge.chat.mock.calls[0]
    expect(instructions).toContain('桌面角色扮演游戏')
    expect(profile).toBe('default')
    expect(typeof message).toBe('string')
    expect((message as string).length).toBeGreaterThan(0)
  })

  it('maps bridge connect failures (ETIMEDOUT / ECONNREFUSED) to agent_unreachable', async () => {
    const errs = [
      Object.assign(new Error('Agent bridge connect timed out'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    ]
    for (const e of errs) {
      const fakeBridge = {
        chat: vi.fn().mockRejectedValue(e),
        streamOutput: () => (async function* () { /* never */ })(),
        destroy: vi.fn().mockResolvedValue(undefined),
      }
      await expect(generateHighlight(parseInput(input), 'default', {
        loadConfig: async () => null,
        createBridge: () => fakeBridge,
      })).rejects.toMatchObject({ message: 'agent_unreachable' })
    }
  })

  it('throws invalid_output when bridge returns non-JSON', async () => {
    const streamResults = [{
      run_id: 'r1', session_id: 's1', status: 'complete',
      delta: 'thinking out loud without JSON', cursor: 0, output: '', done: true,
      result: undefined, error: null, events: [], event_cursor: 0,
    }]
    async function* gen() { for (const c of streamResults) yield c }
    const fakeBridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'r1', session_id: 's1', status: 'accepted' }),
      streamOutput: () => gen(),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    await expect(generateHighlight(parseInput(input), 'default', {
      loadConfig: async () => null,
      createBridge: () => fakeBridge,
    })).rejects.toThrow('invalid_output')
  })
})
