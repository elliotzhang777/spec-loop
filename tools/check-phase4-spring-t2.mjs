import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { detectSpringBoot } from '../dist/toolchain.js'
import { springT2Passed } from './phase4-spring-result.mjs'

const gitCommon = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
})
assert.equal(gitCommon.status, 0, gitCommon.stderr)
const projectRoot = path.dirname(gitCommon.stdout.trim())
const taskId=path.basename(process.cwd()).match(/^task-\d+$/i)?.[0].toUpperCase() ?? 'TASK-037'
const [repositoryArg = process.env.SPEC_LOOP_PHASE4_SPRING_REPO ??
  path.join(projectRoot, 'projects/offshore-electrical-management/repo'),
outputArg = process.env.SPEC_LOOP_PHASE4_SPRING_OUTPUT ??
  path.join(projectRoot, `.spec-loop/output/${taskId}-spring-t2`)] = process.argv.slice(2)
const repository = realpathSync(repositoryArg), output = path.resolve(outputArg)
mkdirSync(output, { recursive: true })
const digest = data => createHash('sha256').update(data).digest('hex')
const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const candidateHead = git(process.cwd(), ['rev-parse', 'HEAD'])
const acceptanceRun = JSON.parse(readFileSync(path.join(projectRoot,
  `.spec-loop/tasks/${taskId.toLowerCase()}/ACCEPTANCE_RUN.json`), 'utf8'))
assert.equal(acceptanceRun.current_head, candidateHead, 'Spring Gate must bind the current Phase 4 candidate')
assert.ok(acceptanceRun.plan_hash && acceptanceRun.contract_hash, 'Phase 4 plan or Contract binding missing')
const projectHead = git(repository, ['rev-parse', 'HEAD'])
const initialStatus = git(repository, ['status', '--porcelain=v1', '--untracked-files=all'])
assert.equal(initialStatus, '', 'real Spring project must start clean')
const toolchain = await detectSpringBoot(repository)
assert.equal(toolchain?.kind, 'maven', 'real Maven Spring Boot project must be detected')
const startedAt = Date.now(), logFile = path.join(output, 'maven-targeted.log')
const fd = openSync(logFile, 'w')
let result
try {
  result = spawnSync(path.join(repository, toolchain.wrapper), [
    '-B', '-pl', 'backend/start', '-am', '-Dtest=ArchitectureTest,ApiContractTest',
    '-Dsurefire.failIfNoSpecifiedTests=false', 'test',
  ], { cwd: repository, stdio: ['ignore', fd, fd], timeout: 600_000 })
} finally { closeSync(fd) }
const reports = []
let tests = 0, failures = 0, errors = 0, skipped = 0
for (const name of ['ArchitectureTest', 'ApiContractTest']) {
  const file = path.join(repository, 'backend/start/target/surefire-reports', `TEST-com.offshore.start.${name}.xml`)
  const info = statSync(file)
  assert.ok(info.mtimeMs >= startedAt - 1000, `${name} JUnit XML predates this Gate`)
  const content = readFileSync(file, 'utf8'), suite = content.match(/<testsuite\b[^>]*>/)?.[0]
  assert.ok(suite && content.includes('</testsuite>'), `${name} JUnit XML is invalid`)
  const value = key => Number(suite.match(new RegExp(`\\b${key}=["'](\\d+)["']`))?.[1] ?? NaN)
  for (const key of ['tests', 'failures', 'errors', 'skipped']) assert.ok(Number.isInteger(value(key)), `${name} JUnit ${key} missing`)
  tests += value('tests'); failures += value('failures'); errors += value('errors'); skipped += value('skipped')
  reports.push({ file: path.relative(repository, file), sha256: digest(content) })
}
const finalStatus = git(repository, ['status', '--porcelain=v1', '--untracked-files=all'])
const finalHead=git(repository, ['rev-parse', 'HEAD'])
const report = {
  schema_version: 1, kind: 'real-spring-boot-t2-gate', candidate_head: candidateHead,
  acceptance_run_id: acceptanceRun.run_id, plan_hash: acceptanceRun.plan_hash,
  contract_hash: acceptanceRun.contract_hash,
  project_head: projectHead, toolchain, command: ['./mvnw', '-B', '-pl', 'backend/start', '-am',
    '-Dtest=ArchitectureTest,ApiContractTest', '-Dsurefire.failIfNoSpecifiedTests=false', 'test'],
  exit_code: result.status, signal: result.signal, timed_out: result.error?.code === 'ETIMEDOUT',
  tests: { total: tests, failures, errors, skipped }, reports,
  log: { file: logFile, sha256: digest(readFileSync(logFile)) },
  project_unchanged: finalStatus === initialStatus && finalHead === projectHead,
  status: springT2Passed({exitCode:result.status,tests,failures,errors,initialStatus,finalStatus,initialHead:projectHead,finalHead}) ? 'PASS' : 'FAIL',
  checked_at: new Date().toISOString(),
}
writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ status: report.status, candidate_head: candidateHead, project_head: projectHead, tests: report.tests }))
if (report.status !== 'PASS') process.exitCode = 1
