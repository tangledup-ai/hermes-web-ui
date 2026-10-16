import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * resolveDashScopeKey 的解析顺序回归测试。
 *
 * 事故背景（2026-10-11, 设备 192.168.1.54）：用户在「设置 → 模型 → Realtime 模型」
 * 里换了多次 key，实时对话仍报 "DASHSCOPE_API_KEY is not configured"。
 *
 * 原因：那条 key 存在 SQLite `realtime_profile_settings`，而会议 ASR / Realtime 后端
 * 启动时只回落 config.json / config.env（浏览器会把 key 显式下发给后端，所以浏览器正常；
 * 设备端 Qt 客户端只开 /ws/omni-realtime，没有这条下发路径）→ 后端拿到空 key。
 *
 * 这里锁定三条来源的优先级：config 文件 → Realtime 面板 → 进程 env。
 */
describe('resolveDashScopeKey (config files → Realtime panel → env)', () => {
  let db: any = null
  const dirs: string[] = []
  const ENV_KEY = 'DASHSCOPE_API_KEY'
  let originalEnv: string | undefined

  const KEY_STORE = '../../packages/server/src/services/meeting-asr/dashscope-key-store'

  beforeEach(async () => {
    originalEnv = process.env[ENV_KEY]
    delete process.env[ENV_KEY]
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    if (originalEnv === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = originalEnv
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dashscope-resolve-'))
    dirs.push(dir)
    return dir
  }

  async function seedRealtimePanelKey(profile: string, key: string): Promise<void> {
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
    const store = await import('../../packages/server/src/db/hermes/realtime-settings-store')
    store.saveRealtimeModelSetting(profile, {
      settings: { model: 'qwen3.8-omni-flash-realtime', voice: 'Tina' },
      secrets: { apiKey: key },
    })
  }

  it('falls back to the Realtime panel key when no config file exists (the device incident)', async () => {
    await seedRealtimePanelKey('default', 'sk-from-panel')
    const { resolveDashScopeKey } = await import(KEY_STORE)
    expect(await resolveDashScopeKey(await tempDir())).toBe('sk-from-panel')
  })

  it('prefers the meeting-ASR config file over the Realtime panel (device-specific override)', async () => {
    await seedRealtimePanelKey('default', 'sk-from-panel')
    const dir = await tempDir()
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ asr: { dashscope_api_key: 'sk-from-wizard' } }),
      'utf-8',
    )
    const { resolveDashScopeKey } = await import(KEY_STORE)
    expect(await resolveDashScopeKey(dir)).toBe('sk-from-wizard')
  })

  it('reads config.env too (meeting wizard path) before the panel', async () => {
    await seedRealtimePanelKey('default', 'sk-from-panel')
    const dir = await tempDir()
    await writeFile(join(dir, 'config.env'), 'DASHSCOPE_API_KEY=sk-from-env-file\n', 'utf-8')
    const { resolveDashScopeKey } = await import(KEY_STORE)
    expect(await resolveDashScopeKey(dir)).toBe('sk-from-env-file')
  })

  it('falls back to the process env last', async () => {
    process.env[ENV_KEY] = 'sk-from-proc-env'
    const { resolveDashScopeKey } = await import(KEY_STORE)
    expect(await resolveDashScopeKey(await tempDir())).toBe('sk-from-proc-env')
  })

  it('returns null when nothing is configured', async () => {
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
    const { resolveDashScopeKey } = await import(KEY_STORE)
    expect(await resolveDashScopeKey(await tempDir())).toBeNull()
  })

  it('honours the profile argument (per-profile panel key)', async () => {
    await seedRealtimePanelKey('alice', 'sk-alice')
    const { resolveDashScopeKey } = await import(KEY_STORE)
    expect(await resolveDashScopeKey(await tempDir(), 'alice')).toBe('sk-alice')
    expect(await resolveDashScopeKey(await tempDir(), 'default')).toBeNull()
  })

  it('survives an uninitialised DB (early boot / pure-fs contexts)', async () => {
    // No initAllHermesTables() call: the panel lookup must throw internally and
    // degrade to "no key from the panel" instead of failing the whole resolve.
    const dir = await tempDir()
    await writeFile(join(dir, 'config.json'), JSON.stringify({ asr: { dashscope_api_key: 'sk-file' } }), 'utf-8')
    const { resolveDashScopeKey } = await import(KEY_STORE)
    expect(await resolveDashScopeKey(dir)).toBe('sk-file')
    expect(await resolveDashScopeKey(await tempDir())).toBeNull()
  })
})
