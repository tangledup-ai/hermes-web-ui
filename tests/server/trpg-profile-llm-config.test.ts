import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveProfileLLMConfig } from '../../packages/server/src/services/meeting-asr/direct-llm'

let home: string
const originalHome = process.env.HERMES_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'trpg-profile-llm-'))
  process.env.HERMES_HOME = home
})

afterEach(() => {
  if (originalHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})

function writeProfileConfig(name: string, yaml: string, env = ''): void {
  const profileDir = join(home, 'profiles', name)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'config.yaml'), yaml, 'utf-8')
  if (env) writeFileSync(join(profileDir, '.env'), env, 'utf-8')
}

describe('resolveProfileLLMConfig', () => {
  it('resolves inline api_key from custom_providers (legacy list schema)', async () => {
    writeProfileConfig('work', [
      'model:',
      '  default: gpt-4o',
      '  provider: openai',
      'custom_providers:',
      '  - name: openai',
      '    base_url: https://api.openai.com/v1',
      '    api_key: sk-test',
    ].join('\n'))
    const cfg = await resolveProfileLLMConfig('work')
    expect(cfg).toEqual({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    })
  })

  it('resolves inline api_key from providers (v12+ dict schema)', async () => {
    writeProfileConfig('work', [
      'model:',
      '  default: claude-3.5-sonnet',
      '  provider: anthropic',
      'providers:',
      '  anthropic:',
      '    base_url: https://api.anthropic.com/v1',
      '    api_key: sk-ant-test',
    ].join('\n'))
    const cfg = await resolveProfileLLMConfig('work')
    expect(cfg).toEqual({
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-3.5-sonnet',
    })
  })

  it('resolves key_env by reading profile .env file', async () => {
    writeProfileConfig(
      'work',
      [
        'model:',
        '  default: gpt-4o',
        '  provider: openai',
        'custom_providers:',
        '  - name: openai',
        '    base_url: https://api.openai.com/v1',
        '    key_env: OPENAI_API_KEY',
      ].join('\n'),
      'OPENAI_API_KEY=sk-from-env\n# other\nUNUSED=foo\n',
    )
    const cfg = await resolveProfileLLMConfig('work')
    expect(cfg?.apiKey).toBe('sk-from-env')
    expect(cfg?.baseUrl).toBe('https://api.openai.com/v1')
    expect(cfg?.model).toBe('gpt-4o')
  })

  it('strips wrapping quotes from .env values', async () => {
    writeProfileConfig(
      'work',
      [
        'model:',
        '  default: gpt-4o',
        '  provider: openai',
        'custom_providers:',
        '  - name: openai',
        '    base_url: https://api.openai.com/v1',
        '    key_env: OPENAI_API_KEY',
      ].join('\n'),
      'OPENAI_API_KEY="sk-quoted"\n',
    )
    const cfg = await resolveProfileLLMConfig('work')
    expect(cfg?.apiKey).toBe('sk-quoted')
  })

  it('prefers explicit requestedModel over profile default', async () => {
    writeProfileConfig('work', [
      'model:',
      '  default: gpt-4o',
      '  provider: openai',
      'custom_providers:',
      '  - name: openai',
      '    base_url: https://api.openai.com/v1',
      '    api_key: sk-test',
    ].join('\n'))
    const cfg = await resolveProfileLLMConfig('work', 'claude-3.5-sonnet')
    expect(cfg?.model).toBe('claude-3.5-sonnet')
  })

  it('picks the provider matching model.provider when set', async () => {
    writeProfileConfig('work', [
      'model:',
      '  default: gpt-4o',
      '  provider: anthropic',
      'custom_providers:',
      '  - name: openai',
      '    base_url: https://api.openai.com/v1',
      '    api_key: sk-openai',
      '  - name: anthropic',
      '    base_url: https://api.anthropic.com/v1',
      '    api_key: sk-anthropic',
    ].join('\n'))
    const cfg = await resolveProfileLLMConfig('work')
    expect(cfg?.apiKey).toBe('sk-anthropic')
    expect(cfg?.baseUrl).toBe('https://api.anthropic.com/v1')
  })

  it('returns null when the profile has no provider credentials', async () => {
    writeProfileConfig('work', [
      'model:',
      '  default: gpt-4o',
      '  provider: openai',
    ].join('\n'))
    const cfg = await resolveProfileLLMConfig('work')
    expect(cfg).toBeNull()
  })

  it('returns null when the profile config does not exist', async () => {
    const cfg = await resolveProfileLLMConfig('nonexistent')
    expect(cfg).toBeNull()
  })

  it('returns null when key_env is set but .env has no matching variable', async () => {
    writeProfileConfig(
      'work',
      [
        'model:',
        '  default: gpt-4o',
        'custom_providers:',
        '  - name: openai',
        '    base_url: https://api.openai.com/v1',
        '    key_env: OPENAI_API_KEY',
      ].join('\n'),
      'OTHER_KEY=whatever\n',
    )
    const cfg = await resolveProfileLLMConfig('work')
    expect(cfg).toBeNull()
  })

  it('returns null for an empty / missing profile name', async () => {
    expect(await resolveProfileLLMConfig('')).toBeNull()
    expect(await resolveProfileLLMConfig(undefined)).toBeNull()
  })

  it('trims trailing slashes from baseUrl', async () => {
    writeProfileConfig('work', [
      'model:',
      '  default: gpt-4o',
      '  provider: openai',
      'custom_providers:',
      '  - name: openai',
      '    base_url: https://api.openai.com/v1///',
      '    api_key: sk-test',
    ].join('\n'))
    const cfg = await resolveProfileLLMConfig('work')
    expect(cfg?.baseUrl).toBe('https://api.openai.com/v1')
  })

  it('prefers custom_providers over built-in when both exist for the same provider name', async () => {
    // `anthropic` is a built-in, but the user has overridden it in providers:
    // with their own baseUrl + apiKey. Custom block wins.
    writeProfileConfig('work', [
      'model:',
      '  default: claude-3.5-sonnet',
      '  provider: anthropic',
      'providers:',
      '  anthropic:',
      '    base_url: https://my-proxy.example/v1',
      '    api_key: sk-custom',
    ].join('\n'))
    const cfg = await resolveProfileLLMConfig('work')
    expect(cfg?.apiKey).toBe('sk-custom')
    expect(cfg?.baseUrl).toBe('https://my-proxy.example/v1')
  })

  it('falls back to built-in provider via env when no custom_providers entry matches', async () => {
    writeProfileConfig(
      'work',
      [
        'model:',
        '  default: deepseek-chat',
        '  provider: deepseek',
      ].join('\n'),
      'DEEPSEEK_API_KEY=sk-deepseek\n',
    )
    const profileDir = join(home, 'profiles', 'work')
    // eslint-disable-next-line no-console
    console.log('debug .env exists:', await import('fs').then(m => m.existsSync(join(profileDir, '.env'))))
    const fs = await import('fs/promises')
    const envText = await fs.readFile(join(profileDir, '.env'), 'utf-8').catch(() => 'ERR')
    // eslint-disable-next-line no-console
    console.log('debug .env content:', JSON.stringify(envText))
    const cfg = await resolveProfileLLMConfig('work')
    // eslint-disable-next-line no-console
    console.log('debug deepseek cfg:', cfg)
    expect(cfg?.apiKey).toBe('sk-deepseek')
    expect(cfg?.baseUrl).toMatch(/deepseek/i)
  })

  it('returns null for built-in anthropic_messages providers (minimax-cn etc.) — bridge takes over', async () => {
    // `minimax-cn` uses anthropic_messages API mode; the direct chat/completions
    // path can't talk to it, so resolveProfileLLMConfig should return null and
    // let draftCharacter fall through to the Hermes Agent bridge.
    writeProfileConfig(
      'work',
      [
        'model:',
        '  default: MiniMax-M3',
        '  provider: minimax-cn',
      ].join('\n'),
      'MINIMAX_CN_API_KEY=sk-mn\n',
    )
    const cfg = await resolveProfileLLMConfig('work')
    expect(cfg).toBeNull()
  })

  it('returns null when the profile references a custom provider name but no providers block is configured', async () => {
    writeProfileConfig('work', [
      'model:',
      '  default: gpt-4o',
      '  provider: openai',
    ].join('\n'))
    // `openai` is a built-in too. No custom_providers, but built-in returns
    // chat_completions path. With no OPENAI_API_KEY in .env or process.env,
    // expect null.
    const cfg = await resolveProfileLLMConfig('work')
    expect(cfg).toBeNull()
  })

  it('user-realistic: profile default MiniMax-M3 / minimax-cn returns null (bridge takes over)', async () => {
    // User's actual setup: profile's default model is MiniMax-M3 via
    // minimax-cn built-in provider. minimax-cn uses anthropic_messages,
    // not chat_completions, so the direct path can't talk to it.
    // resolveProfileLLMConfig must return null so draftCharacter falls
    // through to the Hermes Agent bridge (which knows how to call
    // anthropic_messages providers).
    writeProfileConfig(
      'work',
      [
        'model:',
        '  default: MiniMax-M3',
        '  provider: minimax-cn',
      ].join('\n'),
      'MINIMAX_CN_API_KEY=sk-cp-test\n',
    )
    const cfg = await resolveProfileLLMConfig('work')
    expect(cfg).toBeNull()
  })
})