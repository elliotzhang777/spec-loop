import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicWriteMany, exists, sha256 } from './files.js';
import { readWorkspace } from './execution.js';
import { scanTasks } from './project.js';

const exec = promisify(execFile);

type Bucket = { bytes: number; files: number; symlinks: number };

export async function inspectArtifacts(projectRoot: string) {
  const control = path.join(projectRoot, '.spec-loop'), controlInfo = await lstat(control).catch(() => null);
  if (!controlInfo?.isDirectory() || controlInfo.isSymbolicLink()) throw new Error('.spec-loop control root is missing or invalid');
  const buckets = new Map<string, Bucket>(), worktreeBytes = new Map<string, number>();
  const largest: Array<{ file: string; bytes: number }> = [];
  let totalBytes = 0, files = 0, symlinks = 0, nodeModulesBytes = 0, mavenCacheBytes = 0;
  const addBucket = (name: string, bytes: number, symbolic = false) => {
    const current = buckets.get(name) ?? { bytes: 0, files: 0, symlinks: 0 };
    current.bytes += bytes; current.files += symbolic ? 0 : 1; current.symlinks += symbolic ? 1 : 0; buckets.set(name, current);
  };
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name), relative = path.relative(control, target).split(path.sep).join('/'), top = relative.split('/')[0] || 'root';
      const info = await lstat(target);
      if (info.isSymbolicLink()) { symlinks += 1; addBucket(top, 0, true); continue; }
      if (info.isDirectory()) { await walk(target); continue; }
      if (!info.isFile()) continue;
      totalBytes += info.size; files += 1; addBucket(top, info.size);
      const parts = relative.split('/');
      if (parts.includes('node_modules')) nodeModulesBytes += info.size;
      if (parts.includes('.m2') || parts.includes('repository') && /\.m2|maven/i.test(relative)) mavenCacheBytes += info.size;
      if (parts[0] === 'worktrees' && parts[1]) worktreeBytes.set(parts[1], (worktreeBytes.get(parts[1]) ?? 0) + info.size);
      largest.push({ file: `.spec-loop/${relative}`, bytes: info.size });
      largest.sort((left, right) => right.bytes - left.bytes || left.file.localeCompare(right.file));
      if (largest.length > 20) largest.length = 20;
    }
  };
  await walk(control);
  const tasks = await scanTasks(projectRoot).catch(() => []), statusByDirectory = new Map(tasks.map((task) => [path.basename(task.path), task.status]));
  const retirementCandidates = [...worktreeBytes].flatMap(([directory, bytes]) => {
    const status = statusByDirectory.get(directory);
    return status && ['delivered', 'cancelled'].includes(status) ? [{ directory: `.spec-loop/worktrees/${directory}`, task_status: status, bytes }] : [];
  }).sort((left, right) => right.bytes - left.bytes);
  return {
    schema_version: 1, project_root: path.resolve(projectRoot), inspected_root: control, total_bytes: totalBytes, files, symlinks,
    by_top_level: Object.fromEntries([...buckets].sort(([left], [right]) => left.localeCompare(right))),
    duplicated_dependency_indicators: { node_modules_bytes: nodeModulesBytes, maven_cache_bytes: mavenCacheBytes },
    largest_files: largest, retirement_candidates: retirementCandidates,
    policy: {
      destructive_action_performed: false,
      recommendations: [
        'Keep authoritative Event Log, manifests, Gate summaries and hashed Evidence before retiring a worktree.',
        'Only retire a delivered/cancelled worktree after confirming its branch and committed HEAD remain recoverable.',
        'Use shared package-manager download caches; do not copy HOME, .m2, npm or temporary directories into each invocation sandbox.',
        'Apply retention explicitly in a separately authorized maintenance operation; inspection never deletes artifacts.',
      ],
    },
  };
}

export async function retentionPolicy(projectRoot:string){
  const control=path.join(projectRoot,'.spec-loop');
  return{schema_version:1,project_root:path.resolve(projectRoot),shared_cache_root:path.join(control,'shared-cache'),snapshot_max_bytes:262_144,
    recommended_limits:{project_bytes:10*1024**3,workflow_bytes:2*1024**3,provider_output_bytes:1024**2,retained_terminal_worktrees:5},
    lifecycle:{authoritative:['EXECUTION_EVENTS.jsonl','Acceptance Contract/Run/Plan','Gate summaries and hashed Evidence','Candidate and retirement manifests'],ephemeral:['role candidate snapshots','worktrees after terminal archive','per-invocation temporary directories'],shared:['npm download cache','Maven repository cache']},
    commands:{inspect:`spec-loop maintenance inspect ${JSON.stringify(path.resolve(projectRoot))} --json`,archive:`spec-loop maintenance archive-evidence ${JSON.stringify(path.resolve(projectRoot))} <TASK-ID> --json`,retire:'spec-loop maintenance retire-worktree <PROJECT> <TASK-ID> --expected-head <HEAD> --apply --json'},
    destructive_action_performed:false};
}

export async function archiveAcceptanceEvidence(projectRoot:string,taskId:string){
  const root=path.resolve(projectRoot),task=(await scanTasks(root)).find(item=>item.task_id===taskId);if(!task)throw new Error(`task not found: ${taskId}`);
  const run=JSON.parse(await readFile(path.join(task.path,'ACCEPTANCE_RUN.json'),'utf8')) as {run_id?:string};if(!run.run_id)throw new Error(`${taskId}: no Acceptance Run to archive`);
  const archiveRoot=path.join(root,'.spec-loop','evidence-archive',taskId,run.run_id),manifestFile=path.join(archiveRoot,'MANIFEST.json');if(await exists(manifestFile))return JSON.parse(await readFile(manifestFile,'utf8'));
  const sources=[path.join(task.path,'ACCEPTANCE_CONTRACT_V2.md'),path.join(task.path,'ACCEPTANCE_RUN.json'),path.join(task.path,'PLAN.md'),path.join(root,'.spec-loop','output',`${taskId}-acceptance-v2`)];
  const files:Array<{source:string;relative:string;bytes:number;sha256:string}>=[];const collect=async(source:string,base:string):Promise<void>=>{const info=await lstat(source).catch(()=>null);if(!info)return;if(info.isSymbolicLink())throw new Error(`archive source contains symbolic link: ${source}`);if(info.isDirectory()){if(path.basename(source)==='candidate')return;for(const entry of await readdir(source))await collect(path.join(source,entry),base);return}if(!info.isFile())return;const relative=path.join(base,path.relative(sources.includes(source)?path.dirname(source):sources.find(item=>source.startsWith(item+path.sep))??path.dirname(source),source));const normalized=relative.split(path.sep).filter(Boolean).join('/'),content=await readFile(source);files.push({source,relative:normalized,bytes:content.length,sha256:sha256(content)})};
  for(const source of sources){const info=await lstat(source).catch(()=>null);if(!info)continue;if(info.isDirectory())for(const entry of await readdir(source))await collect(path.join(source,entry),'acceptance-output');else await collect(source,'task')}
  const total=files.reduce((sum,item)=>sum+item.bytes,0);if(total>50*1024**2)throw new Error(`Evidence archive exceeds 50 MB (${total}); inspect and select bounded authoritative Evidence`);
  for(const item of files){const destination=path.join(archiveRoot,item.relative);await mkdir(path.dirname(destination),{recursive:true});await copyFile(item.source,destination)}
  const manifest={schema_version:1,task_id:taskId,run_id:run.run_id,created_at:new Date().toISOString(),total_bytes:total,files:files.map(({source:_,...item})=>item),excluded:['role candidate snapshots'],destructive_action_performed:false};await atomicWriteMany(root,[{file:manifestFile,content:`${JSON.stringify(manifest,null,2)}\n`}]);return manifest;
}

export async function runRetentionMaintenance(projectRoot:string,maxTasks=5){
  if(!Number.isInteger(maxTasks)||maxTasks<1||maxTasks>100)throw new Error('retention maintenance maxTasks must be 1–100');
  const terminal=(await scanTasks(projectRoot)).filter(task=>['delivered','cancelled'].includes(task.status)),archived:Array<Record<string,unknown>>=[],skipped:Array<Record<string,unknown>>=[],errors:Array<Record<string,unknown>>=[];let attempted=0;
  for(const task of terminal){
    const runFile=path.join(task.path,'ACCEPTANCE_RUN.json');if(!(await exists(runFile))){skipped.push({task_id:task.task_id,reason:'no_acceptance_run'});continue}
    const run=await readFile(runFile,'utf8').then(raw=>JSON.parse(raw) as {run_id?:string}).catch(()=>null);if(!run?.run_id){errors.push({task_id:task.task_id,error:'invalid Acceptance Run identity'});continue}
    if(await exists(path.join(projectRoot,'.spec-loop','evidence-archive',task.task_id,run.run_id,'MANIFEST.json'))){skipped.push({task_id:task.task_id,reason:'already_archived'});continue}
    if(attempted>=maxTasks){skipped.push({task_id:task.task_id,reason:'cycle_limit'});continue}attempted+=1;
    try{const manifest=await archiveAcceptanceEvidence(projectRoot,task.task_id);archived.push({task_id:task.task_id,run_id:manifest.run_id,total_bytes:manifest.total_bytes})}
    catch(error){errors.push({task_id:task.task_id,error:(error as Error).message.slice(0,1000)})}
  }
  return{schema_version:1,ran_at:new Date().toISOString(),max_tasks:maxTasks,terminal_tasks:terminal.length,archived,skipped,errors,destructive_action_performed:false};
}

async function activeTaskFacts(projectRoot: string, taskId: string) {
  const effects: string[] = [], leases: string[] = [];
  const effectDir = path.join(projectRoot, '.spec-loop', 'active-effects');
  for (const name of await readdir(effectDir).catch(() => [])) if (name.endsWith('.json')) {
    const value = JSON.parse(await readFile(path.join(effectDir, name), 'utf8')) as { task_id?: string; effect_id?: string; pid?: number };
    if (value.task_id !== taskId || !value.pid) continue;
    try { process.kill(value.pid, 0); effects.push(value.effect_id ?? name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  const leaseDir = path.join(projectRoot, '.spec-loop', 'scheduler', 'task-leases');
  for (const name of await readdir(leaseDir).catch(() => [])) if (name.endsWith('.json')) {
    const value = JSON.parse(await readFile(path.join(leaseDir, name), 'utf8')) as { task_id?: string; lease_id?: string; status?: string; expires_at?: string };
    if (value.task_id === taskId && value.status === 'active' && Date.parse(value.expires_at ?? '') > Date.now()) leases.push(value.lease_id ?? name);
  }
  return { effects: effects.sort(), leases: leases.sort() };
}

export async function planWorktreeRetirement(projectRoot: string, taskId: string, expectedHead?: string) {
  const task = (await scanTasks(projectRoot)).find((item) => item.task_id === taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  const workspace = await readWorkspace(projectRoot, taskId), blockers: string[] = [];
  const actualHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd: workspace.worktree, maxBuffer: 1_000_000, timeout: 60_000, killSignal: 'SIGKILL' })).stdout.trim();
  const branchHead = (await exec('git', ['rev-parse', '--verify', `refs/heads/${workspace.branch}^{commit}`], { cwd: workspace.repository, maxBuffer: 1_000_000, timeout: 60_000, killSignal: 'SIGKILL' })).stdout.trim();
  const dirty = (await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: workspace.worktree, maxBuffer: 10_000_000, timeout: 60_000, killSignal: 'SIGKILL' })).stdout.trim();
  const active = await activeTaskFacts(projectRoot, taskId);
  if (!['delivered', 'cancelled'].includes(task.status)) blockers.push(`Task is not terminal: ${task.status}`);
  if (dirty) blockers.push('Worktree contains tracked or untracked changes');
  if (branchHead !== actualHead) blockers.push('Recoverable branch does not point at Worktree HEAD');
  if (expectedHead && expectedHead !== actualHead) blockers.push(`Expected HEAD ${expectedHead} differs from actual HEAD ${actualHead}`);
  if (active.effects.length) blockers.push(`Active Effects exist: ${active.effects.join(', ')}`);
  if (active.leases.length) blockers.push(`Active Task leases exist: ${active.leases.join(', ')}`);
  return {
    schema_version: 1 as const, task_id: taskId, task_status: task.status, worktree: workspace.worktree,
    repository: workspace.repository, branch: workspace.branch, actual_head: actualHead, expected_head: expectedHead ?? null,
    recoverable_branch_head: branchHead, clean: !dirty, active_effects: active.effects, active_leases: active.leases,
    safe_to_retire: blockers.length === 0, blockers, destructive_action_performed: false,
    recovery_command: `git -C ${JSON.stringify(workspace.repository)} worktree add ${JSON.stringify(workspace.worktree)} ${JSON.stringify(workspace.branch)}`,
  };
}

export async function retireWorktree(projectRoot: string, taskId: string, expectedHead: string) {
  if (!/^[a-f0-9]{40,64}$/.test(expectedHead)) throw new Error('--expected-head must be a full Git commit hash');
  const recordFile = path.join(projectRoot, '.spec-loop', 'retirements', `${taskId}.json`);
  if (await exists(recordFile)) {
    const previous = JSON.parse(await readFile(recordFile, 'utf8')) as { actual_head?: string };
    if (previous.actual_head !== expectedHead) throw new Error('retirement record exists for a different HEAD');
    return previous;
  }
  const plan = await planWorktreeRetirement(projectRoot, taskId, expectedHead);
  if (!plan.safe_to_retire) throw new Error(`Worktree retirement refused: ${plan.blockers.join('; ')}`);
  await exec('git', ['worktree', 'remove', '--', plan.worktree], { cwd: plan.repository, maxBuffer: 10_000_000, timeout: 60_000, killSignal: 'SIGKILL' });
  const preservedHead = (await exec('git', ['rev-parse', '--verify', `refs/heads/${plan.branch}^{commit}`], { cwd: plan.repository, maxBuffer: 1_000_000, timeout: 60_000, killSignal: 'SIGKILL' })).stdout.trim();
  if (preservedHead !== expectedHead) throw new Error('retirement completed but preserved branch HEAD no longer matches; manual recovery required');
  const record = { ...plan, destructive_action_performed: true, retired_at: new Date().toISOString(), safe_to_retire: true };
  await atomicWriteMany(projectRoot, [{ file: recordFile, content: `${JSON.stringify(record, null, 2)}\n` }]);
  return record;
}
