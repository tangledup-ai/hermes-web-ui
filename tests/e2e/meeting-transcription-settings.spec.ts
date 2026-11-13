import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import type { MeetingTranscriptionPatch, MeetingTranscriptionSetting } from '../../packages/client/src/api/studio/meeting-transcription'

test('model settings save the selected profile transcription defaults and write credentials only when edited', async ({ page }) => {
  const baseSetting: MeetingTranscriptionSetting = {
    saved: true,
    asrProvider: 'dashscope',
    asrModel: 'paraformer-v2',
    paraformerModel: 'paraformer-realtime-v2',
    minimaxAsrModel: 'asr-1.0',
    minimaxBaseUrl: 'https://api.minimaxi.com',
    dashscopeKeyConfigured: true,
    minimaxKeyConfigured: false,
    ossBucket: '',
    ossEndpoint: '',
    ossPathPrefix: '',
    ossAccessKeyIdConfigured: false,
    ossAccessKeySecretConfigured: false,
    ossConfigured: false,
  }
  let setting = { ...baseSetting }
  const updates: MeetingTranscriptionPatch[] = []
  const requests: Array<string | null> = []

  await page.addInitScript(() => {
    ;(window as Window & { __APP_VERSION__?: string }).__APP_VERSION__ = 'test'
    localStorage.setItem('hermes_api_key', `test.${btoa(JSON.stringify({ sub: '1', role: 'super_admin' }))}.fixture`)
    localStorage.setItem('hermes_locale', 'en')
    localStorage.setItem('hermes_active_profile_name', 'default')
  })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/hermes/profiles') {
      return route.fulfill({ json: { profiles: [
        { name: 'default', alias: 'Default', active: true, model: 'test' },
        { name: 'meetings', alias: 'Meetings', active: false, model: 'test' },
      ] } })
    }
    if (url.pathname === '/api/studio/models/meeting-transcription') {
      requests.push(url.searchParams.get('profile'))
      if (request.method() === 'PUT') {
        const patch = request.postDataJSON() as MeetingTranscriptionPatch
        updates.push(patch)
        setting = {
          ...setting,
          asrProvider: patch.asrProvider ?? setting.asrProvider,
          minimaxKeyConfigured: patch.minimaxApiKey === undefined ? setting.minimaxKeyConfigured : !!patch.minimaxApiKey,
        }
      }
      return route.fulfill({ json: { setting } })
    }
    return route.fulfill({ json: {} })
  })
  const fixture = '/@fs/' + resolve('tests/e2e/fixtures/local-capabilities.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__meeting_settings__', route => route.fulfill({
    contentType: 'text/html',
    body: `<div id="app"></div><script type="module" src="${fixture}"></script>`,
  }))

  await page.goto('/__meeting_settings__#/hermes/models?tab=stt&modelProfile=meetings')
  const form = page.getByRole('region', { name: 'Meeting transcription' })
  await expect(form.getByLabel('DashScope API key')).toHaveValue('')
  await expect(form.getByPlaceholder('Leave blank to keep the configured credential')).toHaveCount(1)
  await form.getByRole('radiogroup').getByText('MiniMax', { exact: true }).click()
  await expect(form.getByRole('radio', { name: 'MiniMax', exact: true })).toBeChecked()
  await form.getByLabel('MiniMax API Key').fill('fixture-minimax-key')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => updates).toEqual([{ asrProvider: 'minimax', minimaxApiKey: 'fixture-minimax-key' }])
  await expect(form.getByLabel('MiniMax API Key')).toHaveValue('')

  await page.reload()
  await expect(form.getByPlaceholder('Leave blank to keep the configured credential')).toHaveCount(2)
  const miniMax = form.getByRole('region', { name: 'MiniMax' })
  await miniMax.getByText('Remove credential on save', { exact: true }).click()
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => updates[1]).toEqual({ minimaxApiKey: '' })
  expect(requests).toEqual(['meetings', 'meetings', 'meetings', 'meetings'])
})
