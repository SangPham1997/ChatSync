// E2E: diff2html renders unified diff fixture in real Chromium.
// Does NOT import src/review/render.ts -- that wires DOMPurify (needs window).
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { html as diff2htmlHtml } from 'diff2html'

const FIXTURE = readFileSync(
  join(process.cwd(), 'test', 'fixtures', 'review', 'unified.diff'),
  'utf8'
)

test('diff2html renders unified diff under Chromium', async ({ page }) => {
  const diffHtml = diff2htmlHtml(FIXTURE, {
    drawFileList: true,
    matching: 'lines',
    outputFormat: 'side-by-side',
  })

  const wrapper = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="chatsync-review"><section class="diff">${diffHtml}</section></div>
</body></html>`

  await page.setContent(wrapper)

  await expect(page.locator('.chatsync-review')).toBeVisible()
  await expect(page.locator('.chatsync-review .diff')).toBeVisible()
  await expect(page.locator('.d2h-file-header')).toBeVisible()
  await expect(page.locator('.d2h-file-wrapper')).toBeVisible()
})