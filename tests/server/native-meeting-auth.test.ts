import type { Context } from 'koa'
import { beforeEach, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  ensureReady: vi.fn(async () => {}),
  pushKey: vi.fn(async () => true),
  start: vi.fn(async (_options: unknown) => {}),
}))
vi.mock('../../packages/server/src/modules/studio/services/auth/token-auth', () => ({
  getToken: async () => 'test-server-token',
}))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/http-access', () => ({
  handleSessionShareHttp: async () => false,
}))
vi.mock('../../packages/server/src/modules/studio/services/realtime-backend', () => ({
  ensureRealtimeBackendReady: runtime.ensureReady,
}))
vi.mock('../../packages/server/src/modules/studio/services/meeting-asr', () => ({
  meetingASRService: {
    start: runtime.start,
    ensureDashScopeKeyPushed: runtime.pushKey,
    status: { isRunning: true },
  },
}))

import { startASRService } from '../../packages/server/src/modules/studio/controllers/meeting-asr'
import { requireUserJwt } from '../../packages/server/src/modules/studio/middleware/auth'

const token = 'test-server-token'
const asr = '/api/studio/meeting-asr'
const storage = '/api/studio/meeting-storage'
const meeting = `${storage}/726c1e67-5486-4037-9fa6-e63efeb82850`

function request(method: string, path: string, options: {
  address?: string
  origin?: string
  authorization?: string
  queryToken?: string
} = {}): Context {
  return {
    method, path, status: 200, state: {}, query: { token: options.queryToken },
    headers: {
      authorization: options.authorization ?? `Bearer ${token}`,
      origin: options.origin,
    },
    ip: '127.0.0.1',
    request: { ip: '127.0.0.1', body: { dashscopeApiKey: 'untrusted', dataDir: '/untrusted' } },
    req: { socket: { remoteAddress: options.address ?? '127.0.0.1' } },
  } as unknown as Context
}

beforeEach(() => { vi.clearAllMocks() })

it.each([
  ['POST', `${asr}/start`],
  ['GET', `${asr}/status`],
  ['PUT', meeting],
  ['PUT', `${meeting}/transcript`],
  ['POST', `${meeting}/audio`],
])('accepts the native bearer on loopback for %s %s', async (method, path) => {
  const ctx = request(method, path, { address: '::ffff:127.0.0.1' })
  const next = vi.fn(async () => {})
  await requireUserJwt(ctx, next)
  expect(next).toHaveBeenCalledOnce()
  expect(ctx.state.serverTokenAuth).toBe(true)
})

it.each([
  ['POST', `${asr}/stop`],
  ['POST', `${asr}/config/current`],
  ['GET', storage],
  ['GET', `${meeting}/audio`],
  ['DELETE', meeting],
  ['PUT', `${meeting}/json`],
  ['PUT', `${storage}/%2e%2e`],
])('denies the native bearer for %s %s', async (method, path) => {
  const ctx = request(method, path)
  const next = vi.fn(async () => {})
  await requireUserJwt(ctx, next)
  expect(ctx.status).toBe(401)
  expect(next).not.toHaveBeenCalled()
})

it.each([
  { address: '192.0.2.12' },
  { origin: 'http://127.0.0.1:6060' },
  { authorization: '', queryToken: token },
  { authorization: 'Bearer incorrect-token' },
])('requires a native loopback peer and the valid token in its bearer header: %j', async options => {
  const ctx = request('POST', `${asr}/start`, options)
  const next = vi.fn(async () => {})
  await requireUserJwt(ctx, next)
  expect(ctx.status).toBe(401)
  expect(next).not.toHaveBeenCalled()
})

it('starts ASR from saved settings for a native request', async () => {
  const ctx = request('POST', `${asr}/start`)
  await requireUserJwt(ctx, () => startASRService(ctx))
  expect(runtime.ensureReady).toHaveBeenCalledOnce()
  expect(runtime.pushKey).toHaveBeenCalledOnce()
  expect(runtime.start).not.toHaveBeenCalled()
  expect(ctx.body).toEqual({ status: 'started', isRunning: true })
})
