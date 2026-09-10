import { describe, it, expect, vi } from 'vitest'
import { parseDraftInput, draftCharacter } from '../../packages/server/src/services/trpg/character-draft'

const validPdf = 'data:application/pdf;base64,JVBERi0xLjQKJ'
const validPng = 'data:image/png;base64,iVBORw0KGgo='
const loadConfig = async () => ({ apiKey: 'secret', baseUrl: 'https://example.invalid/v1/', model: 'test' })
function deps(value: unknown) {
  return { loadConfig, fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }))) as unknown as typeof fetch }
}

describe('TRPG character draft input', () => {
  it('accepts a PDF data URI in image field without text', () => {
    expect(() => parseDraftInput({ text: '', image: validPdf })).not.toThrow()
    expect(parseDraftInput({ text: '', image: validPdf }).image).toBe(validPdf)
  })

  it('extracts JSON wrapped in prose / markdown fences (tolerant parser)', async () => {
    const noisy = '以下是草稿：\n```json\n{"name":"银月","player":"","appearance":"银发","card":"","sheet":{}}\n```\n祝玩得开心。'
    const d = deps({ ...noisy, fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: noisy } }] }))) as unknown as typeof fetch })
    // adapter shim: ensure deps.fetchImpl runs through the noisy body shape
    const result = await draftCharacter(parseDraftInput({ text: 'noisy text' }), undefined, {
      loadConfig: async () => ({ apiKey: 'k', baseUrl: 'https://x.invalid', model: 'm' }),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: noisy } }] }))) as unknown as typeof fetch,
    })
    expect(result.draft.name).toBe('银月')
  })

  it('extracts JSON buried at the end of a long narrative (agent reasoning + final JSON)', async () => {
    const narrative = `I'll read the PDF file and extract the character information according to the D&D 5E character sheet format. The PDF needs OCR. Let me convert it to images first and then process them. There are existing OCR results. Let me look at them. Excellent! I now have a clear view of page 1. Let me also check page 2 (portrait/backstory) and page 3 (spellcasting). Now I need to look at page 3 to verify if there are any spell slots. Page 3 is completely blank. Now let me zoom into page 2 to read the backstory text more carefully. I have the backstory. Now I have all the data I need. Let me compile the character {"name":"甘棠","player":"","appearance":"银发精灵","card":"游侠3级","sheet":{"strength":"14","dexterity":"16"}}`
    const result = await draftCharacter(parseDraftInput({ text: 'hi' }), undefined, {
      loadConfig: async () => ({ apiKey: 'k', baseUrl: 'https://x.invalid', model: 'm' }),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: narrative } }] }))) as unknown as typeof fetch,
    })
    expect(result.draft.name).toBe('甘棠')
    expect(result.draft.appearance).toBe('银发精灵')
    expect(result.draft.sheet.strength).toBe('14')
    expect(result.draft.sheet.dexterity).toBe('16')
  })

  it('still rejects pure prose with no JSON', async () => {
    await expect(draftCharacter(parseDraftInput({ text: 'hi' }), undefined, {
      loadConfig: async () => ({ apiKey: 'k', baseUrl: 'https://x.invalid', model: 'm' }),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'I cannot read this PDF.' } }] }))) as unknown as typeof fetch,
    })).rejects.toThrow('invalid_output')
  })

  it('prefers trpgLlmConfig from the request body over loadLLMConfig', async () => {
    const d = deps({ name: '甘棠', player: '', appearance: '银发精灵', card: '', sheet: {} })
    await draftCharacter(parseDraftInput({
      text: '银发精灵',
      trpgLlmConfig: { apiKey: 'trpg-key', baseUrl: 'https://trpg.invalid', model: 'trpg-model' },
    }), undefined, {
      loadConfig: async () => ({ apiKey: 'config-key', baseUrl: 'https://config.invalid', model: 'config-model' }),
      fetchImpl: d.fetchImpl,
    })
    const url = (d.fetchImpl.mock.calls[0] as any)[0]
    expect(url).toBe('https://trpg.invalid/chat/completions')
    const body = JSON.parse((d.fetchImpl.mock.calls[0] as any)[1].body)
    expect(body.model).toBe('trpg-model')
  })

  it('rejects malformed trpgLlmConfig with invalid_input', () => {
    expect(() => parseDraftInput({ text: 'hi', trpgLlmConfig: { apiKey: '', baseUrl: 'x', model: 'y' } })).toThrow('invalid_input')
    expect(() => parseDraftInput({ text: 'hi', trpgLlmConfig: 'not-an-object' as any })).toThrow('invalid_input')
  })

  it('attaches raw response to invalid_output errors for debugging', async () => {
    const noisy = 'I cannot parse this PDF into JSON.'
    const d: any = {
      loadConfig: async () => ({ apiKey: 'k', baseUrl: 'https://x.invalid', model: 'm' }),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: noisy } }] }))) as unknown as typeof fetch,
    }
    try {
      await draftCharacter(parseDraftInput({ text: 'hi' }), undefined, d)
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as Error).message).toBe('invalid_output')
      expect((err as { raw?: string }).raw).toContain(noisy)
    }
  })

  it('maps upstream image-format errors (MiniMax / DashScope-style 400) to image_format_unsupported', async () => {
    const upstreamBody = JSON.stringify({
      error: { code: 'invalid_param', message: 'HTTP 400: invalid param: invalid image content: decode image config: image: unknown format (2013)' },
    })
    const d: any = {
      loadConfig: async () => ({ apiKey: 'k', baseUrl: 'https://dashscope.invalid', model: 'qwen-vl-max' }),
      fetchImpl: vi.fn(async () => new Response(upstreamBody, { status: 400 })) as unknown as typeof fetch,
    }
    try {
      await draftCharacter(parseDraftInput({ text: 'hi', image: 'data:application/pdf;base64,JVBERi==' }), undefined, d)
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as Error).message).toBe('image_format_unsupported')
      expect((err as { upstreamStatus?: number }).upstreamStatus).toBe(400)
      expect((err as { raw?: string }).raw).toContain('unknown format')
    }
  })

  it('maps in-content error text from a 200 response (model returns error in content) to image_format_unsupported', async () => {
    const noisy = 'Error: HTTP 400: invalid image content: unknown format'
    const d: any = {
      loadConfig: async () => ({ apiKey: 'k', baseUrl: 'https://x.invalid', model: 'm' }),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: noisy } }] }))) as unknown as typeof fetch,
    }
    try {
      await draftCharacter(parseDraftInput({ text: 'hi' }), undefined, d)
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as Error).message).toBe('image_format_unsupported')
      expect((err as { raw?: string }).raw).toContain('unknown format')
    }
  })

  it('bridge path writes PDF to a temp file under getWebUiHome and passes the file path (not image_url) to the agent', async () => {
    const streamResults = [{
      run_id: 'r1', session_id: 's1', status: 'complete',
      delta: '{"name":"甘棠","player":"","appearance":"银发","card":"","sheet":{}}',
      cursor: 0, output: '', done: true, result: undefined, error: null, events: [], event_cursor: 0,
    }]
    async function* gen() { for (const c of streamResults) yield c }
    const fakeBridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'r1', session_id: 's1', status: 'accepted' }),
      streamOutput: () => gen(),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    const fs = await import('fs/promises')
    const home = (await import('../../packages/server/src/config')).getWebUiHome()
    const pdfPath = `${home}/trpg-uploads/__probe__.pdf`
    await fs.rm(`${home}/trpg-uploads/__probe__.pdf`, { force: true })
    const result = await draftCharacter(parseDraftInput({ text: 'DND 角色', image: validPdf }), 'default', {
      loadConfig: async () => null, // 强制走 bridge 路径
      createBridge: () => fakeBridge,
    })
    expect(result.draft.name).toBe('甘棠')
    // Capture the message the agent received
    const message = fakeBridge.chat.mock.calls[0][1]
    expect(Array.isArray(message)).toBe(true)
    expect(message[0].type).toBe('text')
    expect(message[0].text).toContain('DND 角色')
    expect(message[1].type).toBe('text')
    expect(message[1].text).toContain('[Attached PDF file]')
    expect(message[1].text).toContain('Local file path for tools:')
    // The file path should be under trpg-uploads/
    const pathLine = message[1].text.split('\n').find((l: string) => l.startsWith('Local file path for tools:'))!
    const filePath = pathLine.replace('Local file path for tools:', '').trim()
    expect(filePath.startsWith(`${home}/trpg-uploads/`)).toBe(true)
    expect(filePath.endsWith('.pdf')).toBe(true)
    // The temp file should be cleaned up after the call (no longer exists).
    await expect(fs.access(filePath)).rejects.toThrow()
    await fs.rm(pdfPath, { force: true })
  })

  it('auto-falls back to Hermes Agent bridge when direct LLM rejects PDF with image_format_unsupported', async () => {
    const streamResults = [{
      run_id: 'r1', session_id: 's1', status: 'complete',
      delta: '{"name":"甘棠","player":"","appearance":"银发","card":"","sheet":{}}',
      cursor: 0, output: '', done: true, result: undefined, error: null, events: [], event_cursor: 0,
    }]
    async function* gen() { for (const c of streamResults) yield c }
    const fakeBridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'r1', session_id: 's1', status: 'accepted' }),
      streamOutput: () => gen(),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    const upstreamBody = JSON.stringify({ error: { code: 'invalid_param', message: 'invalid image content' } })
    const d: any = {
      loadConfig: async () => ({ apiKey: 'k', baseUrl: 'https://minimax.invalid', model: 'MiniMax-M3' }),
      fetchImpl: vi.fn(async () => new Response(upstreamBody, { status: 400 })) as unknown as typeof fetch,
      createBridge: () => fakeBridge,
    }
    const result = await draftCharacter(parseDraftInput({ text: 'DND 角色', image: validPdf }), 'default', d)
    expect(result.draft.name).toBe('甘棠')
    // Direct path was tried first, then bridge was tried
    expect(d.fetchImpl).toHaveBeenCalledTimes(1)
    expect(fakeBridge.chat).toHaveBeenCalledTimes(1)
    const message = fakeBridge.chat.mock.calls[0][1]
    expect(Array.isArray(message)).toBe(true)
    expect(message[1].text).toContain('[Attached PDF file]')
  })

  it('does NOT auto-fallback to bridge for image inputs (only PDFs)', async () => {
    const validPng = 'data:image/png;base64,iVBORw0KGgo='
    const upstreamBody = JSON.stringify({ error: { code: 'invalid_param', message: 'invalid image content' } })
    const d: any = {
      loadConfig: async () => ({ apiKey: 'k', baseUrl: 'https://minimax.invalid', model: 'MiniMax-M3' }),
      fetchImpl: vi.fn(async () => new Response(upstreamBody, { status: 400 })) as unknown as typeof fetch,
      createBridge: vi.fn(),
    }
    await expect(draftCharacter(parseDraftInput({ text: 'hi', image: validPng }), 'default', d))
      .rejects.toThrow('image_format_unsupported')
    // Bridge was NOT called because the input is an image, not a PDF
    expect(d.createBridge).not.toHaveBeenCalled()
  })

  it('collects a trace of bridge events (status / tool_call / text / final) when bridge succeeds', async () => {
    const streamResults = [
      { run_id: 'r1', session_id: 's1', status: 'running', delta: '', cursor: 0, output: '', done: false, error: null, events: [
        { type: 'tool_call', name: 'read_file', args: { path: '/tmp/x.pdf' } },
        { type: 'reasoning', text: '正在读取 PDF…' },
      ], event_cursor: 0 },
      { run_id: 'r1', session_id: 's1', status: 'running', delta: '', cursor: 0, output: '', done: false, error: null, events: [], event_cursor: 0 },
      { run_id: 'r1', session_id: 's1', status: 'complete', delta: '', cursor: 0, output: '', done: true, result: { final_response: '{"name":"银月","player":"","appearance":"银发","card":"","sheet":{}}' }, error: null, events: [], event_cursor: 0 },
    ]
    async function* gen() { for (const c of streamResults) yield c }
    const fakeBridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'r1', session_id: 's1', status: 'accepted' }),
      streamOutput: () => gen(),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    const result = await draftCharacter(parseDraftInput({ text: 'DND 角色', image: validPdf }), 'default', {
      loadConfig: async () => null,
      createBridge: () => fakeBridge,
    })
    expect(result.draft.name).toBe('银月')
    // Trace should contain status, tool_call, at least one text delta, and final.
    const types = result.trace.map(t => t.type)
    expect(types).toContain('status')
    expect(types).toContain('tool_call')
    expect(types.filter(t => t === 'text').length).toBeGreaterThanOrEqual(1)
    expect(types).toContain('final')
    const toolEvent = result.trace.find(t => t.type === 'tool_call')!
    expect(toolEvent.message).toContain('read_file')
    expect(toolEvent.message).toContain('/tmp/x.pdf')
    // Status event should announce the temp PDF file path written by server
    const statusEvents = result.trace.filter(t => t.type === 'status')
    expect(statusEvents.some(t => t.message.includes('pdf.temp_file'))).toBe(true)
  })

  it('accepts PNG/JPEG/WebP data URIs unchanged', () => {
    for (const uri of [validPng, 'data:image/jpeg;base64,/9j/4AAQ', 'data:image/webp;base64,UklGRg==']) {
      expect(() => parseDraftInput({ text: 'hi', image: uri })).not.toThrow()
    }
  })

  it('rejects an oversized payload (image too big or text too long)', () => {
    const oversizedPdf = 'data:application/pdf;base64,' + 'A'.repeat(7 * 1024 * 1024)
    expect(() => parseDraftInput({ text: 'hi', image: oversizedPdf })).toThrow('invalid_input')
    expect(() => parseDraftInput({ text: 'x'.repeat(12001) })).toThrow('invalid_input')
  })

  it('rejects an unknown MIME type', () => {
    expect(() => parseDraftInput({ text: 'hi', image: 'data:text/plain;base64,SGk=' })).toThrow('invalid_input')
    expect(() => parseDraftInput({ text: 'hi', image: 'data:image/svg+xml;base64,PHN2Zy8+' })).toThrow('invalid_input')
  })

  it('rejects when both text and image are empty', () => {
    expect(() => parseDraftInput({ text: '   ' })).toThrow('invalid_input')
    expect(() => parseDraftInput({ text: '' })).toThrow('invalid_input')
  })
})

describe('TRPG character draft generation', () => {
  it('passes PDF as a file content block, never an image URL', async () => {
    const d = deps({ name: '银月', player: '小林', appearance: '银发', card: '', sheet: {} })
    await draftCharacter(parseDraftInput({ text: '', image: validPdf }), undefined, d)
    const body = JSON.parse((d.fetchImpl.mock.calls[0] as any)[1].body)
    const userMsg = body.messages[1]
    expect(Array.isArray(userMsg.content)).toBe(true)
    expect(userMsg.content[1]).toEqual({ type: 'file', file: { filename: 'character.pdf', file_data: validPdf } })
  })

  it('reports llm_not_configured when no LLM config and no profile are provided', async () => {
    await expect(draftCharacter(parseDraftInput({ text: 'hi' }), undefined, { loadConfig: async () => null, fetchImpl: vi.fn() as unknown as typeof fetch })).rejects.toThrow('llm_not_configured')
  })

  it('uses the profile default model + provider credentials when loadLLMConfig is empty', async () => {
    // Server has no meeting-asr LLM config, but the active profile's
    // config.yaml carries a working OpenAI provider. The character-draft
    // service should resolve the profile and use it as the direct path.
    const home = await import('os').then(m => m.tmpdir())
    const profileHome = await import('fs/promises').then(m => m.mkdtemp(`${home}/trpg-draft-profile-`))
    const originalHome = process.env.HERMES_HOME
    process.env.HERMES_HOME = profileHome
    try {
      const { mkdir, writeFile } = await import('fs/promises')
      const profileDir = `${profileHome}/profiles/work`
      await mkdir(profileDir, { recursive: true })
      await writeFile(`${profileDir}/config.yaml`,
        'model:\n  default: gpt-4o\n  provider: openai\ncustom_providers:\n  - name: openai\n    base_url: https://api.openai.com/v1\n    api_key: sk-profile\n',
        'utf-8')
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"name":"银月","player":"","appearance":"","card":"","sheet":{}}' } }] }))) as unknown as typeof fetch
      const result = await draftCharacter(parseDraftInput({ text: '银发女精灵' }), 'work', {
        // No deps.loadConfig: simulates the user has not edited meeting-asr/config.json
        // but has set the profile's default model via the UI.
        fetchImpl,
      })
      expect(result.draft.name).toBe('银月')
      const url = (fetchImpl.mock.calls[0] as any)[0]
      expect(url).toBe('https://api.openai.com/v1/chat/completions')
      const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body)
      expect(body.model).toBe('gpt-4o')
      expect(body.messages[0].role).toBe('system')
      expect(body.messages[0].content).toContain('D&D 5E')
    } finally {
      if (originalHome === undefined) delete process.env.HERMES_HOME
      else process.env.HERMES_HOME = originalHome
      const { rm } = await import('fs/promises')
      await rm(profileHome, { recursive: true, force: true })
    }
  })

  it('falls back to Hermes Agent bridge when LLM is unconfigured and profile is given', async () => {
    const streamResults = [{ run_id: 'r1', session_id: 's1', status: 'complete', delta: '{"name":"银月","player":"","appearance":"银发","card":"","sheet":{}}', cursor: 0, output: '', done: true, result: undefined, error: null, events: [], event_cursor: 0 }]
    async function* gen() { for (const c of streamResults) yield c }
    const fakeBridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'r1', session_id: 's1', status: 'accepted' }),
      streamOutput: () => gen(),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    const result = await draftCharacter(parseDraftInput({ text: '银发女精灵' }), 'default', {
      loadConfig: async () => null,
      createBridge: () => fakeBridge,
    })
    expect(result.draft.name).toBe('银月')
    expect(fakeBridge.chat).toHaveBeenCalledTimes(1)
    const [, message, , instructions, profile, options] = fakeBridge.chat.mock.calls[0]
    expect(instructions).toContain('D&D 5E角色卡录入助手')
    expect(profile).toBe('default')
    expect(options).toMatchObject({ source: 'trpg-character-draft' })
    expect(message).toBe('银发女精灵')
  })

  it('throws invalid_output when the bridge returns an empty / non-JSON body', async () => {
    const streamResults = [{ run_id: 'r1', session_id: 's1', status: 'complete', delta: '', cursor: 0, output: '', done: true, result: { final_response: '' }, error: null, events: [], event_cursor: 0 }]
    async function* gen() { for (const c of streamResults) yield c }
    const fakeBridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'r1', session_id: 's1', status: 'accepted' }),
      streamOutput: () => gen(),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    await expect(draftCharacter(parseDraftInput({ text: 'hi' }), 'default', {
      loadConfig: async () => null,
      createBridge: () => fakeBridge,
    })).rejects.toThrow('invalid_output')
  })

  it('bridge retries for JSON when first call returns narrative + buried JSON at end', async () => {
    // First call: agent narrates with a balanced JSON object buried at the end.
    // New parser extracts it from the first call → no retry needed. To force a
    // retry, we use a narrative that contains NO balanced JSON (the parser
    // can't extract anything). Second call returns pure JSON.
    const narrativeNoJson = 'I am still reading the PDF. The OCR is garbled. Let me try page 2. Page 2 is also tricky. I will keep trying. Let me wait for clearer input.'
    const pureJson = '{"name":"甘棠","player":"","appearance":"银发","card":"","sheet":{"classLevel":"游侠3"}}'
    function makeStream(delta: string) {
      return async function* () {
        yield { run_id: 'r', session_id: 's1', status: 'complete', delta, cursor: 0, output: '', done: true, result: undefined, error: null, events: [], event_cursor: 0 }
      }
    }
    let callIdx = 0
    const fakeBridge = {
      chat: vi.fn()
        .mockResolvedValueOnce({ run_id: 'r1', session_id: 's1', status: 'accepted' })
        .mockResolvedValueOnce({ run_id: 'r2', session_id: 's1', status: 'accepted' }),
      streamOutput: (_runId: string) => {
        const delta = callIdx++ === 0 ? narrativeNoJson : pureJson
        return makeStream(delta)()
      },
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    const result = await draftCharacter(parseDraftInput({ text: 'DND 角色' }), 'default', {
      loadConfig: async () => null,
      createBridge: () => fakeBridge,
    })
    expect(result.draft.name).toBe('甘棠')
    expect(result.draft.sheet.classLevel).toBe('游侠3')
    // The bridge was called twice (initial + retry).
    expect(fakeBridge.chat).toHaveBeenCalledTimes(2)
    // Trace should include a bridge.retry_for_json status event.
    expect(result.trace.some(t => t.type === 'status' && t.message === 'bridge.retry_for_json')).toBe(true)
  })

  it('bridge retry still throws invalid_output when second call also has no JSON', async () => {
    const narrativeNoJson = 'still thinking'
    function makeStream(_delta: string) {
      return async function* () {
        yield { run_id: 'r', session_id: 's1', status: 'complete', delta: narrativeNoJson, cursor: 0, output: '', done: true, result: undefined, error: null, events: [], event_cursor: 0 }
      }
    }
    const fakeBridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'r1', session_id: 's1', status: 'accepted' }),
      streamOutput: () => makeStream(narrativeNoJson)(),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    await expect(draftCharacter(parseDraftInput({ text: 'hi' }), 'default', {
      loadConfig: async () => null,
      createBridge: () => fakeBridge,
    })).rejects.toMatchObject({ message: 'invalid_output' })
    expect(fakeBridge.chat).toHaveBeenCalledTimes(2)
  })

  it('maps bridge connect failures (ETIMEDOUT / ECONNREFUSED) to agent_unreachable', async () => {
    const cases = [
      Object.assign(new Error('Agent bridge connect timed out'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    ]
    for (const err of cases) {
      const fakeBridge = {
        chat: vi.fn().mockRejectedValue(err),
        streamOutput: () => (async function* () { /* never */ })(),
        destroy: vi.fn().mockResolvedValue(undefined),
      }
      await expect(draftCharacter(parseDraftInput({ text: 'hi' }), 'default', {
        loadConfig: async () => null,
        createBridge: () => fakeBridge,
      })).rejects.toThrow('agent_unreachable')
    }
  })
})