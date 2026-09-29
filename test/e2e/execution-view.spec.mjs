import { test, expect, chromium } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { startExecutionViewServer, closeExecutionViewServer } from '../../dist/execution-view-server.js'

let root, server, url

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'spec-loop-view-e2e-'))
  const repository = path.join(root, 'repo')
  await mkdir(repository)
  for (const args of [
    ['project', 'init', root, '--id', 'PROJ-VIEW-E2E', '--name', 'Execution View E2E', '--repository', repository],
    ['init', path.join(root, '.spec-loop', 'tasks', 'task-view-e2e'), '--level', 'standard', '--id', 'TASK-VIEW-E2E', '--title', 'Inspect current task', '--repository', repository],
  ]) {
    const result = spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: process.cwd(), encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  }
  ;({ server, url } = await startExecutionViewServer(root, { port: 0 }))
})

test.afterAll(async () => {
  if (server) await closeExecutionViewServer(server)
  if (root) await rm(root, { recursive: true, force: true })
})

test('desktop and 390px execution view show the current Task without browser errors', async ({}, testInfo) => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(url, { waitUntil: 'networkidle' })
    await expect(page.locator('body')).toContainText('TASK-VIEW-E2E')
    await expect(page.getByRole('combobox', { name: '切换工程' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('body')).toContainText('TASK-VIEW-E2E')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
    const selector = await page.locator('.project-switcher').boundingBox()
    const connection = await page.locator('.connection-status').boundingBox()
    expect(selector.x + selector.width).toBeLessThanOrEqual(connection.x)
    expect(connection.x + connection.width).toBeLessThanOrEqual(390)
    await page.screenshot({ path: testInfo.outputPath('narrow.png'), fullPage: true })
    for (const width of [820, 900, 921]) {
      await page.setViewportSize({ width, height: 900 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width)
    }
    expect(errors).toEqual([])
    await page.close()
  } finally {
    await browser.close()
  }
})

test('untrusted project name renders as text and cannot execute browser code', async () => {
  const xssRoot = await mkdtemp(path.join(tmpdir(), 'spec-loop-view-xss-'))
  const repository = path.join(xssRoot, 'repo')
  const payload = '<img src=x onerror="window.__executionViewXss=1">'
  let xssServer, xssUrl, browser
  try {
    await mkdir(repository)
    const init = spawnSync(process.execPath, [
      'dist/cli.js', 'project', 'init', xssRoot, '--id', 'PROJ-VIEW-XSS', '--name', payload, '--repository', repository,
    ], { cwd: process.cwd(), encoding: 'utf8' })
    expect(init.status, init.stderr).toBe(0)
    ;({ server: xssServer, url: xssUrl } = await startExecutionViewServer(xssRoot, { port: 0 }))
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
    const page = await browser.newPage()
    await page.goto(xssUrl, { waitUntil: 'networkidle' })
    await expect(page.locator('#project-name')).toHaveText(payload)
    expect(await page.evaluate(() => window.__executionViewXss)).toBeUndefined()
    expect(await page.locator('#execution-view img').count()).toBe(0)
  } finally {
    if (browser) await browser.close()
    if (xssServer) await closeExecutionViewServer(xssServer)
    await rm(xssRoot, { recursive: true, force: true })
  }
})
