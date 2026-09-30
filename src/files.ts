import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { withOwnedDirectoryLock } from './owned-lock.js';

export interface MarkdownDoc { data: unknown; body: string }

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function stringifyMarkdown(data: unknown, body: string): string {
  return `---\n${YAML.stringify(data).trimEnd()}\n---\n\n${body.trim()}\n`;
}

export async function readMarkdown(file: string): Promise<MarkdownDoc> {
  const raw = await readFile(file, 'utf8');
  if (!raw.startsWith('---\n')) throw new Error(`${path.basename(file)}: missing YAML frontmatter`);
  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) throw new Error(`${path.basename(file)}: unterminated YAML frontmatter`);
  const yaml = raw.slice(4, end);
  let data: unknown;
  try { data = YAML.parse(yaml, { uniqueKeys: true, strict: true }); }
  catch (error) { throw new Error(`${path.basename(file)}: invalid YAML: ${(error as Error).message}`); }
  return { data, body: raw.slice(end + 5).trim() };
}

export async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; } catch { return false; }
}

const BARE_PLACEHOLDER = /^(?:unknown|未知|tbd|todo|placeholder|fill me|lorem ipsum|待填写|待补充)[\s。.!！?？:：-]*$/i;
const EXPLICIT_PLACEHOLDER_MARKER = /\b(?:todo|tbd)\b|待填写|待补充/gi;
const EXPLANATORY_MARKER_GROUP = /(?:仅含|单独|显式)\s*(?:todo|tbd|待填写|待补充)(?:\s*[/、和或]\s*(?:todo|tbd|待填写|待补充))*\s*(?:等)?\s*(?:占位内容|占位词)(?:仍|应|必须)?(?:被)?(?:拒绝|不允许)|\breject\s+(?:standalone|bare|explicit)\s+(?:todo|tbd)(?:\s*[/,]\s*(?:todo|tbd))*\s+placeholders?\b/gi;
const EXPLANATORY_ENGLISH_MENTION = /^(?:todo|tbd)\s+(?:(?:is|means|denotes|refers to)\s+(?:an?\s+)?(?:placeholder|marker|term)|(?:must|should)\s+(?:be\s+)?(?:rejected|avoided|not\s+used))\b/i;
const EXPLANATORY_CHINESE_MENTION = /^(?:待填写|待补充)(?:等)?(?:占位内容|占位词|应被拒绝|必须拒绝)/;
const EXPLICIT_FILL_DIRECTIVE = /(?:^|[:：;；]\s*)placeholder\b(?!\s+(?:term|word|rule|marker)\b)|\b(?:is|stays|remains)\s+placeholder\b|\bfill\s+me\b|\blorem\s+ipsum\b/i;
const TEMPLATE_MARKER = /<[^>]+>|\{\{[^}]+\}\}/;
const FILL_INSTRUCTION = /\b(?:complete|fill(?:\s+in)?)\s+(?:this\s+)?(?:todo|field)\b/i;
export function assertSubstantive(value: string, label: string): void {
  const normalized = value.trim();
  const unresolvedPlaceholder = normalized.split(/[,，;；。.!！?？\n]+/).some((clause) => {
    const markers = [...clause.matchAll(EXPLICIT_PLACEHOLDER_MARKER)];
    if (!markers.length) return false;
    const explainedGroups = [...clause.matchAll(EXPLANATORY_MARKER_GROUP)];
    return markers.some((marker) => {
      if (explainedGroups.some((group) => marker.index >= group.index && marker.index < group.index + group[0].length)) return false;
      const mention = clause.slice(marker.index);
      return !EXPLANATORY_ENGLISH_MENTION.test(mention) && !EXPLANATORY_CHINESE_MENTION.test(mention);
    });
  });
  if (normalized.length < 3 || BARE_PLACEHOLDER.test(normalized) || unresolvedPlaceholder || EXPLICIT_FILL_DIRECTIVE.test(normalized) || TEMPLATE_MARKER.test(normalized) || FILL_INSTRUCTION.test(normalized)) throw new Error(`${label}: empty or placeholder content`);
}

export function assertNoSecrets(value: string, label: string): void {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:password|passwd|cookie|token)\s*[:=]\s*[^\s]{6,}/i,
    /\b(?:ghp_|sk-|xox[baprs]-)[A-Za-z0-9_-]{8,}/,
  ];
  if (patterns.some((re) => re.test(value))) throw new Error(`${label}: possible secret is forbidden`);
}

interface TxWrite { target: string; temp: string; hash: string }
interface Journal { id: string; status: 'prepared'; writes: TxWrite[] }
interface CrossRootJournal extends Journal { allowed_roots: string[] }
const localTransactionTails=new Map<string,Promise<void>>();

async function withLocalTransactionQueue<T>(key:string,operation:()=>Promise<T>):Promise<T>{
  const previous=localTransactionTails.get(key)??Promise.resolve();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve}),tail=previous.then(()=>gate);localTransactionTails.set(key,tail);await previous;
  try{return await operation()}finally{release();if(localTransactionTails.get(key)===tail)localTransactionTails.delete(key)}
}

async function safeTransactionDirectory(root:string,name:string):Promise<string> {
  const dir=path.join(root,name),existing=await lstat(dir).catch(()=>null);
  if(existing&&(existing.isSymbolicLink()||!existing.isDirectory()))throw new Error(`transaction directory is symbolic or not a directory: ${dir}`);
  if(!existing)await mkdir(dir,{recursive:false});
  const info=await lstat(dir),rootReal=await realpath(root),actual=await realpath(dir);
  if(info.isSymbolicLink()||!info.isDirectory()||!actual.startsWith(rootReal+path.sep))throw new Error(`transaction directory escapes root: ${dir}`);
  return dir;
}

async function safeTarget(root: string, target: string): Promise<string> {
  const resolved = path.resolve(target);
  const normalizedRoot = path.resolve(root);
  const prefix = normalizedRoot + path.sep;
  if (!resolved.startsWith(prefix)) throw new Error(`transaction target escapes task directory: ${target}`);
  const rootInfo = await lstat(normalizedRoot).catch(() => null);
  if (!rootInfo || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`transaction root is missing, symbolic, or not a directory: ${root}`);
  const rootReal = await realpath(normalizedRoot);
  let current = normalizedRoot;
  for (const segment of path.relative(normalizedRoot, path.dirname(resolved)).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch(() => null);
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`transaction target parent is symbolic or not a directory: ${current}`);
    const actual = await realpath(current);
    if (actual !== rootReal && !actual.startsWith(rootReal + path.sep)) throw new Error(`transaction target parent escapes task directory: ${current}`);
  }
  const targetInfo = await lstat(resolved).catch(() => null);
  if (targetInfo?.isSymbolicLink()) throw new Error(`transaction target may not be a symbolic link: ${target}`);
  return resolved;
}

async function withFileTransactionLock<T>(root:string,name:string,operation:()=>Promise<T>):Promise<T>{
  return withOwnedDirectoryLock(path.join(root,name),{
    name:`file transaction ${name}`,maxWaitMs:30_000,pollMs:10,missingOwnerProtectionMs:30_000,
  },operation);
}
async function withTransactionLock<T>(root:string,name:string,operation:()=>Promise<T>):Promise<T>{return withLocalTransactionQueue(`${path.resolve(root)}:${name}`,()=>withFileTransactionLock(root,name,operation))}

async function recoverTransactionsUnlocked(root: string): Promise<void> {
  const dir = path.join(root, '.spec-loop-tx');
  if (!(await exists(dir))) return;
  await safeTransactionDirectory(root,'.spec-loop-tx');
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    const journalPath = path.join(dir, name);
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal;
    for (const write of journal.writes) {
      const target = await safeTarget(root, write.target);
      const temp = await safeTarget(root, write.temp);
      if (await exists(temp)) {
        const content = await readFile(temp);
        if (sha256(content) !== write.hash) throw new Error(`transaction ${journal.id}: corrupt temp file`);
        await mkdir(path.dirname(target), { recursive: true });
        await rename(temp, target);
      } else if (await exists(target)) {
        const content = await readFile(target);
        if (sha256(content) !== write.hash) throw new Error(`transaction ${journal.id}: target diverged`);
      } else {
        throw new Error(`transaction ${journal.id}: missing temp and target`);
      }
    }
    await rm(journalPath);
  }
}

export async function recoverTransactions(root:string):Promise<void>{return withTransactionLock(root,'.spec-loop-tx-lock',()=>recoverTransactionsUnlocked(root))}

export async function atomicWriteMany(root: string, values: Array<{ file: string; content: string | Buffer }>): Promise<void> {
  await withTransactionLock(root,'.spec-loop-tx-lock',async()=>{
    await recoverTransactionsUnlocked(root);
    const txDir = await safeTransactionDirectory(root,'.spec-loop-tx');
    const id = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const writes: TxWrite[] = [];
    for (let i = 0; i < values.length; i++) {
      const target = await safeTarget(root, values[i].file);
      const temp = await safeTarget(root,path.join(txDir, `${id}-${i}.tmp`));
      await writeFile(temp, values[i].content);
      writes.push({ target, temp, hash: sha256(values[i].content) });
    }
    const journalPath = await safeTarget(root,path.join(txDir, `${id}.json`));
    await writeFile(journalPath, JSON.stringify({ id, status: 'prepared', writes } satisfies Journal, null, 2));
    await recoverTransactionsUnlocked(root);
  });
}

// Heartbeats are disposable single-file telemetry, not recoverable facts. Keep
// them in the same ordering/lock domain as facts, but never journal a stale
// heartbeat for replay after its caller timed out or the process stopped.
export async function atomicWriteTelemetry(root: string, value: { file: string; content: string | Buffer }, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await withTransactionLock(root, '.spec-loop-tx-lock', async () => {
    signal.throwIfAborted();
    const target = await safeTarget(root, value.file);
    await mkdir(path.dirname(target), { recursive: true });
    const txDir = await safeTransactionDirectory(root, '.spec-loop-tx');
    const temp = path.join(txDir, `telemetry-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
    try {
      signal.throwIfAborted();
      await writeFile(temp, value.content, { signal });
      signal.throwIfAborted();
      await rename(temp, target);
    } finally { await rm(temp, { force: true }); }
  });
}

export async function removeTelemetryFile(root: string, file: string, shouldRemove: () => Promise<boolean> = async () => true): Promise<void> {
  await withTransactionLock(root, '.spec-loop-tx-lock', async () => {
    const target = await safeTarget(root, file);
    if (await shouldRemove()) await rm(target, { force: true });
  });
}

function withinAnyRoot(file: string, roots: string[]): boolean {
  const resolved = path.resolve(file);
  return roots.some((root) => resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep));
}

async function recoverCrossRootTransactionsUnlocked(coordinatorRoot: string, allowedRoots: string[]): Promise<void> {
  const dir = path.join(coordinatorRoot, '.spec-loop-cross-tx');
  if (!(await exists(dir))) return;
  await safeTransactionDirectory(coordinatorRoot,'.spec-loop-cross-tx');
  const normalized = allowedRoots.map((root) => path.resolve(root));
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    const journalPath = path.join(dir, name);
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as CrossRootJournal;
    if (journal.allowed_roots.length !== normalized.length || journal.allowed_roots.some((root) => !normalized.includes(root))) throw new Error(`cross-root transaction ${journal.id}: allowed roots changed`);
    for (const write of journal.writes) {
      if (!withinAnyRoot(write.target, normalized) || !withinAnyRoot(write.temp, normalized)) throw new Error(`cross-root transaction ${journal.id}: path escapes allowed roots`);
      const targetOwner=normalized.find((root)=>path.resolve(write.target).startsWith(root+path.sep));
      const tempOwner=normalized.find((root)=>path.resolve(write.temp).startsWith(root+path.sep));
      if(!targetOwner||!tempOwner)throw new Error(`cross-root transaction ${journal.id}: path has no allowed owner`);
      const target=await safeTarget(targetOwner,write.target),temp=await safeTarget(tempOwner,write.temp);
      if (await exists(temp)) {
        const content = await readFile(temp);
        if (sha256(content) !== write.hash) throw new Error(`cross-root transaction ${journal.id}: corrupt temp file`);
        await mkdir(path.dirname(target), { recursive: true });
        await rename(temp, target);
      } else if (!(await exists(target)) || sha256(await readFile(target)) !== write.hash) {
        throw new Error(`cross-root transaction ${journal.id}: target diverged or is missing`);
      }
    }
    await rm(journalPath);
  }
}

export async function recoverCrossRootTransactions(coordinatorRoot: string, allowedRoots: string[]): Promise<void> {
  const roots = allowedRoots.map((root) => path.resolve(root));
  return withTransactionLock(coordinatorRoot, '.spec-loop-cross-tx-lock', () => recoverCrossRootTransactionsUnlocked(coordinatorRoot, roots));
}

export async function atomicWriteAcrossRoots(coordinatorRoot: string, allowedRoots: string[], values: Array<{ file: string; content: string | Buffer }>): Promise<void> {
  const roots = allowedRoots.map((root) => path.resolve(root));
  await withTransactionLock(coordinatorRoot, '.spec-loop-cross-tx-lock', async () => {
    await recoverCrossRootTransactionsUnlocked(coordinatorRoot, roots);
    const txDir = await safeTransactionDirectory(coordinatorRoot,'.spec-loop-cross-tx');
    const id = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
    const writes: TxWrite[] = [];
    for (let i = 0; i < values.length; i++) {
      const target = path.resolve(values[i].file);
      if (!withinAnyRoot(target, roots)) throw new Error(`cross-root transaction target escapes allowed roots: ${target}`);
      const owner = roots.find((root) => target === root || target.startsWith(root + path.sep));
      if (!owner) throw new Error(`no owner root for ${target}`);
      const tempDir = await safeTransactionDirectory(owner,'.spec-loop-cross-tx-data');
      const temp = await safeTarget(owner,path.join(tempDir, `${id}-${i}.tmp`));
      await writeFile(temp, values[i].content);
      writes.push({ target, temp, hash: sha256(values[i].content) });
    }
    const journal: CrossRootJournal = { id, status: 'prepared', allowed_roots: roots, writes };
    await writeFile(await safeTarget(coordinatorRoot,path.join(txDir, `${id}.json`)), JSON.stringify(journal, null, 2));
    await recoverCrossRootTransactionsUnlocked(coordinatorRoot, roots);
  });
}

export async function readJsonStrict(file: string): Promise<unknown> {
  const raw = await readFile(file, 'utf8');
  // JSON.parse accepts duplicate keys, so reject them with a small structural scanner.
  const keyRe = /"((?:\\.|[^"\\])*)"\s*:/g;
  const stack: Array<Set<string>> = [new Set()];
  let match: RegExpExecArray | null;
  // This catches duplicates in the flat Attempt objects used by the ledger.
  while ((match = keyRe.exec(raw)) !== null) {
    const key = JSON.parse(`"${match[1]}"`) as string;
    if (stack[0].has(key)) throw new Error(`${path.basename(file)}: duplicate JSON field ${key}`);
    stack[0].add(key);
  }
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`${path.basename(file)}: malformed JSON: ${(error as Error).message}`); }
}
