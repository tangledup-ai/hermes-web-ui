import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { saveRealtimeModelSetting } from '../../packages/server/src/modules/studio/repositories/realtime-settings-store'
import {
  meetingTranscriptionRequestContext,
  prepareLegacyMeetingTranscriptionSave,
  readMeetingTranscriptionSetting,
  TRANSCRIPTION_CONTEXT_HEADER,
  updateMeetingTranscriptionSetting,
} from '../../packages/server/src/modules/studio/services/meeting-asr/transcription-settings'

let dataDir: string

beforeAll(async () => {
  initAllHermesTables()
  dataDir = await mkdtemp(path.join(tmpdir(), 'meeting-transcription-test-'))
  vi.stubEnv('MEETING_ASR_DATA_DIR', dataDir)
  await writeFile(path.join(dataDir, 'config.env'), 'DASHSCOPE_API_KEY="fixture-device-key"\n')
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ asr: { paraformer_model: 'legacy-realtime-asr' } }))
  saveRealtimeModelSetting('work', {
    settings: { asrProvider: 'minimax', minimaxAsrModel: 'legacy-minimax-asr' },
    secrets: { minimaxApiKey: 'fixture-work-key' },
  })
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(dataDir, { recursive: true, force: true })
})

async function contextFor(profile: string, userId: number) {
  const { headers } = await meetingTranscriptionRequestContext(profile, userId)
  return JSON.parse(Buffer.from(headers[TRANSCRIPTION_CONTEXT_HEADER], 'base64url').toString('utf8'))
}

it('recovers only the selected profile configuration and exposes key availability without keys', async () => {
  const [device, work] = await Promise.all([readMeetingTranscriptionSetting('default'), readMeetingTranscriptionSetting('work')])
  expect(device).toMatchObject({ saved: false, dashscopeKeyConfigured: true, minimaxKeyConfigured: false, paraformerModel: 'legacy-realtime-asr' })
  expect(work).toMatchObject({ saved: false, dashscopeKeyConfigured: false, minimaxKeyConfigured: true, asrProvider: 'minimax', minimaxAsrModel: 'legacy-minimax-asr' })
  expect(JSON.stringify([device, work])).not.toContain('fixture-')

  const [deviceContext, workContext] = await Promise.all([contextFor('default', 1), contextFor('work', 2)])
  expect(deviceContext).toMatchObject({ owner: '["default",1]', settings: { dashscope_api_key: 'fixture-device-key', minimax_api_key: '' } })
  expect(workContext).toMatchObject({ owner: '["work",2]', settings: { dashscope_api_key: '', minimax_api_key: 'fixture-work-key' } })
})

it('merges partial saves, accepts browser-only settings once and honors a later explicit key clear', async () => {
  saveRealtimeModelSetting('migration', { secrets: { minimaxApiKey: 'fixture-server-key' } })
  const first = await updateMeetingTranscriptionSetting('migration', {
    migrateLegacy: true,
    minimaxApiKey: 'fixture-stale-browser-key',
    dashscopeApiKey: 'fixture-browser-key',
    paraformerWsUrl: 'http://legacy-invalid.example',
  })
  expect(first).toMatchObject({ saved: true, dashscopeKeyConfigured: true, minimaxKeyConfigured: true })
  const added = await contextFor('migration', 1)
  expect(added.settings).toMatchObject({ minimax_api_key: 'fixture-server-key', dashscope_api_key: 'fixture-browser-key' })

  await Promise.all([
    updateMeetingTranscriptionSetting('migration', { minimaxApiKey: '', asrProvider: 'minimax' }),
    updateMeetingTranscriptionSetting('migration', { ossBucket: 'meeting-recordings', ossAccessKeyId: 'fixture-id', ossAccessKeySecret: 'fixture-secret' }),
  ])
  const second = await updateMeetingTranscriptionSetting('migration', { migrateLegacy: true, minimaxApiKey: 'fixture-resurrected-key' })
  expect(second).toMatchObject({ asrProvider: 'minimax', minimaxKeyConfigured: false, dashscopeKeyConfigured: true, ossConfigured: true })
  expect(JSON.stringify(second)).not.toContain('fixture-')
  expect((await contextFor('migration', 1)).settings.minimax_api_key).toBe('')
})

it('accepts official endpoints for profile users and requires administrator access for custom endpoints', async () => {
  const official = await updateMeetingTranscriptionSetting('endpoints', { minimaxBaseUrl: 'https://api.minimax.io' })
  expect(official.minimaxBaseUrl).toBe('https://api.minimax.io')
  await expect(updateMeetingTranscriptionSetting('endpoints', { minimaxBaseUrl: 'https://127.0.0.1' })).rejects.toMatchObject({ status: 403 })
  await expect(updateMeetingTranscriptionSetting('endpoints', { minimaxBaseUrl: 'https://user:pass@provider.example' }, true)).rejects.toMatchObject({ status: 400 })
  const custom = await updateMeetingTranscriptionSetting('endpoints', { minimaxBaseUrl: 'https://transcription.example' }, true)
  expect(custom.minimaxBaseUrl).toBe('https://transcription.example')
})

it('keeps released-client writes until model settings are saved and preserves them during browser migration', async () => {
  const profile = 'released-client'
  prepareLegacyMeetingTranscriptionSave(profile, { dashscopeApiKey: 'fixture-older-client' })()
  expect(await readMeetingTranscriptionSetting(profile)).toMatchObject({ saved: false, dashscopeKeyConfigured: true })
  await updateMeetingTranscriptionSetting(profile, { migrateLegacy: true, dashscopeApiKey: 'fixture-browser-key', minimaxApiKey: 'fixture-minimax' })
  const context = await contextFor(profile, 1)
  expect(context.settings).toMatchObject({ dashscope_api_key: 'fixture-older-client', minimax_api_key: 'fixture-minimax' })
  await updateMeetingTranscriptionSetting(profile, { dashscopeApiKey: '' })
  prepareLegacyMeetingTranscriptionSave(profile, { dashscopeApiKey: 'fixture-older-client' })()
  expect(await readMeetingTranscriptionSetting(profile)).toMatchObject({ saved: true, dashscopeKeyConfigured: false })
})
