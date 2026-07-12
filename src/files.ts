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

