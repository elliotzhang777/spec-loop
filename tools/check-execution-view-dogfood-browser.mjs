import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'

import { startExecutionViewServer, closeExecutionViewServer } from '../dist/execution-view-server.js'

const [projectRoot, historicalKey, outputDir] = process.argv.slice(2)
if (!projectRoot || !historicalKey || !outputDir) throw new Error('usage: node tools/check-execution-view-dogfood-browser.mjs <project-root> <historical-key> <output-dir>')
await mkdir(outputDir, { recursive: true })

const { server, url } = await startExecutionViewServer(path.resolve(projectRoot))
let browser
try {
  const catalog = await (await fetch(new URL('/api/projects', url))).json()
  const projects = ['root', historicalKey].map(key => {
    const found = catalog.projects.find(project => project.key === key)
    if (!found) throw new Error(`project ${key} is not in the local catalog`)
    return found
  })
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  const results = []
  for (const project of projects) for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.goto(url, { waitUntil: 'networkidle' })
      if (project.key !== 'root') {
        const selector = page.getByRole('combobox', { name: '切换工程' })
        await selector.click()
        await selector.fill(project.name)
        await page.locator('.ant-select-item-option').filter({ hasText: project.name }).click()
        await page.keyboard.press('Escape')
      }
      await page.locator('#project-name').getByText(project.name, { exact: true }).waitFor()
      await page.locator('#execution-view:not(.project-switching):not(.error-state)').waitFor()
      await page.locator('.ant-select-dropdown').waitFor({ state: 'hidden' })
      const renderedProjectName = await page.locator('#project-name').textContent()
      const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth)
      const screenshot = path.join(outputDir, `${project.key.replace(':', '-')}-${width}.png`)
      await page.screenshot({ path: screenshot })
      const sha256 = createHash('sha256').update(await readFile(screenshot)).digest('hex')
      const result = { project_key: project.key, project_id: project.project_id, rendered_project_name: renderedProjectName, width, document_width: documentWidth, screenshot, sha256, page_errors: errors, status: renderedProjectName === project.name && documentWidth <= width && errors.length === 0 ? 'PASS' : 'FAIL' }
      results.push(result)
    } finally { await page.close() }
  }
  const report = { schema_version: 1, project_root: path.resolve(projectRoot), browser_version: browser.version(), results, status: results.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL' }
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'PASS') process.exitCode = 1
} finally {
  if (browser) await browser.close()
  await closeExecutionViewServer(server)
}
