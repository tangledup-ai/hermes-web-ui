import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('review H618 provider consent and discover a synced recording on focus', async ({ page }) => {
  const deviceMeetingId = 'h618-test-123'
  const updates: unknown[] = []
  const transcripts: unknown[] = []
  let granted = false
  let published = false
  let holdAsrStart = false
  let releaseAsrStart: () => void = () => {}
  const heldAsrStart = new Promise<void>(resolve => { releaseAsrStart = resolve })
  let fileUploads = 0

  await page.addInitScript(() => {
    localStorage.setItem('hermes_api_key', `test.${btoa(JSON.stringify({ sub: '1', role: 'super_admin' }))}.fixture`)
    localStorage.setItem('hermes_locale', 'en')
    localStorage.setItem('hermes_active_profile_name', 'default')
    class TestAudio {
      duration = 6
      currentTime = 0
      constructor() {
        queueMicrotask(() => (this as TestAudio & { onloadedmetadata?: () => void }).onloadedmetadata?.())
      }
      play() {
        Reflect.set(window, '__h618PlayedAt', this.currentTime)
        return Promise.resolve()
      }
      pause() {}
    }
    Reflect.set(window, 'Audio', TestAudio)
  })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const req = route.request()
    const pathname = new URL(req.url()).pathname
    if (pathname === '/api/hermes/profiles') {
      return route.fulfill({ json: { profiles: [{ name: 'default', active: true, alias: 'Default' }] } })
    }
    if (pathname === '/api/studio/meeting-asr/device-consent') {
      expect(req.headers()['x-hermes-profile']).toBe('default')
      if (req.method() === 'PUT') {
        const patch = req.postDataJSON() as { provider: string; granted: boolean }
        updates.push(patch)
        granted = patch.granted
      }
      return route.fulfill({ json: { provider: 'minimax', profile: 'default', granted } })
    }
    if (pathname === '/api/studio/models/meeting-transcription') {
      return route.fulfill({ json: { setting: { saved: true, asrProvider: 'minimax', minimaxKeyConfigured: true } } })
    }
    if (pathname === '/api/studio/meeting-asr/start') {
      if (holdAsrStart) await heldAsrStart
      return route.fulfill({ json: { status: 'started' } }).catch(error => {
        if (!holdAsrStart) throw error
      })
    }
    if (pathname === '/api/studio/meeting-asr/transcribe/file') {
      fileUploads += 1
      expect(new URL(req.url()).searchParams.get('sessionId')).toBe(deviceMeetingId)
      return route.fulfill({ json: { job_id: 'meeting-job', status: 'pending' } })
    }
    if (pathname.endsWith('/transcribe/status/meeting-job')) {
      return route.fulfill({ json: {
        status: 'done', progress: 1,
        result: { duration_sec: 6, sentences: [{ text: 'Complete transcript', begin_ms: 1000, end_ms: 4300 }] },
      } })
    }
    if (pathname === '/api/studio/meeting-storage') {
      return route.fulfill({ json: { meetings: published ? [deviceMeetingId] : [] } })
    }
    if (pathname === `/api/studio/meeting-storage/${deviceMeetingId}`) {
      if (req.method() === 'PUT') {
        expect(req.postDataJSON()).toMatchObject({ transcriptIncomplete: false, markers: [{ offsetMs: 3000 }] })
        return route.fulfill({ json: { status: 'ok' } })
      }
      return route.fulfill({ json: {
        id: deviceMeetingId, source: 'h618', title: 'Device meeting test', audioDuration: 6,
        createdAt: 1, updatedAt: 2, markers: [{ offsetMs: 3000 }], transcriptIncomplete: true,
        status: 'completed', sentences: [{ text: 'Device transcript', timestamp: 1, startTime: 3000 }],
      } })
    }
    if (pathname.endsWith('/transcript') && req.method() === 'PUT') {
      transcripts.push(req.postDataJSON())
      return route.fulfill({ json: { status: 'ok' } })
    }
    if (pathname.endsWith('/audio')) return route.fulfill({ contentType: 'audio/webm', body: 'audio fixture' })
    return route.fulfill({ json: {} })
  })

  const fixture = '/@fs/' + resolve('tests/e2e/fixtures/local-capabilities.ts').replaceAll('\\', '/').replace(/^\//, '')
  const clientModule = '/@fs/' + resolve('packages/client/src/api/client.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__h618_meeting__', route => route.fulfill({
    contentType: 'text/html',
    body: `<div id="app"></div><script type="module">
      import { setApiKey } from ${JSON.stringify(clientModule)}
      window.__h618SetApiKey = setApiKey
      await import(${JSON.stringify(fixture)})
    </script>`,
  }))
  await page.goto('/__h618_meeting__#/hermes/meeting')
  await page.getByTestId('meeting-device-consent').click()
  await expect(page.getByRole('dialog')).toContainText('sends meeting audio to MiniMax')
  const consentButton = page.getByTestId('meeting-device-consent-toggle')
  await consentButton.click()
  await expect(consentButton).toHaveText('Revoke')
  await consentButton.click()
  await expect(consentButton).toHaveText('Allow live transcription')
  expect(updates).toEqual([
    { provider: 'minimax', granted: true },
    { provider: 'minimax', granted: false },
  ])
  await page.keyboard.press('Escape')

  published = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByText('Device meeting test', { exact: true }).click()
  const marker = page.getByTestId('meeting-device-marker')
  await expect(marker).toHaveAccessibleName('Play from 00:03')
  await marker.click()
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__h618PlayedAt'))).toBe(3)
  await expect(page.getByText('Device transcript', { exact: true })).toBeVisible()
  await page.getByTestId('meeting-device-retranscribe').click()
  await expect(page.getByText('Send the recording to MiniMax and replace the transcript on success?')).toBeVisible()
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.getByText('Complete transcript', { exact: true })).toBeVisible()
  await expect(page.getByText('Device transcript', { exact: true })).toHaveCount(0)
  await expect(marker).toBeVisible()
  await expect.poll(() => transcripts).toEqual([[expect.objectContaining({ text: 'Complete transcript' })]])
  const cached = await page.evaluate(() => localStorage.getItem('hermes.meeting.sessions'))
  expect(cached).not.toContain(deviceMeetingId)

  // A fresh load has the original incomplete fixture. Switch accounts while
  // ASR startup is pending and verify the old recording cannot be uploaded.
  await page.getByText('Device meeting test', { exact: true }).click()
  await expect(page.getByTestId('meeting-device-retranscribe')).toBeEnabled()
  holdAsrStart = true
  await page.getByTestId('meeting-device-retranscribe').click()
  const startRequested = page.waitForRequest(request =>
    new URL(request.url()).pathname === '/api/studio/meeting-asr/start')
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await startRequested
  await page.evaluate(() => {
    const setApiKey = Reflect.get(window, '__h618SetApiKey') as (key: string) => void
    setApiKey(`test.${btoa(JSON.stringify({ sub: '2', role: 'super_admin' }))}.fixture`)
  })
  await expect(page.getByText('Device meeting test', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('meeting-device-marker')).toHaveCount(0)
  releaseAsrStart()
  await expect(page.getByTestId('meeting-device-retranscribe')).toHaveCount(0)
  await expect.poll(() => fileUploads, { timeout: 500 }).toBe(1)
})
