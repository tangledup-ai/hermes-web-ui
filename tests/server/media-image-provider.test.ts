import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'koa'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readConfigYamlForProfile } = vi.hoisted(() => ({ readConfigYamlForProfile: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/media-profile-config', () => ({ readConfigYamlForProfile }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getActiveProfileName: () => 'default',
  listProfileNamesFromDisk: () => ['default'],
}))

import { apiKeyImageGenerate } from '../../packages/server/src/modules/studio/controllers/media'

let directory: string
let fetchImage: ReturnType<typeof vi.fn>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'studio-image-provider-'))
  readConfigYamlForProfile.mockReset()
  fetchImage = vi.fn(async () => new Response('data: {"b64_json":"aW1hZ2U="}\n\n'))
  vi.stubGlobal('fetch', fetchImage)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

function imageRequest(provider?: string): Context {
  return {
    get: () => '',
    state: { serverTokenAuth: true },
    query: {},
    request: { body: { prompt: 'A sample image', provider, output_path: join(directory, 'image.png') } },
  } as unknown as Context
}

describe('Studio image provider selection', () => {
  const existingConfig = {
    custom_providers: [{ name: 'legacy-custom-provider', base_url: 'https://images.example/v1', api_key: 'fixture-only' }],
  }

  it('requires an auxiliary route or explicit provider before contacting an external service', async () => {
    readConfigYamlForProfile.mockResolvedValue(existingConfig)
    const ctx = imageRequest()
    await apiKeyImageGenerate(ctx)
    expect(ctx.status).toBe(400)
    expect(ctx.body).toMatchObject({ code: 'image_provider_not_configured' })
    expect(fetchImage).not.toHaveBeenCalled()
  })

  it.each(['auxiliary', 'explicit'])('uses an existing custom provider selected via %s', async source => {
    const provider = 'custom:legacy-custom-provider'
    readConfigYamlForProfile.mockResolvedValue(source === 'auxiliary' ? {
      ...existingConfig,
      auxiliary: { image_generation: { provider } },
    } : existingConfig)
    const ctx = imageRequest(source === 'explicit' ? provider : undefined)
    await apiKeyImageGenerate(ctx)
    expect(ctx.body).toMatchObject({ ok: true, provider: 'legacy-custom-provider' })
    expect(fetchImage).toHaveBeenCalledWith('https://images.example/v1/images/generations', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer fixture-only' }),
    }))
    expect(await readFile(join(directory, 'image.png'), 'utf8')).toBe('image')
  })
})
