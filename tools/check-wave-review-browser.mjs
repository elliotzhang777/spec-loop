import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { waveFixture, git } from '../test/wave-review.helpers.mjs'
import { runReadyWave } from '../dist/scheduler-control.js'
import { readAcceptanceRun } from '../dist/acceptance-loop.js'
import { refreshWaveReview, readWaveReview } from '../dist/wave-review.js'
import { requestVisualReview } from '../dist/review.js'
import { startExecutionViewServer, closeExecutionViewServer } from '../dist/execution-view-server.js'
import { stopManagedSchedulerSupervisor } from '../dist/scheduler-supervisor.js'

// Run after npm run build. A locally installed Playwright module/browser may
// be supplied without modifying the target project's dependencies.
const { chromium } = await import(process.env.SPEC_LOOP_PLAYWRIGHT_MODULE ?? 'playwright')
const output = path.resolve(process.env.SPEC_LOOP_BROWSER_OUTPUT ?? '.spec-loop/output/wave-review-browser')
await mkdir(output, { recursive: true })
const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const sourceFiles=['src/wave-review.ts','src/wave-phases.ts','src/scheduler-control.ts','src/scheduler-stops.ts','src/acceptance-loop.ts','src/role-orchestrator.ts','src/review.ts','src/execution-view-server.ts','src/execution-view.ts','assets/execution-view/controls.jsx','assets/execution-view/controls.js','assets/execution-view/style.css','assets/execution-view/index.html','tools/build-execution-view.mjs','tools/check-wave-review-browser.mjs','test/wave-review.test.mjs','test/wave-phases.test.mjs','test/wave-review.helpers.mjs','dist/wave-review.js','dist/wave-phases.js','dist/scheduler-control.js','dist/acceptance-loop.js','dist/role-orchestrator.js','dist/review.js','dist/execution-view-server.js','src/provider-observations.ts','src/project.ts','src/execution.ts','src/execution-events.ts','src/owned-lock.ts','dist/provider-observations.js','dist/project.js','dist/execution.js','dist/execution-events.js','dist/owned-lock.js','dist/scheduler-stops.js','src/maintenance.ts','dist/maintenance.js','test/provider-observations.test.mjs','test/scheduler-safety.test.mjs','test/execution-event-history.test.mjs','test/execution-view.test.mjs','src/cli.ts','dist/cli.js','test/scheduler-control.test.mjs']
const hashSources=()=>Promise.all(sourceFiles.map(async file=>({file,sha256:createHash('sha256').update(await readFile(path.join(repositoryRoot,file))).digest('hex')})))
const sourceHashes=await hashSources()
const facts = [], screenshots = [], errors = []
const f = await waveFixture({ blockFirst: true, failFirst: false, visual: true })
let server, browser, page
const capture = async (page, name) => {
  const file = path.join(output, `${name}.png`)
  await page.locator('.wave-review-panel').screenshot({ path: file })
  screenshots.push({ file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') })
  return file
}
try {
  const baseline = git(f.repository, ['rev-parse', 'HEAD'])
  const wave = await runReadyWave(f.root, { owner: 'browser-qa', testSessionId: 'wave-review-browser', testMaxRuntimeSeconds: 180 })
  await writeFile(path.join(f.root,'.spec-loop/scheduler/wave-reviews/WAVE-BROWSER-DAMAGED.json'),'{')
  server = await startExecutionViewServer(f.root)
  browser = await chromium.launch({ headless: true, ...(process.env.SPEC_LOOP_CHROMIUM_EXECUTABLE ? { executablePath: process.env.SPEC_LOOP_CHROMIUM_EXECUTABLE } : {}) })
  page = await browser.newPage({ viewport: { width: 1440, height: 1080 } })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(server.url)
  const panel = page.locator('.wave-review-panel')
  await panel.getByText('部分验收记录损坏，已单独标记；其余波次可继续验收。', { exact: true }).waitFor()
  facts.push('a damaged historical review is reported without blocking valid wave decisions')
  await panel.getByText('整波验证 1/2 轮 · 仍有待处理', { exact: true }).waitFor()
  facts.push('batch review shows its verification round and unresolved state')
  await panel.getByText('TASK-REVIEW-1', { exact: true }).waitFor()
  const initial = await capture(page, '01-needs-user-independent-candidate')
  await requestVisualReview(f.taskRoot(f.taskIds[0]), 'REVIEW-1', (await readAcceptanceRun(f.root, f.taskIds[0])).current_head, [initial])
  await refreshWaveReview(f.root, wave.wave_id)
  await panel.getByRole('button', { name: '刷新列表', exact: true }).click()
  await panel.getByRole('combobox', { name: 'TASK-REVIEW-1 最终决定' }).waitFor()
  await panel.locator('.ant-table-row-expand-icon').first().click()
  const preview = panel.getByAltText('TASK-REVIEW-1 REVIEW-1 验收截图')
  await preview.waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.wave-review-panel img')].some(img => img.complete && img.naturalWidth > 0))
  await capture(page, '02-evidence-and-bound-screenshot')
  await preview.click()
  await page.locator('.ant-image-preview-img').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('.ant-image-preview-img').waitFor({state:'hidden'})
  const select = async (id, label) => {
    const combo=panel.getByRole('combobox', { name: `${id} 最终决定` })
    await combo.click()
    const listId=await combo.getAttribute('aria-controls')
    const popup=page.locator('.ant-select-dropdown').filter({has:page.locator(`[id="${listId}"]`)})
    await popup.locator('.ant-select-item-option-content').getByText(label, { exact: true }).click()
    await popup.waitFor({state:'hidden'})
  }
  await select(f.taskIds[0], '退回修复')
  await select(f.taskIds[1], '接受候选（暂不合并）')
  await panel.getByRole('textbox', { name: '验收人', exact: true }).fill('browser-qa')
  await panel.getByRole('textbox', { name: '统一验收说明', exact: true }).fill('统一接受独立任务并修复待决任务')
  await panel.getByRole('checkbox', { name: /批准待执行任务的下一波计划/ }).check()
  await panel.getByText('下一波自动验证计划', {exact:true}).click()
  await panel.getByText('任务定向验证', {exact:false}).waitFor()
  await page.setViewportSize({width:390,height:844})
  await page.waitForFunction(()=>document.querySelector('.wave-review-panel').getBoundingClientRect().width>=300)
  await capture(page,'03a-mobile-decision-form-and-plan')
  const submitBox=await panel.getByRole('button',{name:'提交统一验收并继续下一波',exact:true}).boundingBox()
  assert.ok(submitBox.x>=0&&submitBox.x+submitBox.width<=390,'mobile final decision must be reachable within the viewport')
  await page.setViewportSize({width:1440,height:1080})
  const responsePromise = page.waitForResponse(response => response.url().includes('/api/wave-review/decision') && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '提交统一验收并继续下一波', exact: true }).click()
  const response = await responsePromise
  assert.equal(response.status(), 200, await response.text())
  const decision = await response.json()
  assert.equal(decision.review.status, 'reviewed')
  assert.equal(decision.next.status, 'started')
  await panel.getByText('统一决定已记录，下一波已启动。', { exact: true }).waitFor()
  await capture(page, '03-unified-decision-and-next-wave')
  const authFile = path.join(f.root, '.spec-loop/scheduler/wave-reviews/authorizations', `${decision.review.decision.authorization_id}.json`)
  let auth
  const deadline = Date.now() + 120_000
  do {
    auth = JSON.parse(await readFile(authFile, 'utf8'))
    if (['completed', 'failed'].includes(auth.status)) break
    await new Promise(resolve => setTimeout(resolve, 300))
  } while (Date.now() < deadline)
  assert.equal(auth.status, 'completed', JSON.stringify(auth))
  const next = await readWaveReview(f.root, auth.wave_id)
  assert.deepEqual(next.bundle.tasks.map(item => item.task_id), [f.taskIds[0]])
  assert.equal(next.bundle.tasks[0].outcome, 'candidate')
  assert.notEqual(next.bundle.tasks[0].facts.head, (await readWaveReview(f.root, wave.wave_id)).bundle.tasks[0].facts.head)
  facts.push('needs_user Task releases resources while an independent Task reaches R', 'one GUI decision accepts a subset and starts exactly the authorized next Task', 'next wave automatically advances M → controlled V → independent R at a new HEAD')
  await panel.getByRole('button', { name: '刷新列表', exact: true }).click()
  await panel.getByText('TASK-REVIEW-1', { exact: true }).waitFor()
  const finalShot = await capture(page, '04-reworked-candidate')
  await requestVisualReview(f.taskRoot(f.taskIds[0]), 'REVIEW-1', next.bundle.tasks[0].facts.head, [finalShot])
  await refreshWaveReview(f.root, auth.wave_id)
  await panel.getByRole('button', { name: '刷新列表', exact: true }).click()
  await panel.getByRole('combobox', { name: 'TASK-REVIEW-1 最终决定' }).waitFor()
  await select(f.taskIds[0], '接受候选（暂不合并）')
  await panel.getByRole('checkbox', { name: '我已查看截图并接受视觉效果', exact: true }).check()
  await panel.getByRole('textbox', { name: '验收人', exact: true }).fill('browser-qa')
  await panel.getByRole('textbox', { name: '统一验收说明', exact: true }).fill('测试夹具视觉审批与最终验收')
  const finalResponsePromise = page.waitForResponse(response => response.url().includes('/api/wave-review/decision') && response.request().method() === 'POST')
  await panel.getByRole('button', { name: '提交统一验收', exact: true }).click()
  const finalResponse = await finalResponsePromise
  assert.equal(finalResponse.status(), 200, await finalResponse.text())
  assert.equal((await finalResponse.json()).review.status, 'reviewed')
  await panel.getByText('统一决定已记录；候选尚未合并或发布。', { exact: true }).waitFor()
  await panel.locator('.ant-select').getByText(/已记录决定/).waitFor()
  await panel.getByText('已接受候选', { exact: true }).waitFor()
  assert.equal(await panel.getByText('V/R 已通过，待统一验收', { exact: true }).count(), 0)
  facts.push('saved decisions update both the wave selector and the candidate row')
  await capture(page, '05-visual-and-final-acceptance')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(()=>document.querySelector('.wave-review-panel').getBoundingClientRect().width>=300)
  assert.ok(await panel.isVisible())
  const box=await panel.boundingBox();assert.ok(box.width>=300&&box.x>=0&&box.x+box.width<=390,'mobile review must fit a usable viewport width')
  assert.ok(await panel.locator('.ant-table-content').evaluate(element => element.scrollWidth > element.clientWidth), 'mobile table must remain horizontally scrollable')
  await capture(page, '06-mobile-review')
  assert.equal(git(f.repository, ['rev-parse', 'HEAD']), baseline)
  assert.deepEqual(errors, [])
  facts.push('registered screenshots are readable and approval binds the current request hash', 'mobile review keeps task rows horizontally scrollable', 'no browser console errors, merge, push or deployment')
  assert.deepEqual(await hashSources(),sourceHashes,'tested source or build changed during browser verification')
  const checkedAt=new Date().toISOString(),sourceManifest=JSON.stringify({checked_at:checkedAt,head:git(repositoryRoot,['rev-parse','HEAD']),working_tree_clean:git(repositoryRoot,['status','--porcelain']).length===0,files:sourceHashes},null,2)+'\n'
  await writeFile(path.join(output,'source-hashes.json'),sourceManifest)
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'pass', browser: await browser.version(), fixture_root: f.root, checked_at: checkedAt, source_manifest:{file:path.join(output,'source-hashes.json'),sha256:createHash('sha256').update(sourceManifest).digest('hex')}, facts, screenshots, errors }, null, 2) + '\n')
  console.log(JSON.stringify({ status: 'pass', report: path.join(output, 'report.json'), facts, screenshots: screenshots.length }))
} catch (error) {
  const inlineStyles=await page?.locator('style').evaluateAll(elements=>elements.map(element=>({nonce:element.nonce?'present':'missing',text:element.textContent.slice(0,300)})))
  await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{})
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'fail', fixture_root: f.root, error: error.stack, screenshots, errors,inlineStyles }, null, 2) + '\n')
  throw error
} finally {
  await browser?.close()
  if (server) await closeExecutionViewServer(server.server)
  await stopManagedSchedulerSupervisor(f.root).catch(() => {})
}
