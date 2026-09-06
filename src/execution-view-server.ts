import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteMany } from './files.js';
import { buildExecutionSnapshot } from './execution-view.js';
import { readProject } from './project.js';

const executionViewStyleNonce = randomBytes(18).toString('base64');

function send(response: ServerResponse, status: number, body: string | Buffer, contentType: string, headOnly = false): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${executionViewStyleNonce}'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  response.end(headOnly ? undefined : body);
}

function assetPath(name: 'index.html' | 'app.js' | 'style.css' | 'controls.js' | 'controls.css'): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'assets', 'execution-view', name);
}

function elkAssetPath(): string {
  return createRequire(import.meta.url).resolve('elkjs/lib/elk.bundled.js');
}

type ExecutionViewProject = { key: string; project_id: string; name: string };

async function executionViewProjects(projectRoot: string): Promise<Array<ExecutionViewProject & { root: string }>> {
  const projects: Array<ExecutionViewProject & { root: string }> = [];
  const add = async (key: string, root: string): Promise<void> => {
    const controlFile = path.join(root, '.spec-loop', 'PROJECT.md');
    const rootInfo = await lstat(root).catch(() => null), controlInfo = await lstat(controlFile).catch(() => null);
    if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || !controlInfo?.isFile() || controlInfo.isSymbolicLink()) return;
    try {
      const project = await readProject(root);
      projects.push({ key, project_id: project.project_id, name: project.name, root });
    } catch { /* Invalid siblings are not exposed through the workspace switcher. */ }
  };
  await add('root', projectRoot);
  const collectionRoot = path.join(projectRoot, 'projects'), collectionInfo = await lstat(collectionRoot).catch(() => null);
  if (collectionInfo?.isDirectory() && !collectionInfo.isSymbolicLink()) {
    const entries = await readdir(collectionRoot, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      await add(`project:${entry.name}`, path.join(collectionRoot, entry.name));
    }
  }
  return projects;
}

async function projectCatalog(projectRoot: string): Promise<{ default_project: string; projects: ExecutionViewProject[] }> {
  const projects = await executionViewProjects(projectRoot);
  return { default_project: projects.some((item) => item.key === 'root') ? 'root' : projects[0]?.key ?? '', projects: projects.map(({ root: _, ...project }) => project) };
}

export async function startExecutionViewServer(projectRoot: string, options: { port?: number } = {}): Promise<{ server: Server; url: string }> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('view port must be an integer from 0 to 65535');
  const assets = {
    '/': { file: assetPath('index.html'), type: 'text/html; charset=utf-8' },
    '/app.js': { file: assetPath('app.js'), type: 'text/javascript; charset=utf-8' },
    '/controls.js': { file: assetPath('controls.js'), type: 'text/javascript; charset=utf-8' },
    '/controls.css': { file: assetPath('controls.css'), type: 'text/css; charset=utf-8' },
    '/style.css': { file: assetPath('style.css'), type: 'text/css; charset=utf-8' },
    '/vendor/elk.bundled.js': { file: elkAssetPath(), type: 'text/javascript; charset=utf-8' },
  };
  const server = createServer(async (request, response) => {
    const headOnly = request.method === 'HEAD';
    try {
      const method = request.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.username || url.password || url.hash) { send(response, 400, 'Bad Request\n', 'text/plain; charset=utf-8', headOnly); return; }
      if (url.pathname === '/api/projects') {
        if (url.search) { send(response, 400, 'Bad Request\n', 'text/plain; charset=utf-8', headOnly); return; }
        const body = `${JSON.stringify(await projectCatalog(projectRoot))}\n`;
        send(response, 200, body, 'application/json; charset=utf-8', headOnly); return;
      }
      if (url.pathname === '/api/snapshot') {
        const keys = [...url.searchParams.keys()];
        if (keys.some((key) => key !== 'project') || url.searchParams.getAll('project').length > 1) { send(response, 400, 'Bad Request\n', 'text/plain; charset=utf-8', headOnly); return; }
        const projects = await executionViewProjects(projectRoot), selectedKey = url.searchParams.get('project') ?? 'root';
        const selected = projects.find((item) => item.key === selectedKey);
        if (!selected) { send(response, 404, `${JSON.stringify({ error: 'project not found' })}\n`, 'application/json; charset=utf-8', headOnly); return; }
        const snapshot = await buildExecutionSnapshot(selected.root), etag = `"${selected.key}:${snapshot.revision}"`;
        if (request.headers['if-none-match'] === etag) { response.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); response.end(); return; }
        const body = `${JSON.stringify(snapshot)}\n`;
        response.setHeader('ETag', etag); send(response, 200, body, 'application/json; charset=utf-8', headOnly); return;
      }
      const asset = assets[url.pathname as keyof typeof assets];
      if (asset) {
        if (url.search) { send(response, 400, 'Bad Request\n', 'text/plain; charset=utf-8', headOnly); return; }
        const source = await readFile(asset.file);
        const body = url.pathname === '/' ? source.toString('utf8').replace('__CSP_NONCE__', executionViewStyleNonce) : source;
        send(response, 200, body, asset.type, headOnly); return;
      }
      send(response, 404, 'Not Found\n', 'text/plain; charset=utf-8', headOnly);
    } catch (error) {
      send(response, 500, `${JSON.stringify({ error: (error as Error).message })}\n`, 'application/json; charset=utf-8', headOnly);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError); server.once('listening', onListening); server.listen(port, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('execution view did not bind a TCP address'); }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

export async function closeExecutionViewServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const markerSchema=z.object({schema_version:z.literal(1),project_root:z.string(),pid:z.number().int().positive(),process_started_at:z.string().min(5),url:z.string().url().refine(value=>new URL(value).hostname==='127.0.0.1'),started_at:z.iso.datetime()}).strict();
const markerFile=(root:string)=>path.join(root,'.spec-loop','execution-view.json');

async function processStartedAt(pid:number):Promise<string>{return new Promise((resolve,reject)=>{const child=spawn('/bin/ps',['-p',String(pid),'-o','lstart='],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='',settled=false;const finish=(error?:Error,value?:string)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value as string)},timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('view process identity check timed out'))},5_000);child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',error=>finish(error));child.on('close',code=>code===0&&stdout.trim()?finish(undefined,stdout.trim()):finish(new Error(stderr.trim()||'view process is not running')))})}
async function readViewMarker(root:string){return markerSchema.parse(JSON.parse(await readFile(markerFile(root),'utf8')))}
async function healthy(url:string){try{const response=await fetch(new URL('/api/projects',url),{signal:AbortSignal.timeout(1000)});return response.ok}catch{return false}}

export async function executionViewStatus(projectRoot:string){
  const root=await realpath(projectRoot),info=await lstat(markerFile(root)).catch(()=>null);if(!info)return{running:false,reason:'not_started' as const,marker:null};if(!info.isFile()||info.isSymbolicLink())throw new Error('execution view marker is invalid');
  let marker:z.infer<typeof markerSchema>;try{marker=await readViewMarker(root)}catch(error){return{running:false,reason:`invalid_marker: ${(error as Error).message}`,marker:null}}
  if(marker.project_root!==root)return{running:false,reason:'project_root_mismatch' as const,marker};
  const started=await processStartedAt(marker.pid).catch(()=>null);if(!started||started!==marker.process_started_at)return{running:false,reason:'stale_pid' as const,marker};
  if(!(await healthy(marker.url)))return{running:false,reason:'unhealthy' as const,marker};return{running:true,reason:'healthy' as const,marker};
}

export async function serveManagedExecutionView(projectRoot:string,port=0):Promise<void>{
  const root=await realpath(projectRoot),{server,url}=await startExecutionViewServer(root,{port}),processStart=await processStartedAt(process.pid),marker=markerSchema.parse({schema_version:1,project_root:root,pid:process.pid,process_started_at:processStart,url,started_at:new Date().toISOString()});await atomicWriteMany(root,[{file:markerFile(root),content:`${JSON.stringify(marker,null,2)}\n`}]);
  await new Promise<void>(resolve=>{let closing=false;const stop=()=>{if(closing)return;closing=true;closeExecutionViewServer(server).finally(resolve)};process.once('SIGINT',stop);process.once('SIGTERM',stop);server.once('close',resolve)});const current=await readViewMarker(root).catch(()=>null);if(current?.pid===process.pid&&current.process_started_at===processStart)await rm(markerFile(root),{force:true});
}

export async function startManagedExecutionView(projectRoot:string,port=0){
  const root=await realpath(projectRoot),current=await executionViewStatus(root);if(current.running)return current.marker;
  if(current.marker||current.reason.startsWith('invalid_marker'))await rm(markerFile(root),{force:true});
  const cli=fileURLToPath(new URL('./cli.js',import.meta.url)),child=spawn(process.execPath,[cli,'_view-serve',root,'--port',String(port)],{cwd:root,detached:true,stdio:'ignore'});child.unref();
  for(let attempt=0;attempt<300;attempt++){await new Promise(resolve=>setTimeout(resolve,50));const status=await executionViewStatus(root).catch(()=>null);if(status?.running)return status.marker;try{process.kill(child.pid as number,0)}catch{break}}
  throw new Error('execution view did not become healthy within 15 seconds');
}

export async function stopManagedExecutionView(projectRoot:string){const root=await realpath(projectRoot),status=await executionViewStatus(root);if(!status.running||!status.marker){if(status.marker)await rm(markerFile(root),{force:true});return{stopped:false,reason:status.reason}}process.kill(status.marker.pid,'SIGTERM');for(let attempt=0;attempt<100;attempt++){await new Promise(resolve=>setTimeout(resolve,25));try{process.kill(status.marker.pid,0)}catch{await rm(markerFile(root),{force:true});return{stopped:true,reason:'stopped'}}}throw new Error('execution view did not stop safely')}
