import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

import { cli, fillContracts, tempRoot, writeMd } from './helpers.mjs'
import { startAcceptanceRun } from '../dist/acceptance-loop.js'
import { freezeControlledVerificationCandidate, runGates } from '../dist/execution.js'
import { readMarkdown } from '../dist/files.js'
import { collectSpringEvidence, detectSpringBoot, planV2Gates, verifySpringEvidence, verifyV2GatePlan } from '../dist/toolchain.js'

function git(cwd, args) { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim() }
function contract() { return { schema_version: 2, task_id: 'TASK-SPRING-1', version: 1, risk: 'standard', critical_path: false, depends_on: [], criteria: [{ id: 'AC-1', text: 'Spring tests pass', risk_tags: ['functional'], waivable: false }], use_cases: [{ id: 'UC-1', ac: ['AC-1'], scenario: 'run affected Spring module tests' }], tools: [{ id: 'spring-tests', kind: 'unit', gate_id: 'spring-tests', command: ['./mvnw', '-pl', 'service', 'test'], playwright: null }], assertions: [{ id: 'AS-1', ac: ['AC-1'], tool_id: 'spring-tests', operator: 'exit_code_zero', expected: 'exit code 0' }], evidence_requirements: [{ id: 'ER-1', ac: ['AC-1'], tool_id: 'spring-tests', kind: 'test_report', required: true }], budgets: { max_semantic_reworks: 2, max_infrastructure_retries_per_stage: 1, repeated_failure_limit: 2 } } }

test('v2 Gate Planner and Spring T2 evidence are scoped, hashed, and fail closed', async () => {
  const root = await tempRoot('toolchain-spring-'), repository = path.join(root, 'repo'); await mkdir(path.join(repository, '.mvn', 'wrapper'), { recursive: true }); await mkdir(path.join(repository, 'service', 'src', 'main', 'java'), { recursive: true })
  git(repository, ['init', '-b', 'main']); git(repository, ['config', 'user.email', 'test@example.com']); git(repository, ['config', 'user.name', 'Test'])
  await writeFile(path.join(repository, 'mvnw'), '#!/bin/sh\nset -eu\nmkdir -p service/target/surefire-reports\nprintf \'<testsuite tests="2" failures="0" errors="0" skipped="0"><testcase name="one"/><testcase name="two"/></testsuite>\\n\' > service/target/surefire-reports/TEST-App.xml\nprintf \'<report><counter type="LINE" missed="1" covered="9"/></report>\\n\' > service/target/surefire-reports/jacoco.xml\n'); await chmod(path.join(repository, 'mvnw'), 0o755)
  await writeFile(path.join(repository, '.gitignore'), '**/target/\n')
  await writeFile(path.join(repository, '.mvn', 'wrapper', 'maven-wrapper.properties'), 'distributionUrl=https://example.invalid/maven.zip\n')
  await writeFile(path.join(repository, 'pom.xml'), '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><properties><java.version>17</java.version></properties><modules><module>service</module></modules></project>\n')
  await writeFile(path.join(repository, 'service', 'src', 'main', 'java', 'App.java'), 'class App {}\n'); git(repository, ['add', '.']); git(repository, ['commit', '-m', 'initial Spring project'])
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-SPRING', '--name', 'Spring fixture', '--repository', repository]).code, 0); assert.equal(cli(['project', 'protocol', root, '--set', 'v2']).code, 0)
  const contractFile = path.join(root, 'contract.json'); await writeFile(contractFile, `${JSON.stringify(contract(), null, 2)}\n`)
  const proposal = cli(['triage', 'propose', root, '--source', 'approved Spring design', '--goal', 'Verify Spring module', '--reason', 'Need native T2 evidence', '--contract', contractFile]); assert.equal(proposal.code, 0, proposal.stderr); assert.equal(cli(['triage', 'approve', root, proposal.stdout.trim(), '--by', 'owner']).code, 0); assert.equal(cli(['triage', 'create-task', root, proposal.stdout.trim(), '--id', 'TASK-SPRING-1', '--title', 'Verify Spring']).code, 0)
  const taskRoot = path.join(root, '.spec-loop', 'tasks', 'task-spring-1'); await fillContracts(taskRoot, { id: 'TASK-SPRING-1', title: 'Verify Spring', level: 'standard', criteria: ['Spring tests pass'] }); await writeMd(path.join(taskRoot, 'SPEC.md'), { schema_version: 1, task_id: 'TASK-SPRING-1', title: 'Verify Spring', level: 'standard', proposal_id: proposal.stdout.trim() }, '# Goal\n\nVerify Spring.\n\n## Scope\n\nService module.\n\n## Non-goals\n\nNo release.'); assert.equal(cli(['plan', taskRoot]).code, 0)
  await writeMd(path.join(root, '.spec-loop', 'GATES.md'), { schema_version: 1, scope_kind: 'task', wave_id: 'WSPRING', coverage: 'targeted', database: { lifecycle: 'persistent', reset: 'fixtures' }, gates: [{ id: 'spring-tests', ac: ['AC-1'], command: ['./mvnw', '-pl', 'service', 'test'], timeout_seconds: 30 }] }, '# Gates\n\nSpring fixture gate.')
  git(repository, ['add', '.']); git(repository, ['commit', '-m', 'approved specs']); await startAcceptanceRun(root, 'TASK-SPRING-1')
  const workspace = JSON.parse(cli(['workspace', 'create', root, 'TASK-SPRING-1', '--json']).stdout).worktree
  await writeFile(path.join(workspace, 'service', 'src', 'main', 'java', 'SecurityConfig.java'), 'class SecurityConfig {}\n'); await writeFile(path.join(workspace, 'pom.xml'), `${await readFile(path.join(workspace, 'pom.xml'), 'utf8')}<!-- dependency change -->\n`); git(workspace, ['add', '.']); git(workspace, ['commit', '-m', 'change Spring security dependency'])

  const detected = await detectSpringBoot(workspace); assert.equal(detected.kind, 'maven'); assert.equal(detected.java_version, '17'); assert.deepEqual(detected.modules, ['service'])
  const feedback = await planV2Gates(root, 'TASK-SPRING-1', 'feedback'); assert.equal(feedback.coverage, 'targeted'); assert.equal(feedback.execution_authorized, false); assert.equal(feedback.requires_explicit_authorization, false); assert.deepEqual(feedback.selected_modules, ['service']); assert.ok(feedback.impact.includes('security')); assert.ok(feedback.impact.includes('build_system')); assert.deepEqual(feedback.selected_gates[0].ac, ['AC-1'])
  assert.deepEqual(feedback.selected_gates[0].use_case_ids, ['UC-1']); assert.deepEqual(feedback.selected_gates[0].assertion_ids, ['AS-1']); assert.deepEqual(feedback.selected_gates[0].evidence_requirement_ids, ['ER-1'])
  assert.equal((await verifyV2GatePlan(root, 'TASK-SPRING-1', 'feedback')).plan_hash, feedback.plan_hash)
  const approvedPath = path.join(taskRoot, 'ACCEPTANCE_CONTRACT_V2.md'), approvedRaw = await readFile(approvedPath, 'utf8'), approved = await readMarkdown(approvedPath)
  await writeMd(approvedPath, { ...approved.data, criteria: [], use_cases: [], tools: [], assertions: [], evidence_requirements: [] }, approved.body)
  await assert.rejects(planV2Gates(root, 'TASK-SPRING-1', 'feedback'), /blocked|Contract|integrity/)
  await writeFile(approvedPath, approvedRaw)
  const oldJavaHome = process.env.JAVA_HOME; process.env.JAVA_HOME = '/missing-java-home'
  try { await assert.rejects(verifyV2GatePlan(root, 'TASK-SPRING-1', 'feedback'), /environment changed/) }
  finally { process.env.JAVA_HOME = oldJavaHome }
  const delivery = await planV2Gates(root, 'TASK-SPRING-1', 'delivery'); assert.equal(delivery.coverage, 'targeted'); assert.equal(delivery.requires_explicit_authorization, true)
  await assert.rejects(planV2Gates(root, 'TASK-SPRING-1', 'phase'), /requires a Heavy Task/)

  await freezeControlledVerificationCandidate(root, 'TASK-SPRING-1'); assert.equal((await runGates(root, 'TASK-SPRING-1'))[0].exit_code, 0)
  const reports = path.join(workspace, 'service', 'target', 'surefire-reports'), testReport = path.join(reports, 'TEST-App.xml')
  const reportAlias = path.join(workspace, 'report-alias'); await symlink(reports, reportAlias)
  await assert.rejects(collectSpringEvidence(root, 'TASK-SPRING-1', reportAlias), /symbolic/)
  await rm(reportAlias)
  const evidence = await collectSpringEvidence(root, 'TASK-SPRING-1', reports); assert.equal(evidence.tests.total, 2); assert.deepEqual(evidence.coverage, { covered: 9, missed: 1 }); assert.equal((await verifySpringEvidence(root, 'TASK-SPRING-1')).evidence_hash, evidence.evidence_hash)
  const addedReport = path.join(reports, 'TEST-Added.xml')
  await writeFile(addedReport, '<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase name="later"><failure/></testcase></testsuite>\n')
  await assert.rejects(verifySpringEvidence(root, 'TASK-SPRING-1'), /report file set changed/)
  await rm(addedReport)
  process.env.JAVA_HOME = '/missing-java-home'
  try { await assert.rejects(collectSpringEvidence(root, 'TASK-SPRING-1', reports), /environment changed|Gate is missing/); await assert.rejects(verifySpringEvidence(root, 'TASK-SPRING-1'), /environment changed/) }
  finally { process.env.JAVA_HOME = oldJavaHome }
  const source = path.join(workspace, 'service', 'src', 'main', 'java', 'App.java'), validSource = await readFile(source, 'utf8')
  await writeFile(source, 'class App { int uncommitted = 1; }\n')
  await assert.rejects(collectSpringEvidence(root, 'TASK-SPRING-1', reports), /candidate worktree changed/)
  await assert.rejects(verifySpringEvidence(root, 'TASK-SPRING-1'), /candidate worktree changed/)
  await writeFile(source, validSource)
  const validReport = await readFile(testReport, 'utf8')
  await writeFile(testReport, '<testsuite tests="2" failures="1" errors="0" skipped="0"></testsuite>\n'); await assert.rejects(verifySpringEvidence(root, 'TASK-SPRING-1'), /tampered/)
  await writeFile(testReport, validReport)
  await writeFile(path.join(workspace, 'service', 'src', 'main', 'java', 'App.java'), 'class App { int changed = 1; }\n'); git(workspace, ['add', '.']); git(workspace, ['commit', '-m', 'changed candidate without rerunning Spring Gate'])
  await assert.rejects(collectSpringEvidence(root, 'TASK-SPRING-1', reports), /HEAD|stale/)

  const gradle = path.join(root, 'gradle-project'); await mkdir(path.join(gradle, 'gradle', 'wrapper'), { recursive: true }); await writeFile(path.join(gradle, 'gradlew'), '#!/bin/sh\n'); await writeFile(path.join(gradle, 'settings.gradle.kts'), 'include(":app", ":shared")\n'); await writeFile(path.join(gradle, 'build.gradle.kts'), 'plugins { id("org.springframework.boot") version "3.5.0" }\njava { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\n'); await writeFile(path.join(gradle, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'distributionUrl=https://example.invalid/gradle.zip\n')
  const gradleDetection = await detectSpringBoot(gradle); assert.equal(gradleDetection.kind, 'gradle'); assert.equal(gradleDetection.java_version, '21'); assert.deepEqual(gradleDetection.modules, ['app', 'shared'])
})
