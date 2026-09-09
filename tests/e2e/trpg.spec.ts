import { test, expect } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

test('meeting TRPG cards, reference images and generated highlights persist separately', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await page.route('**/api/meeting-storage/**', route => route.fulfill({ status: 404, json: {} }))
  await page.route('**/api/meeting-asr/status', route => route.fulfill({ json: { isRunning: false } }))
  await page.addInitScript(() => {
    if (!localStorage.getItem('hermes.meeting.sessions')) localStorage.setItem('hermes.meeting.sessions', JSON.stringify([{
      id: 'trpg-demo', title: 'TRPG Demo', createdAt: Date.now(), updatedAt: Date.now(), sentences: [{ text: '银月举起盾牌挡住箭矢。', timestamp: Date.now() }],
      speakers: [], speakerMap: {}, status: 'completed', sceneTemplate: 'general', analysisResult: null, htmlContent: '', analysisRounds: [],
      analysisMode: 'custom', analysisTriggerMode: 'sentences', analysisIntervalSentences: 10, analysisIntervalSeconds: 30,
      agentMessages: [], agentStatus: 'idle', agentConfig: { agentType: 'hermes' }, audioDuration: 0,
    }]))
  })
  let sent: any
  await page.route('**/api/plugins/trpg/highlight', async route => {
    sent = route.request().postDataJSON()
    await route.fulfill({ json: { prompt: '【银月】：举盾挡箭，月光映照银发。', actions: [{ characterId: sent.characters[0].id, name: '【银月】', action: '举盾挡箭', evidence: sent.transcript }] } })
  })
  await page.goto('/#/hermes/meeting')
  await page.getByText('TRPG Demo', { exact: true }).click()
  await page.locator('.right-panel-header select').selectOption('trpg')
  const panel = page.getByTestId('trpg-panel')
  await panel.getByRole('button', { name: 'Add character', exact: true }).click()
  await panel.getByLabel('Character name', { exact: true }).fill('银月')
  await panel.getByLabel('Public visual appearance', { exact: true }).fill('银发精灵')
  await panel.locator('input[type=file]').setInputFiles({ name: 'elf.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=', 'base64') })
  await expect(panel.locator('img')).toBeVisible()
  await panel.getByRole('button', { name: 'Generate image prompt', exact: true }).click()
  await expect(panel.locator('article textarea')).toHaveValue('【银月】：举盾挡箭，月光映照银发。')
  expect(sent.transcript).toContain('银月举起盾牌挡住箭矢。')
  expect(sent.characters[0].image).toBeUndefined()
  await panel.screenshot({ path: '/tmp/trpg-panel.png' })
  await expect(panel.getByRole('status')).toHaveText('Saved in this browser')
  await page.reload()
  await page.getByText('TRPG Demo', { exact: true }).click()
  await page.locator('.right-panel-header select').selectOption('trpg')
  await expect(panel.getByLabel('Character name', { exact: true })).toHaveValue('银月')
  await expect(panel.locator('img')).toBeVisible()
  await expect(panel.locator('article textarea')).toHaveValue('【银月】：举盾挡箭，月光映照银发。')
  await panel.locator('article').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(panel.locator('article')).toHaveCount(0)
  await expect(panel.getByRole('status')).toHaveText('Saved in this browser')
})
