import { test, expect } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

test('meeting TRPG cards, reference images and generated highlights persist separately', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await page.route('**/api/meeting-storage/**', route => route.fulfill({ status: 404, json: {} }))
  await page.route('**/api/meeting-storage/*/recaps', route => route.fulfill({ json: { recaps: [] } }))
  await page.route('**/api/meeting-asr/status', route => route.fulfill({ json: { isRunning: false } }))
  await page.addInitScript(() => {
    localStorage.setItem('hermes.meeting.asrConfig', JSON.stringify({ llmApiKey: 'test-meeting-key', llmBaseUrl: 'https://meeting.invalid/v1', llmModel: 'meeting-model' }))
    if (!localStorage.getItem('hermes.meeting.sessions')) localStorage.setItem('hermes.meeting.sessions', JSON.stringify([{
      id: 'trpg-demo', title: 'TRPG Demo', createdAt: Date.now(), updatedAt: Date.now(), sentences: [{ text: '银月举起盾牌挡住箭矢。', timestamp: Date.now() }],
      speakers: [], speakerMap: {}, status: 'completed', sceneTemplate: 'trpg', analysisResult: null, htmlContent: '', analysisRounds: [],
      analysisMode: 'custom', analysisTriggerMode: 'sentences', analysisIntervalSentences: 10, analysisIntervalSeconds: 30,
      agentMessages: [], agentStatus: 'idle', agentConfig: { agentType: 'hermes' }, audioDuration: 0,
    }]))
  })
  let sent: any
  let imageRequest: any
  await page.route('**/api/hermes/media/apikey-image-generate', async route => {
    imageRequest = route.request().postDataJSON()
    await route.fulfill({ json: { images: ['iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNoSFAAIgYFgwAgAgAZzgNBlEB2pgAAAABJRU5ErkJggg=='] } })
  })
  await page.route('**/api/plugins/trpg/highlight', async route => {
    sent = route.request().postDataJSON()
    await route.fulfill({ json: { prompt: '【银月】：举盾挡箭，月光映照银发。', actions: [{ characterId: sent.characters[0].id, name: '【银月】', action: '举盾挡箭', evidence: sent.transcript }] } })
  })
  await page.goto('/#/hermes/meeting')
  await page.getByText('TRPG Demo', { exact: true }).click()
  const panel = page.getByTestId('trpg-panel')
  await panel.getByRole('button', { name: 'Add character' }).click()
  await panel.getByLabel('Character name', { exact: true }).fill('银月')
  await panel.getByLabel('Public visual appearance', { exact: true }).fill('银发精灵')
  await panel.locator('.portrait-tools input[type=file]').setInputFiles({ name: 'elf.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNoSFAAIgYFgwAgAgAZzgNBlEB2pgAAAABJRU5ErkJggg==', 'base64') })
  await expect(panel.locator('img')).toBeVisible()
  await panel.getByRole('button', { name: 'Generate image prompt' }).click()
  await expect(panel.locator('.highlight-card')).toHaveCount(1)
  await panel.getByRole('button', { name: 'Open scene details' }).click()
  await expect(page.getByLabel('Image prompt', { exact: true })).toHaveValue('【银月】：举盾挡箭，月光映照银发。')
  await page.keyboard.press('Escape')
  expect(sent.transcript).toContain('银月举起盾牌挡住箭矢。')
  expect(sent.characters[0].image).toBeUndefined()
  expect(sent.llmConfig.model).toBe('meeting-model')
  expect(imageRequest).toBeUndefined()
  await panel.evaluate(el => { el.scrollTop = 0 })
  await panel.screenshot({ path: '/tmp/trpg-panel.png', animations: 'disabled' })
  await expect(panel.getByRole('status')).toHaveText('Saved in this browser')
  await page.reload()
  await page.getByText('TRPG Demo', { exact: true }).click()
  await panel.locator('.character-card > summary').click()
  await expect(panel.getByLabel('Character name', { exact: true })).toHaveValue('银月')
  await expect(panel.locator('img')).toBeVisible()
  await expect(panel.locator('.highlight-card')).toHaveCount(1)
  await panel.getByText('Image generation settings', { exact: false }).click()
  await panel.getByLabel('Generate the image directly', { exact: true }).check()
  await panel.getByRole('button', { name: 'Generate scene image' }).click()
  await expect(panel.locator('.highlight-card img')).toBeVisible()
  expect(imageRequest.return_base64).toBe(true)
  expect(imageRequest.reference_images).toHaveLength(1)
  expect(imageRequest.prompt).toContain('【银月】')
  await expect(page.getByLabel('Image prompt', { exact: true })).toHaveCount(0)
  await panel.evaluate(el => { el.scrollTop = 0 })
  await panel.screenshot({ path: '/tmp/trpg-panel.png', animations: 'disabled' })
  await panel.locator('.highlight-card').first().getByRole('button', { name: 'Remove', exact: true }).click()
  await panel.locator('.highlight-card').first().getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(panel.locator('article')).toHaveCount(0)
  await expect(panel.getByRole('status')).toHaveText('Saved in this browser')
})
