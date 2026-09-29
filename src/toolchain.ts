import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteMany, exists, sha256 } from './files.js';
import { currentGateEnvironmentHash, readWorkspace, verifiedGateResults } from './execution.js';
import { scanTasks, verifyTaskExecutionApproval } from './project.js';
import { readApprovedAcceptanceContract } from './acceptance-loop.js';

const hashSchema=z.string().regex(/^[a-f0-9]{64}$/),stageSchema=z.enum(['feedback','candidate','delivery','phase']);
const detectionSchema=z.object({kind:z.enum(['maven','gradle']),root:z.string(),wrapper:z.string(),java_version:z.string().nullable(),modules:z.array(z.string()),build_files:z.array(z.object({file:z.string(),sha256:hashSchema}).strict()),detected_at:z.iso.datetime()}).strict();
const planSchema=z.object({schema_version:z.literal(2),task_id:z.string(),stage:stageSchema,scope_kind:z.enum(['task','wave']),coverage:z.enum(['targeted','full']),execution_authorized:z.literal(false),requires_explicit_authorization:z.boolean(),head:z.string(),base_commit:z.string(),contract_hash:hashSchema,environment_hash:hashSchema,toolchain_hash:hashSchema.nullable(),changed_files:z.array(z.string()),impact:z.array(z.enum(['documentation','local_code','cross_module','security','migration','dependency','build_system'])),selected_modules:z.array(z.string()),selected_gates:z.array(z.object({tool_id:z.string(),gate_id:z.string(),ac:z.array(z.string()),use_case_ids:z.array(z.string()),assertion_ids:z.array(z.string()),evidence_requirement_ids:z.array(z.string()),reason:z.string()}).strict()),skipped_gates:z.array(z.object({gate_id:z.string(),reason:z.string()}).strict()),escalation_triggers:z.array(z.string()),estimated_cost:z.object({minutes:z.number().int().positive(),resource_class:z.enum(['small','medium','large'])}).strict(),toolchain:detectionSchema.nullable(),plan_hash:hashSchema,created_at:z.iso.datetime()}).strict();
const springEvidenceSchema=z.object({schema_version:z.literal(1),task_id:z.string(),head:z.string(),framework:z.literal('spring-boot'),toolchain:z.enum(['maven','gradle']),environment_hash:hashSchema,toolchain_hash:hashSchema,gate_id:z.string(),gate_sha256:hashSchema,gate_plan_sha256:hashSchema,reports_root:z.string().min(1),tests:z.object({total:z.number().int().nonnegative(),failures:z.number().int().nonnegative(),errors:z.number().int().nonnegative(),skipped:z.number().int().nonnegative()}).strict(),coverage:z.object({covered:z.number().int().nonnegative(),missed:z.number().int().nonnegative()}).strict().nullable(),reports:z.array(z.object({file:z.string(),sha256:hashSchema}).strict()).min(1),evidence_hash:hashSchema,created_at:z.iso.datetime()}).strict();
export type SpringDetection=z.infer<typeof detectionSchema>;export type V2GatePlan=z.infer<typeof planSchema>;

async function git(cwd:string,args:string[]):Promise<string>{return new Promise((resolve,reject)=>{const child=spawn('git',args,{cwd,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});let stdout='',stderr='',settled=false;const timer=setTimeout(()=>{if(settled)return;settled=true;try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-(child.pid as number),'SIGKILL')}catch{child.kill('SIGKILL')}reject(new Error(`git ${args[0]??'command'} timed out after 60s`))},60_000);child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error)});child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);code===0?resolve(stdout.trim()):reject(new Error(stderr.trim()||`git exited ${code}`))})})}
function relative(root:string,file:string){return path.relative(root,file).split(path.sep).join('/')}
async function fileFact(root:string,file:string){return{file:relative(root,file),sha256:sha256(await readFile(file))}}
function toolchainHash(value:SpringDetection|null){if(!value)return null;const {detected_at:_detected,...stable}=value;return sha256(JSON.stringify(stable))}
function selectedGates(contract:Record<string,any>){
  const tools=Array.isArray(contract.tools)?contract.tools:[],assertions=Array.isArray(contract.assertions)?contract.assertions:[],useCases=Array.isArray(contract.use_cases)?contract.use_cases:[],requirements=Array.isArray(contract.evidence_requirements)?contract.evidence_requirements:[],criteria=Array.isArray(contract.criteria)?contract.criteria:[];
  const selected=tools.map((tool:any)=>{const linked=assertions.filter((item:any)=>item.tool_id===tool.id),ac=[...new Set<string>(linked.flatMap((item:any)=>item.ac))].sort(),linkedCases=useCases.filter((item:any)=>item.ac.some((id:string)=>ac.includes(id))),linkedRequirements=requirements.filter((item:any)=>item.tool_id===tool.id&&item.ac.some((id:string)=>ac.includes(id)));return{tool_id:tool.id,gate_id:tool.gate_id,ac,use_case_ids:linkedCases.map((item:any)=>item.id).sort(),assertion_ids:linked.map((item:any)=>item.id).sort(),evidence_requirement_ids:linkedRequirements.map((item:any)=>item.id).sort(),reason:'selected because the P-approved contract binds this tool to use cases, assertions and evidence requirements'}});
  for(const criterion of criteria){const id=criterion.id;if(!useCases.some((item:any)=>item.ac.includes(id))||!assertions.some((item:any)=>item.ac.includes(id))||!requirements.some((item:any)=>item.ac.includes(id)&&selected.some((gate:any)=>gate.tool_id===item.tool_id&&gate.ac.includes(id))))throw new Error(`P-approved AC ${id} lacks use case, assertion or Evidence mapping`)}
  if(selected.some((item:any)=>!item.ac.length||!item.use_case_ids.length||!item.assertion_ids.length||!item.evidence_requirement_ids.length))throw new Error('P-approved tool lacks complete AC traceability');
  return selected;
}

export async function detectSpringBoot(repository:string):Promise<SpringDetection|null>{
  const root=await realpath(repository),maven=await exists(path.join(root,'pom.xml')),gradle=(await exists(path.join(root,'build.gradle')))||(await exists(path.join(root,'build.gradle.kts')));if(!maven&&!gradle)return null;
  const kind=maven?'maven':'gradle',wrapper=kind==='maven'?'mvnw':'gradlew';if(!(await exists(path.join(root,wrapper))))throw new Error(`Spring ${kind} project requires ${wrapper}`);
  const buildNames=kind==='maven'?['pom.xml','.mvn/wrapper/maven-wrapper.properties']:[...(await exists(path.join(root,'settings.gradle.kts'))?['settings.gradle.kts']:await exists(path.join(root,'settings.gradle'))?['settings.gradle']:[]),...(await exists(path.join(root,'build.gradle.kts'))?['build.gradle.kts']:['build.gradle']),'gradle/wrapper/gradle-wrapper.properties'];
  const buildFiles=[];for(const name of buildNames){const file=path.join(root,name);if(await exists(file))buildFiles.push(await fileFact(root,file))}
  const main=await readFile(path.join(root,kind==='maven'?'pom.xml':buildNames.find(name=>name.startsWith('build.gradle'))!),'utf8'),settings=kind==='gradle'&&buildNames[0]?.startsWith('settings')?await readFile(path.join(root,buildNames[0]),'utf8'):'';
  if(kind==='maven'&&!/(?:spring-boot|org\.springframework\.boot)/i.test(main))return null;
  if(kind==='gradle'&&!/(?:org\.springframework\.boot|spring-boot)/i.test(main))return null;
  const modules=kind==='maven'?[...main.matchAll(/<module>\s*([^<]+)\s*<\/module>/g)].map(match=>match[1].trim()):[...settings.matchAll(/(?:include\s*\(?|includeBuild\s*\(?)[^\n]+/g)].flatMap(match=>[...match[0].matchAll(/['"]:?(.*?)['"]/g)].map(item=>item[1].replaceAll(':','/'))).filter(Boolean);
  const javaVersion=main.match(/<(?:java\.version|maven\.compiler\.(?:source|release))>\s*([^<]+)</)?.[1]?.trim()??main.match(/(?:sourceCompatibility|JavaLanguageVersion\.of)\s*[=( ]+['"]?(\d+)/)?.[1]??null;
  return detectionSchema.parse({kind,root,wrapper,java_version:javaVersion,modules:[...new Set(modules)].sort(),build_files:buildFiles.sort((a,b)=>a.file.localeCompare(b.file)),detected_at:new Date().toISOString()});
}

function impacts(files:string[]){const result=new Set<string>();for(const file of files){if(/\.md$/.test(file))result.add('documentation');else result.add('local_code');if(/(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\/wrapper)/.test(file))result.add('build_system');if(/(?:lock|dependencies|libs\.versions\.toml)/i.test(file))result.add('dependency');if(/(?:migration|db\/|liquibase|flyway)/i.test(file))result.add('migration');if(/(?:security|auth|permission|credential)/i.test(file))result.add('security')}const top=new Set(files.filter(file=>file.includes('/')).map(file=>file.split('/')[0]));if(top.size>1)result.add('cross_module');return[...result] as Array<'documentation'|'local_code'|'cross_module'|'security'|'migration'|'dependency'|'build_system'>}

export async function planV2Gates(root:string,taskId:string,stageValue:z.infer<typeof stageSchema>):Promise<V2GatePlan>{
  const stage=stageSchema.parse(stageValue),task=(await scanTasks(root)).find(item=>item.task_id===taskId);if(!task)throw new Error('task not found');if(task.blocking_reason)throw new Error(`Task is blocked: ${task.blocking_reason}`);const workspace=await readWorkspace(root,taskId),head=await git(workspace.worktree,['rev-parse','HEAD']);
  if(await git(workspace.worktree,['status','--porcelain=v1','--untracked-files=all']))throw new Error('Gate Planner requires a clean stable candidate');
  const contract=await readApprovedAcceptanceContract(task.path),contractHash=contract.contract_hash;if(typeof contractHash!=='string')throw new Error('v2 Acceptance Contract hash is missing');
  const changed=(await git(workspace.worktree,['diff','--name-only',`${workspace.base_commit}...${head}`])).split('\n').filter(Boolean).sort(),impact=impacts(changed),toolchain=await detectSpringBoot(workspace.worktree),modules=toolchain?.modules.filter(module=>changed.some(file=>file===module||file.startsWith(`${module}/`)))??[];
  const scopeKind=stage==='phase'?'wave':'task',coverage=stage==='phase'?'full':'targeted';if(stage==='phase'&&contract.risk!=='heavy')throw new Error('phase full Gate Plan requires a Heavy Task');
  const selected=selectedGates(contract);
  const triggers=[] as string[];if(impact.includes('security'))triggers.push('security-sensitive files changed; independent verification and expanded security checks are recommended');if(impact.includes('migration'))triggers.push('database migration changed; migration/rollback evidence is required');if(impact.includes('dependency')||impact.includes('build_system'))triggers.push('dependency or build system changed; clean build and dependency checks are recommended');if(impact.includes('cross_module'))triggers.push('multiple modules changed; direct dependents and integration tests are recommended');
  const cost=Math.max(1,selected.length*3+(modules.length||0)*2+triggers.length*5)*(stage==='phase'?3:stage==='delivery'?2:1),resourceClass=cost>30?'large':cost>10?'medium':'small';
  const withoutHash={schema_version:2 as const,task_id:taskId,stage,scope_kind:scopeKind as 'task'|'wave',coverage:coverage as 'targeted'|'full',execution_authorized:false as const,requires_explicit_authorization:stage!=='feedback',head,base_commit:workspace.base_commit,contract_hash:contractHash,environment_hash:await currentGateEnvironmentHash(root,taskId),toolchain_hash:toolchainHash(toolchain),changed_files:changed,impact,selected_modules:modules,selected_gates:selected,skipped_gates:[],escalation_triggers:triggers,estimated_cost:{minutes:cost,resource_class:resourceClass as 'small'|'medium'|'large'},toolchain,created_at:new Date().toISOString()},plan=planSchema.parse({...withoutHash,plan_hash:sha256(JSON.stringify(withoutHash))});const file=path.join(root,'.spec-loop','output',`${taskId}-gate-plan-${stage}.json`);await atomicWriteMany(root,[{file,content:`${JSON.stringify(plan,null,2)}\n`}]);return plan;
}

export async function verifyV2GatePlan(root:string,taskId:string,stageValue:z.infer<typeof stageSchema>){
  const stage=stageSchema.parse(stageValue),file=path.join(root,'.spec-loop','output',`${taskId}-gate-plan-${stage}.json`),plan=planSchema.parse(JSON.parse(await readFile(file,'utf8'))),{plan_hash:_hash,...facts}=plan;
  if(plan.task_id!==taskId||plan.plan_hash!==sha256(JSON.stringify(facts)))throw new Error('v2 Gate Plan identity or hash is invalid');
  const task=(await scanTasks(root)).find(item=>item.task_id===taskId);if(!task)throw new Error('task not found');if(task.blocking_reason)throw new Error(`Task is blocked: ${task.blocking_reason}`);const workspace=await readWorkspace(root,taskId),head=await git(workspace.worktree,['rev-parse','HEAD']);if(head!==plan.head||await git(workspace.worktree,['status','--porcelain=v1','--untracked-files=all']))throw new Error('v2 Gate Plan candidate HEAD is stale');
  const contract=await readApprovedAcceptanceContract(task.path);if(contract.contract_hash!==plan.contract_hash)throw new Error('v2 Gate Plan Contract binding is stale');
  if(plan.environment_hash!==await currentGateEnvironmentHash(root,taskId))throw new Error('v2 Gate Plan environment changed after planning');
  if(plan.toolchain_hash!==toolchainHash(await detectSpringBoot(workspace.worktree)))throw new Error('v2 Gate Plan toolchain changed after planning');
  if(JSON.stringify(plan.selected_gates)!==JSON.stringify(selectedGates(contract)))throw new Error('v2 Gate Plan changed P-approved use case, assertion or Evidence mapping');
  const criteria=new Set<string>((contract.criteria??[]).map((item:any)=>item.id)),covered=new Set(plan.selected_gates.flatMap(item=>item.ac));if([...criteria].some(id=>!covered.has(id)))throw new Error('v2 Gate Plan shrinks approved AC coverage');
  for(const tool of contract.tools??[]){const selected=plan.selected_gates.find(item=>item.tool_id===tool.id);if(!selected||selected.gate_id!==tool.gate_id)throw new Error(`v2 Gate Plan changed approved tool ${tool.id}`)}
  if(plan.toolchain)for(const fact of plan.toolchain.build_files){const target=path.resolve(workspace.worktree,fact.file);if(!target.startsWith(path.resolve(workspace.worktree)+path.sep)||sha256(await readFile(target))!==fact.sha256)throw new Error(`Toolchain file changed after planning: ${fact.file}`)}
  return plan;
}

async function nonSymbolicPath(root:string,target:string):Promise<string>{
  const base=path.resolve(root),absolute=path.resolve(target),rel=path.relative(base,absolute);
  if(!rel||rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))throw new Error('Spring Evidence path escapes or equals the candidate root');
  let current=base;
  for(const part of rel.split(path.sep)){
    current=path.join(current,part);
    const info=await lstat(current);
    if(info.isSymbolicLink())throw new Error(`Spring Evidence path is symbolic: ${current}`);
  }
  const actual=await realpath(absolute),canonicalBase=await realpath(base);
  if(!actual.startsWith(`${canonicalBase}${path.sep}`))throw new Error('Spring Evidence realpath escapes the candidate root');
  return actual;
}

async function reportFiles(root:string):Promise<string[]>{
  const result:string[]=[],started=Date.now();let visited=0;
  async function walk(dir:string):Promise<void>{
    if(Date.now()-started>60_000)throw new Error('Spring report discovery timed out after 60s');
    for(const entry of await readdir(dir,{withFileTypes:true})){
      if(++visited>100_000)throw new Error('Spring report discovery exceeded 100000 entries');
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink())throw new Error(`Spring Evidence path is symbolic: ${file}`);
      if(entry.isDirectory())await walk(file);
      else if(entry.isFile()&&/^(?:TEST-.*\.xml|jacoco\.xml)$/.test(entry.name))result.push(file);
    }
  }
  await walk(root);return result.sort();
}
function numberAttribute(tag:string,name:string){const value=tag.match(new RegExp(`\\b${name}=["'](\\d+)["']`))?.[1];if(value===undefined)throw new Error(`Spring XML is missing ${name}`);return Number(value)}
function springGate(contract:Record<string,any>,gates:Awaited<ReturnType<typeof verifiedGateResults>>,wrapper:string,head:string,environmentHash:string){
  const tools=(contract.tools??[]).filter((tool:any)=>tool.command?.[0]===`./${wrapper}`);
  if(tools.length!==1)throw new Error('Spring Evidence requires exactly one P-approved wrapper Gate');
  const tool=tools[0],gate=gates.find(item=>item.id===tool.gate_id);
  if(!gate||gate.kind!=='command'||gate.head!==head||gate.exit_code!==0||gate.timed_out||gate.environment_hash!==environmentHash||JSON.stringify(gate.command)!==JSON.stringify(tool.command))throw new Error('Spring Gate is missing, failed, or stale');
  return gate;
}

export async function collectSpringEvidence(root:string,taskId:string,reportsDirectory:string){
  await verifyTaskExecutionApproval(root,taskId);
  const task=(await scanTasks(root)).find(item=>item.task_id===taskId);if(!task)throw new Error('task not found');
  if(task.blocking_reason)throw new Error(`Task is blocked: ${task.blocking_reason}`);
  const workspace=await readWorkspace(root,taskId),head=await git(workspace.worktree,['rev-parse','HEAD']),worktree=await realpath(workspace.worktree);
  const reportsRoot=await nonSymbolicPath(workspace.worktree,reportsDirectory);
  if(!(await stat(reportsRoot)).isDirectory())throw new Error('Spring reports path is not a directory');
  const toolchain=await detectSpringBoot(worktree);if(!toolchain)throw new Error('Spring Boot toolchain was not detected');
  const contract=await readApprovedAcceptanceContract(task.path);
  const gate=springGate(contract,await verifiedGateResults(root,taskId),toolchain.wrapper,head,await currentGateEnvironmentHash(root,taskId)),gateStarted=Date.parse(gate.created_at),gateEnded=gateStarted+gate.duration_ms;
  const files=await reportFiles(reportsRoot);if(!files.some(file=>path.basename(file).startsWith('TEST-')))throw new Error('Spring test reports are missing');
  let total=0,failures=0,errors=0,skipped=0,coverage:{covered:number;missed:number}|null=null;const reports=[];
  for(const file of files){
    await nonSymbolicPath(worktree,file);
    const info=await stat(file);if(info.mtimeMs<gateStarted-1000||info.mtimeMs>gateEnded+2000)throw new Error(`Spring report is stale for the verified Gate: ${file}`);
    const content=await readFile(file,'utf8');reports.push(await fileFact(worktree,file));
    if(path.basename(file)==='jacoco.xml'){
      const counters=[...content.matchAll(/<counter\s+type=["'](?:LINE|INSTRUCTION)["'][^>]*>/g)];
      if(!/<\/report>/.test(content))throw new Error('invalid JaCoCo XML report');
      if(counters.length){const tag=counters.at(-1)![0];coverage={covered:numberAttribute(tag,'covered'),missed:numberAttribute(tag,'missed')}}
    }else{
      const suites=[...content.matchAll(/<testsuite\b[^>]*>/g)];
      if(!suites.length||!/<\/testsuite>/.test(content))throw new Error('invalid Spring test XML report');
      for(const match of suites){total+=numberAttribute(match[0],'tests');failures+=numberAttribute(match[0],'failures');errors+=numberAttribute(match[0],'errors');skipped+=numberAttribute(match[0],'skipped')}
      if(/<(?:failure|error|skipped)(?:\s|>)/.test(content)&&!/(?:failures|errors|skipped)=["'][1-9]/.test(content))throw new Error('Spring XML contains an uncounted failure or skip');
    }
  }
  if(total===0)throw new Error('Spring test reports contain zero tests');
  if(failures||errors||skipped)throw new Error(`Spring tests are not clean: failures=${failures} errors=${errors} skipped=${skipped}`);
  const facts={schema_version:1 as const,task_id:taskId,head,framework:'spring-boot' as const,toolchain:toolchain.kind,environment_hash:await currentGateEnvironmentHash(root,taskId),toolchain_hash:toolchainHash(toolchain)!,gate_id:gate.id,gate_sha256:gate.sha256,gate_plan_sha256:gate.plan_sha256,reports_root:relative(worktree,reportsRoot),tests:{total,failures,errors,skipped},coverage,reports,created_at:new Date().toISOString()};
  const evidence=springEvidenceSchema.parse({...facts,evidence_hash:sha256(JSON.stringify(facts))});
  await atomicWriteMany(root,[{file:path.join(root,'.spec-loop','output',`${taskId}-spring-evidence.json`),content:`${JSON.stringify(evidence,null,2)}\n`}]);
  return evidence;
}

export async function verifySpringEvidence(root:string,taskId:string){
  const file=path.join(root,'.spec-loop','output',`${taskId}-spring-evidence.json`),evidence=springEvidenceSchema.parse(JSON.parse(await readFile(file,'utf8')));
  const workspace=await readWorkspace(root,taskId),head=await git(workspace.worktree,['rev-parse','HEAD']);
  const {evidence_hash:_hash,...facts}=evidence;
  if(evidence.task_id!==taskId||evidence.head!==head||evidence.evidence_hash!==sha256(JSON.stringify(facts)))throw new Error('Spring Evidence identity, HEAD, or hash is stale');
  const worktree=await realpath(workspace.worktree),toolchain=await detectSpringBoot(worktree);
  if(!toolchain||evidence.toolchain!==toolchain.kind||evidence.toolchain_hash!==toolchainHash(toolchain)||evidence.environment_hash!==await currentGateEnvironmentHash(root,taskId))throw new Error('Spring Evidence toolchain or environment changed');
  const task=(await scanTasks(root)).find(item=>item.task_id===taskId);if(!task)throw new Error('task not found');
  const contract=await readApprovedAcceptanceContract(task.path);
  const gate=springGate(contract,await verifiedGateResults(root,taskId),toolchain.wrapper,head,await currentGateEnvironmentHash(root,taskId));
  if(evidence.gate_id!==gate.id||evidence.gate_sha256!==gate.sha256||evidence.gate_plan_sha256!==gate.plan_sha256)throw new Error('Spring Evidence Gate binding changed');
  const reportsRoot=await nonSymbolicPath(worktree,path.resolve(worktree,evidence.reports_root));
  const actualFiles=(await reportFiles(reportsRoot)).map(file=>relative(worktree,file));
  if(JSON.stringify(actualFiles)!==JSON.stringify(evidence.reports.map(item=>item.file)))throw new Error('Spring report file set changed after collection');
  for(const report of evidence.reports){
    const target=await nonSymbolicPath(worktree,path.resolve(worktree,report.file));
    if(!(await lstat(target)).isFile()||sha256(await readFile(target))!==report.sha256)throw new Error(`Spring report was tampered: ${report.file}`);
  }
  return evidence;
}
