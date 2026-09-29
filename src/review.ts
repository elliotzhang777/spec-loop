import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { atomicWriteMany, assertNoSecrets, assertSubstantive, exists, readMarkdown, sha256, stringifyMarkdown } from './files.js';
import type { HumanReviewRecord, HumanReviewRequirement, ReviewArtifact, TaskState } from './model.js';
import { finishExecutionStep, finishLatestManagedTaskStep, managedProjectRootForTask, startManagedTaskStep } from './execution-events.js';
import { acceptanceSchema, humanReviewSchema, planSchema, stateSchema } from './schemas.js';

const exec = promisify(execFile);
async function observedVisualWrite(root:string,state:TaskState,reviewId:string,summary:string,operation:()=>Promise<void>):Promise<void>{
  const start=await startManagedTaskStep(root,{taskId:state.task_id,round:state.current_round,stepType:'review.visual',label:`视觉 Review ${reviewId}`,summary,refs:[`reviews/${reviewId}.md`]});
  const project=managedProjectRootForTask(root);
  try{await operation()}catch(error){if(start&&project)await finishExecutionStep(project,start,{outcome:'failure'});throw error}
  if(start&&project)await finishExecutionStep(project,start,{outcome:'success'});
}
const mediaTypes = new Map<string, ReviewArtifact['media_type']>([
  ['.png', 'image/png'],
]);

type ReviewEvent = {
  seq: number;
  event: 'requested' | 'decided';
  task_id: string;
  review_id: string;
  round: number;
  code_revision: string;
  request_hash: string;
  acceptance_hash: string;
  artifacts?: ReviewArtifact[];
  requested_at?: string;
  result?: 'approved' | 'rejected';
  reviewer?: string;
  note?: string;
  reviewed_at?: string;
  prev_hash: string | null;
  event_hash: string;
};

function reviewFile(root:string,reviewId:string):string { return path.join(root, 'reviews', `${reviewId}.md`); }
function historyFile(root:string,reviewId:string):string { return path.join(root, 'reviews', `${reviewId}-HISTORY.jsonl`); }
function acceptanceHash(value:unknown):string { return sha256(JSON.stringify(value)); }

export async function canonicalGitRevision(repository:string,revision:string):Promise<string> {
  assertSubstantive(revision, 'candidate Git revision');
  const result = await exec('git', ['-C', repository, 'rev-parse', '--verify', `${revision}^{commit}`], { maxBuffer: 1_000_000, timeout: 30_000, killSignal: 'SIGKILL' })
    .catch(() => { throw new Error(`candidate revision is not a commit in the target repository: ${revision}`); });
  const canonical = result.stdout.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(canonical)) throw new Error('Git returned an invalid candidate revision');
  return canonical;
}

async function stateAndRequirements(root:string):Promise<{state:TaskState;requirements:HumanReviewRequirement[];acceptanceHash:string}> {
  const state = stateSchema.parse((await readMarkdown(path.join(root, 'TASK_STATE.md'))).data);
  const acceptance = acceptanceSchema.parse((await readMarkdown(path.join(root, 'ACCEPTANCE.md'))).data);
  if (acceptance.task_id !== state.task_id) throw new Error('ACCEPTANCE.md identity differs from TASK_STATE.md');
  const hash = acceptanceHash(acceptance);
  if (state.status !== 'draft') {
    const plan = planSchema.parse((await readMarkdown(path.join(root, 'PLAN.md'))).data);
    if (state.acceptance_hash && state.acceptance_hash !== hash) throw new Error('ACCEPTANCE.md changed after plan; review contract is invalid');
    if (plan.acceptance_hash && plan.acceptance_hash !== hash) throw new Error('PLAN.md visual Review binding is invalid');
    if (acceptance.human_reviews.length && (!plan.acceptance_hash||!state.acceptance_hash)) throw new Error('required visual Review is not bound to CLI-managed Task State');
  }
  return { state, requirements: acceptance.human_reviews, acceptanceHash: hash };
}

function requirement(requirements:HumanReviewRequirement[], reviewId:string):HumanReviewRequirement {
  const item = requirements.find((entry) => entry.id === reviewId);
  if (!item || item.kind !== 'visual' || item.required !== true) throw new Error(`${reviewId}: required visual review is not declared in ACCEPTANCE.md`);
  return item;
}

function requestHash(record:Pick<HumanReviewRecord,'task_id'|'review_id'|'kind'|'round'|'code_revision'|'acceptance_hash'|'artifacts'>):string {
  return sha256(JSON.stringify({
    task_id: record.task_id, review_id: record.review_id, kind: record.kind, round: record.round,
    code_revision: record.code_revision, acceptance_hash: record.acceptance_hash, artifacts: record.artifacts,
  }));
}

function eventHash(event:Omit<ReviewEvent,'event_hash'>):string { return sha256(JSON.stringify(event)); }

async function readHistory(root:string,reviewId:string):Promise<ReviewEvent[]> {
  const file = historyFile(root, reviewId);
  if (!(await exists(file))) return [];
  const lines = (await readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  const events:ReviewEvent[] = [];
  for (const [index,line] of lines.entries()) {
    let event:ReviewEvent;
    try { event = JSON.parse(line) as ReviewEvent; } catch { throw new Error(`${reviewId}: malformed review history at line ${index + 1}`); }
    const { event_hash, ...unsigned } = event;
    if (event.seq !== index + 1 || event.prev_hash !== (events.at(-1)?.event_hash ?? null) || event_hash !== eventHash(unsigned)) {
      throw new Error(`${reviewId}: review history hash chain mismatch`);
    }
    events.push(event);
  }
  return events;
}

function appendEvent(events:ReviewEvent[],value:Omit<ReviewEvent,'seq'|'prev_hash'|'event_hash'>):ReviewEvent {
  const unsigned = { seq: events.length + 1, ...value, prev_hash: events.at(-1)?.event_hash ?? null };
  return { ...unsigned, event_hash: eventHash(unsigned) };
}

function historyContent(events:ReviewEvent[]):string { return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`; }

function projection(record:HumanReviewRecord):string {
  const artifactList = record.artifacts.map((item) => `- ${item.file} (${item.media_type}, sha256 ${item.sha256})`).join('\n');
  return stringifyMarkdown(record, `# Visual Review — ${record.review_id}\n\n## Evidence\n\n${artifactList}\n\n## Decision\n\n${record.note || '等待人工查看效果图并作出决定。'}`);
}

function safeName(file:string):string {
  const name = path.basename(file).replace(/[^A-Za-z0-9._-]/g, '-');
  if (!name || name === '.' || name === '..') throw new Error(`invalid review artifact name: ${file}`);
  return name;
}

const crcTable=Array.from({length:256},(_,value)=>{
  let crc=value;
  for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  return crc>>>0;
});

function crc32(content:Buffer):number {
  let crc=0xffffffff;
  for(const byte of content)crc=(crc>>>8)^crcTable[(crc^byte)&0xff];
  return (crc^0xffffffff)>>>0;
}

/** Fully inflate and validate the PNG scanline container; header-only lookalikes fail closed. */
export function validImage(content:Buffer,mediaType:ReviewArtifact['media_type']):boolean {
  if(mediaType!=='image/png'||content.length<57||content.length>50_000_000||!content.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return false;
  let offset=8,width=0,height=0,bitDepth=0,colorType=-1,seenIhdr=false,seenIdat=false,seenIend=false,idatEnded=false,hasPalette=false;
  const compressed:Buffer[]=[];
  while(offset+12<=content.length){
    const length=content.readUInt32BE(offset),type=content.subarray(offset+4,offset+8).toString('ascii'),dataStart=offset+8,end=dataStart+length,chunkEnd=end+4;
    if(chunkEnd>content.length||crc32(content.subarray(offset+4,end))!==content.readUInt32BE(end))return false;
    if(!seenIhdr&&type!=='IHDR')return false;
    if(type==='IHDR'){
      if(seenIhdr||length!==13)return false;
      width=content.readUInt32BE(dataStart);height=content.readUInt32BE(dataStart+4);bitDepth=content[dataStart+8];colorType=content[dataStart+9];
      if(!width||!height||width>16384||height>16384||content[dataStart+10]!==0||content[dataStart+11]!==0||content[dataStart+12]!==0)return false;
      const legalDepths:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if(!legalDepths[colorType]?.includes(bitDepth))return false;
      seenIhdr=true;
    }else if(type==='PLTE'){
      if(seenIdat||length===0||length%3!==0||length>768)return false;
      hasPalette=true;
    }else if(type==='IDAT'){
      if(idatEnded||length===0)return false;
      seenIdat=true;compressed.push(content.subarray(dataStart,end));
    }else if(type==='IEND'){
      if(length!==0||chunkEnd!==content.length)return false;
      seenIend=true;offset=chunkEnd;break;
    }else if(seenIdat){
      idatEnded=true;
    }
    offset=chunkEnd;
  }
  if(!seenIhdr||!seenIdat||!seenIend||(colorType===3&&!hasPalette))return false;
  const channels:Record<number,number>={0:1,2:3,3:1,4:2,6:4};
  const rowBytes=Math.ceil(width*channels[colorType]*bitDepth/8),expected=height*(rowBytes+1);
  if(!Number.isSafeInteger(expected)||expected<1||expected>100_000_000)return false;
  try{
    const decoded=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected});
    if(decoded.length!==expected)return false;
    for(let row=0;row<height;row++)if(decoded[row*(rowBytes+1)]>4)return false;
  }catch{return false}
  return true;
}

async function validateRecordHistory(root:string,record:HumanReviewRecord):Promise<void> {
  const events = await readHistory(root, record.review_id);
  const tail = events.at(-1);
  if (!tail || tail.event_hash !== record.history_tail_hash) throw new Error(`${record.review_id}: review projection differs from append-only history`);
  const requests = events.filter((event) => event.event === 'requested' && event.request_hash === record.request_hash);
  const request = requests.at(-1);
  if (!request || request.task_id !== record.task_id || request.round !== record.round || request.code_revision !== record.code_revision
    || request.acceptance_hash !== record.acceptance_hash || request.requested_at !== record.requested_at
    || JSON.stringify(request.artifacts) !== JSON.stringify(record.artifacts)) throw new Error(`${record.review_id}: request history differs from projection`);
  if (record.status === 'pending') {
    if (tail.event !== 'requested' || record.decision_hash !== null) throw new Error(`${record.review_id}: pending review history is inconsistent`);
  } else {
    if (tail.event !== 'decided' || record.decision_hash !== tail.event_hash || tail.request_hash !== record.request_hash
      || tail.result !== record.status || tail.reviewer !== record.reviewer || tail.note !== record.note || tail.reviewed_at !== record.reviewed_at) {
      throw new Error(`${record.review_id}: decision history differs from projection`);
    }
  }
}

export async function requestVisualReview(root:string,reviewId:string,revision:string,evidenceFiles:string[]):Promise<HumanReviewRecord> {
  const { state, requirements, acceptanceHash: contractHash } = await stateAndRequirements(root);
  requirement(requirements, reviewId);
  if (!['working', 'iterating'].includes(state.status)) throw new Error(`visual review request is illegal in ${state.status}`);
  if (state.current_round < 1) throw new Error('visual review requires an active Round');
  const canonicalRevision = await canonicalGitRevision(state.repository, revision);
  if (!evidenceFiles.length) throw new Error('visual review requires at least one screenshot');

  const artifacts:ReviewArtifact[] = [];
  const writes:Array<{file:string;content:string|Buffer}> = [];
  for (const source of evidenceFiles) {
    const absolute = path.resolve(source);
    const info = await lstat(absolute).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error(`visual review artifact must be a regular file: ${source}`);
    const mediaType = mediaTypes.get(path.extname(absolute).toLowerCase());
    if (!mediaType) throw new Error(`visual review only accepts PNG screenshots: ${source}`);
    const content = await readFile(absolute);
    if (!validImage(content, mediaType)) throw new Error(`visual review artifact is not a valid ${mediaType} image: ${source}`);
    const hash = sha256(content);
    const relative = path.posix.join('reviews', reviewId, `round-${String(state.current_round).padStart(4, '0')}`, `${hash.slice(0, 12)}-${safeName(absolute)}`);
    artifacts.push({ file: relative, sha256: hash, media_type: mediaType });
    writes.push({ file: path.join(root, relative), content });
  }
  if (new Set(artifacts.map((item) => item.sha256)).size !== artifacts.length) throw new Error('visual review screenshots must be unique');

  const base = { task_id: state.task_id, review_id: reviewId, kind: 'visual' as const, round: state.current_round, code_revision: canonicalRevision, acceptance_hash: contractHash, artifacts };
  const hash = requestHash(base);
  if (await exists(reviewFile(root, reviewId))) {
    const current = humanReviewSchema.parse((await readMarkdown(reviewFile(root, reviewId))).data) as HumanReviewRecord;
    await validateRecordHistory(root,current);
    if (current.request_hash === hash && current.status !== 'rejected') return current;
    if (current.request_hash === hash) throw new Error('a rejected visual review requires changed evidence or revision before re-request');
  }
  const requestedAt = new Date().toISOString();
  const events = await readHistory(root,reviewId);
  const event = appendEvent(events,{
    event:'requested',task_id:state.task_id,review_id:reviewId,round:state.current_round,code_revision:canonicalRevision,
    request_hash:hash,acceptance_hash:contractHash,artifacts,requested_at:requestedAt,
  });
  const record = humanReviewSchema.parse({
    schema_version:1,...base,status:'pending',request_hash:hash,requested_at:requestedAt,
    history_tail_hash:event.event_hash,decision_hash:null,reviewer:null,reviewed_at:null,note:'',
  }) as HumanReviewRecord;
  await observedVisualWrite(root,state,reviewId,'记录当前截图的视觉 Review 请求',()=>atomicWriteMany(root,[...writes,{file:reviewFile(root,reviewId),content:projection(record)},{file:historyFile(root,reviewId),content:historyContent([...events,event])}]));
  await startManagedTaskStep(root, {
    taskId: state.task_id, round: state.current_round, stepType: 'wait.user', wait: true,
    label: `等待视觉确认 ${reviewId}`, summary: '等待用户检查当前 revision 的截图效果并批准或拒绝',
    refs: [`reviews/${reviewId}.md`],
  });
  return record;
}

export async function decideVisualReview(root:string,reviewId:string,result:'approved'|'rejected',reviewer:string,note:string,controllerCommandId?:string):Promise<HumanReviewRecord> {
  const { state, requirements, acceptanceHash: contractHash } = await stateAndRequirements(root);
  requirement(requirements, reviewId);
  assertSubstantive(reviewer, 'visual reviewer'); assertSubstantive(note, 'visual review note');
  assertNoSecrets(`${reviewer}\n${note}`, 'visual review decision');
  const file = reviewFile(root, reviewId);
  if (!(await exists(file))) throw new Error(`${reviewId}: no pending visual review request`);
  const current = humanReviewSchema.parse((await readMarkdown(file)).data) as HumanReviewRecord;
  await validateRecordHistory(root,current);
  const effectFile=controllerCommandId?path.join(root,'controller-effects',`${controllerCommandId}.json`):null;
  if(effectFile){
    const effectInfo=await lstat(effectFile).catch(()=>null);
    if(effectInfo){
      if(!effectInfo.isFile()||effectInfo.isSymbolicLink())throw new Error('visual review Controller effect marker is invalid');
      const effect=JSON.parse(await readFile(effectFile,'utf8')) as {command_id?:string;review_id?:string;result?:string;decision_hash?:string};
      if(effect.command_id!==controllerCommandId||effect.review_id!==reviewId||effect.result!==result||effect.decision_hash!==current.decision_hash)
        throw new Error('visual review Controller effect marker differs from the command');
      return current;
    }
  }
  if (current.status !== 'pending') throw new Error(`${reviewId}: visual review is already ${current.status}`);
  if (current.task_id !== state.task_id || current.round !== state.current_round || current.acceptance_hash !== contractHash) throw new Error(`${reviewId}: stale visual review request`);
  await canonicalGitRevision(state.repository,current.code_revision);
  const reviewedAt = new Date().toISOString(),events=await readHistory(root,reviewId);
  const event=appendEvent(events,{
    event:'decided',task_id:state.task_id,review_id:reviewId,round:current.round,code_revision:current.code_revision,
    request_hash:current.request_hash,acceptance_hash:contractHash,result,reviewer,note,reviewed_at:reviewedAt,
  });
  const record = humanReviewSchema.parse({
    ...current,status:result,reviewer,reviewed_at:reviewedAt,note,history_tail_hash:event.event_hash,decision_hash:event.event_hash,
  }) as HumanReviewRecord;
  const writes:Array<{file:string;content:string}>=[{file,content:projection(record)},{file:historyFile(root,reviewId),content:historyContent([...events,event])}];
  if(effectFile)writes.push({file:effectFile,content:`${JSON.stringify({schema_version:1,command_id:controllerCommandId,review_id:reviewId,result,decision_hash:record.decision_hash},null,2)}\n`});
  await observedVisualWrite(root,state,reviewId,'记录用户对当前截图的视觉结论',()=>atomicWriteMany(root,writes));
  await finishLatestManagedTaskStep(root, {
    taskId: state.task_id, round: state.current_round, stepType: 'wait.user', outcome: result === 'approved' ? 'success' : 'failure',
    summary: `视觉确认 ${reviewId}：${result}`, refs: [`reviews/${reviewId}.md`],
  });
  return record;
}

export async function readVisualReviews(root:string):Promise<HumanReviewRecord[]> {
  const { requirements } = await stateAndRequirements(root);
  const result:HumanReviewRecord[] = [];
  for (const item of requirements) {
    const file = reviewFile(root,item.id);
    if (await exists(file)) {
      const record=humanReviewSchema.parse((await readMarkdown(file)).data) as HumanReviewRecord;
      await validateRecordHistory(root,record); result.push(record);
    }
  }
  return result;
}

export async function validateRequiredHumanReviews(root:string,state:TaskState,revision:string,pendingApprovals:ReadonlyMap<string,string>=new Map()):Promise<string[]> {
  const { requirements, acceptanceHash: contractHash } = await stateAndRequirements(root);
  if (!requirements.length) return [];
  const canonicalRevision = await canonicalGitRevision(state.repository,revision);
  for (const item of requirements) {
    const file = reviewFile(root,item.id);
    if (!(await exists(file))) throw new Error(`${item.id}: required visual review has not been requested`);
    const record = humanReviewSchema.parse((await readMarkdown(file)).data) as HumanReviewRecord;
    await validateRecordHistory(root,record);
    if (record.task_id !== state.task_id || record.review_id !== item.id || record.kind !== item.kind) throw new Error(`${item.id}: visual review identity mismatch`);
    if (record.status !== 'approved' && !(record.status === 'pending' && pendingApprovals.get(record.review_id) === record.request_hash)) throw new Error(`${item.id}: required visual review is ${record.status}`);
    if (record.round !== state.current_round || record.code_revision !== canonicalRevision || record.acceptance_hash !== contractHash) throw new Error(`${item.id}: visual review is stale for current Round, revision or Acceptance`);
    if (record.request_hash !== requestHash(record)) throw new Error(`${item.id}: visual review request hash mismatch`);
    for (const artifact of record.artifacts) {
      const target = path.resolve(root,artifact.file);
      if (!target.startsWith(path.resolve(root)+path.sep)) throw new Error(`${item.id}: visual review artifact escapes task root`);
      const info=await lstat(target).catch(()=>null);
      if (!info||!info.isFile()||info.isSymbolicLink()) throw new Error(`${item.id}: visual review artifact is missing or invalid`);
      const content=await readFile(target);
      if (sha256(content)!==artifact.sha256||!validImage(content,artifact.media_type)) throw new Error(`${item.id}: visual review artifact hash or media validation failed`);
    }
  }
  return requirements.map((item)=>item.id);
}
