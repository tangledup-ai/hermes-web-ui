import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Koa from 'koa'
import { afterEach, expect, it, vi } from 'vitest'
import { createRequestBodyParser } from '../../packages/server/src/modules/studio/middleware/request-body-parser'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { getDeviceConsent, setDeviceConsent } from '../../packages/server/src/modules/studio/services/meeting-asr/device-consent'
import { updateMeetingTranscriptionSetting } from '../../packages/server/src/modules/studio/services/meeting-asr/transcription-settings'

afterEach(() => vi.unstubAllEnvs())

it('persists consent scoped to account, profile, and current provider', async () => {
  initAllHermesTables()
  const profile = 'test-h618-consent'
  await updateMeetingTranscriptionSetting(profile, { asrProvider: 'minimax' })
  expect(await getDeviceConsent(1, profile)).toEqual({ profile, provider: 'minimax', granted: false })
  setDeviceConsent(1, profile, 'minimax', true)
  expect((await getDeviceConsent(1, profile)).granted).toBe(true)
  expect((await getDeviceConsent(2, profile)).granted).toBe(false)
  expect((await getDeviceConsent(1, 'another-profile')).granted).toBe(false)
  await updateMeetingTranscriptionSetting(profile, { asrProvider: 'dashscope' })
  expect((await getDeviceConsent(1, profile)).granted).toBe(false)
  await updateMeetingTranscriptionSetting(profile, { asrProvider: 'minimax' })
  setDeviceConsent(1, profile, 'minimax', false)
  expect((await getDeviceConsent(1, profile)).granted).toBe(false)
})

it('keeps staged meetings hidden, checks owner for all access, and publishes only complete audio once', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'h618-device-meeting-'))
  vi.stubEnv('HERMES_WEB_UI_HOME', home)
  vi.stubEnv('MEETING_AUDIO_MAX_BYTES', '18')
  const { meetingStorageRoutes } = await import('../../packages/server/src/modules/studio/routes/meeting-storage')
  const { meetingStorageService } = await import('../../packages/server/src/modules/studio/services/meeting-storage')
  const { deviceMeetingLiveService } = await import('../../packages/server/src/modules/studio/services/meeting-asr/device-live')
  const saved = vi.spyOn(deviceMeetingLiveService, 'saved')
  const app = new Koa()
  app.use(createRequestBodyParser())
  app.use(async (ctx, next) => {
    if (ctx.get('authorization')) {
      const id = ctx.get('authorization') === 'Bearer second' ? 2 : 1
      ctx.state.user = { id, role: 'admin', profiles: ['default', 'work'] }
      ctx.state.profile = { name: ctx.get('x-hermes-profile') || 'default' }
    }
    await next()
  })
  app.use(meetingStorageRoutes.routes())
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}/api/studio/meeting-storage`
  const id = 'h618-1'
  const headers = { Authorization: 'Bearer first', 'X-Hermes-Profile': 'default' }
  const device = { ...headers, 'X-Keli-Device': 'h618' }
  const metadata = {
    id, title: 'Original', createdAt: 1234, updatedAt: 1240, audioDuration: 5,
    source: 'h618', captureStatus: 'offline', transcriptIncomplete: true, markers: [{ offsetMs: 3500 }],
  }
  function put(route: string, value: unknown, requestHeaders = device) {
    return fetch(`${base}/${id}${route}`, {
      method: 'PUT', headers: { ...requestHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    })
  }
  function audio(body: BodyInit, key = id) {
    return fetch(`${base}/${id}/device-recording`, {
      method: 'PUT',
      headers: { ...device, 'Content-Type': 'audio/webm', 'X-Keli-Idempotency-Key': key },
      body,
    })
  }
  function list(requestHeaders = headers) {
    return fetch(base, { headers: requestHeaders }).then(response => response.json())
  }

  try {
    expect((await put('', metadata, { ...device, Authorization: '' })).status).toBe(401)
    expect((await put('', { ...metadata, markers: [{ offsetMs: 6200 }] })).status).toBe(400)
    expect((await put('', metadata)).status).toBe(200)
    expect((await put('', metadata, { ...device, Authorization: 'Bearer second' })).status).toBe(404)
    expect(await list()).toEqual({ meetings: [] })
    expect((await fetch(`${base}/${id}`, { headers })).status).toBe(404)
    expect((await audio('example')).status).toBe(409)
    expect((await put('/transcript', [{ text: 'Live text', timestamp: 1235 }])).status).toBe(200)
    expect((await audio('')).status).toBe(400)
    expect((await audio('too large'.repeat(8))).status).toBe(413)
    expect(await list()).toEqual({ meetings: [] })
    expect(saved).not.toHaveBeenCalled()

    const first = await audio('example')
    expect(first.status).toBe(200)
    const expected = { status: 'ok', meetingId: id, bytes: 7, sha256: createHash('sha256').update('example').digest('hex') }
    expect(await first.json()).toEqual({ ...expected, reused: false })
    expect(await audio('different').then(response => response.json())).toEqual({ ...expected, reused: true })
    expect(saved).toHaveBeenCalledExactlyOnceWith({ userId: 1, profile: 'default' }, id, 1234)
    expect((await audio('different', 'other-key')).status).toBe(409)
    expect(await list()).toEqual({ meetings: [id] })
    expect(await list({ ...headers, 'X-Hermes-Profile': 'work' })).toEqual({ meetings: [] })
    expect((await fetch(`${base}/${id}/audio`, { headers: { ...headers, Authorization: 'Bearer second' } })).status).toBe(404)

    expect((await put('', { ...metadata, title: 'Late retry' })).status).toBe(200)
    const meeting = await fetch(`${base}/${id}`, { headers }).then(response => response.json())
    expect(meeting).toMatchObject({ ...metadata, sentences: [{ text: 'Live text', timestamp: 1235 }] })
    expect(await fetch(`${base}/${id}/audio`, { headers }).then(response => response.text())).toBe('example')
    expect((await readdir(path.join(home, 'meetings', id))).filter(name => name.endsWith('.webm'))).toEqual(['recording_device.webm'])

    // A legacy write that has checked a currently unowned ID must finish
    // before a device can claim the ID and publish there.
    const raceId = 'h618-race'
    let ready!: () => void
    const enteredLegacyWrite = new Promise<void>(resolve => { ready = resolve })
    let unblock!: () => void
    const allowLegacyWrite = new Promise<void>(resolve => { unblock = resolve })
    const saveMetadata = meetingStorageService.saveMeetingMetadata.bind(meetingStorageService)
    const pauseLegacy = vi.spyOn(meetingStorageService, 'saveMeetingMetadata').mockImplementationOnce(async (meetingId, data) => {
      ready()
      await allowLegacyWrite
      await saveMetadata(meetingId, data)
    })
    const markRequest = { ...metadata, id: raceId }
    const legacy = fetch(`${base}/${raceId}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...markRequest, source: undefined, title: 'Legacy' }),
    })
    await enteredLegacyWrite
    const concurrentStage = fetch(`${base}/${raceId}`, {
      method: 'PUT', headers: { ...device, 'Content-Type': 'application/json' },
      body: JSON.stringify(markRequest),
    })
    try {
      await expect(Promise.race([
        concurrentStage.then(response => response.status),
        new Promise(resolve => setTimeout(() => resolve('queued'), 50)),
      ])).resolves.toBe('queued')
    } finally {
      unblock()
      pauseLegacy.mockRestore()
    }
    expect((await legacy).status).toBe(200)
    expect((await concurrentStage).status).toBe(409)
    expect(await fetch(`${base}/${raceId}`, { headers }).then(response => response.json()))
      .toMatchObject({ id: raceId, title: 'Legacy' })
  } finally {
    saved.mockRestore()
    deviceMeetingLiveService.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
})
