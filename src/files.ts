import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

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

const PLACEHOLDER = /(?:\b(?:tbd|todo|unknown|placeholder|fill me|lorem ipsum|待填写|待补充|未知)\b|<[^>]+>|\{\{[^}]+\}\})/i;
export function assertSubstantive(value: string, label: string): void {
  const normalized = value.trim();
  if (normalized.length < 3 || PLACEHOLDER.test(normalized)) throw new Error(`${label}: empty or placeholder content`);
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

async function safeTarget(root: string, target: string): Promise<string> {
  const resolved = path.resolve(target);
  const prefix = path.resolve(root) + path.sep;
  if (!resolved.startsWith(prefix)) throw new Error(`transaction target escapes task directory: ${target}`);
  return resolved;
}

export async function recoverTransactions(root: string): Promise<void> {
  const dir = path.join(root, '.spec-loop-tx');
  if (!(await exists(dir))) return;
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

export async function atomicWriteMany(root: string, values: Array<{ file: string; content: string | Buffer }>): Promise<void> {
  await recoverTransactions(root);
  const txDir = path.join(root, '.spec-loop-tx');
  await mkdir(txDir, { recursive: true });
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const writes: TxWrite[] = [];
  for (let i = 0; i < values.length; i++) {
    const target = await safeTarget(root, values[i].file);
    const temp = path.join(txDir, `${id}-${i}.tmp`);
    await writeFile(temp, values[i].content);
    writes.push({ target, temp, hash: sha256(values[i].content) });
  }
  const journalPath = path.join(txDir, `${id}.json`);
  await writeFile(journalPath, JSON.stringify({ id, status: 'prepared', writes } satisfies Journal, null, 2));
  await recoverTransactions(root);
}

function withinAnyRoot(file: string, roots: string[]): boolean {
  const resolved = path.resolve(file);
  return roots.some((root) => resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep));
}

export async function recoverCrossRootTransactions(coordinatorRoot: string, allowedRoots: string[]): Promise<void> {
  const dir = path.join(coordinatorRoot, '.spec-loop-cross-tx');
  if (!(await exists(dir))) return;
  const normalized = allowedRoots.map((root) => path.resolve(root));
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()) {
    const journalPath = path.join(dir, name);
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as CrossRootJournal;
    if (journal.allowed_roots.length !== normalized.length || journal.allowed_roots.some((root) => !normalized.includes(root))) throw new Error(`cross-root transaction ${journal.id}: allowed roots changed`);
    for (const write of journal.writes) {
      if (!withinAnyRoot(write.target, normalized) || !withinAnyRoot(write.temp, normalized)) throw new Error(`cross-root transaction ${journal.id}: path escapes allowed roots`);
      if (await exists(write.temp)) {
        const content = await readFile(write.temp);
        if (sha256(content) !== write.hash) throw new Error(`cross-root transaction ${journal.id}: corrupt temp file`);
        await mkdir(path.dirname(write.target), { recursive: true });
        await rename(write.temp, write.target);
      } else if (!(await exists(write.target)) || sha256(await readFile(write.target)) !== write.hash) {
        throw new Error(`cross-root transaction ${journal.id}: target diverged or is missing`);
      }
    }
    await rm(journalPath);
  }
}

export async function atomicWriteAcrossRoots(coordinatorRoot: string, allowedRoots: string[], values: Array<{ file: string; content: string | Buffer }>): Promise<void> {
  const roots = allowedRoots.map((root) => path.resolve(root));
  await recoverCrossRootTransactions(coordinatorRoot, roots);
  const txDir = path.join(coordinatorRoot, '.spec-loop-cross-tx');
  await mkdir(txDir, { recursive: true });
  const id = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const writes: TxWrite[] = [];
  for (let i = 0; i < values.length; i++) {
    const target = path.resolve(values[i].file);
    if (!withinAnyRoot(target, roots)) throw new Error(`cross-root transaction target escapes allowed roots: ${target}`);
    const owner = roots.find((root) => target === root || target.startsWith(root + path.sep));
    if (!owner) throw new Error(`no owner root for ${target}`);
    const tempDir = path.join(owner, '.spec-loop-cross-tx-data');
    await mkdir(tempDir, { recursive: true });
    const temp = path.join(tempDir, `${id}-${i}.tmp`);
    await writeFile(temp, values[i].content);
    writes.push({ target, temp, hash: sha256(values[i].content) });
  }
  const journal: CrossRootJournal = { id, status: 'prepared', allowed_roots: roots, writes };
  await writeFile(path.join(txDir, `${id}.json`), JSON.stringify(journal, null, 2));
  await recoverCrossRootTransactions(coordinatorRoot, roots);
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
