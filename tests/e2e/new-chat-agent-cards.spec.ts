import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'

test('keeps the new-chat carousel interactive without an idle DOM animation loop', async ({ page }) => {
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/new-chat-agent-cards.ts').replace(/^\//, '')
  await page.route('**/__new_chat_agent_cards__', route => route.fulfill({
    contentType: 'text/html',
    body: `<div id="app"></div><script type="module" src="${entry}"></script>`,
  }))
  await page.goto('/__new_chat_agent_cards__')

  const carousel = page.getByLabel('Agent', { exact: true })
  const hermes = carousel.getByRole('button', { name: 'Hermes', pressed: true })
  await expect(hermes).toBeVisible()
  // Native effects are still active, but idle JS should not change DOM styles.
  const animationCount = () => carousel.evaluate(el =>
    el.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSAnimation).length)
  await expect.poll(animationCount).toBeGreaterThan(0)
  const idleStyleWrites = await carousel.evaluate(async (el) => {
    let writes = 0
    const observer = new MutationObserver(records => { writes += records.length })
    observer.observe(el, { attributes: true, subtree: true, attributeFilter: ['style'] })
    await new Promise<void>(resolve => setTimeout(resolve, 250))
    observer.disconnect()
    return writes
  })
  expect(idleStyleWrites).toBe(0)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(animationCount).toBe(0)
  await hermes.press('ArrowRight')
  const ekko = carousel.getByRole('button', { name: 'Ekko', pressed: true })
  await expect(ekko).toBeFocused()

  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(animationCount).toBeGreaterThan(0)
  await expect(ekko).toBeFocused()
})
