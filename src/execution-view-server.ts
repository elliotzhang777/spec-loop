import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { inspectProcess, processStartedAt as identifyProcess, requireProcessIdentity, terminateProcessTree } from './process-control.js';
import { withOwnedDirectoryLock } from './owned-lock.js';
import { z } from 'zod';
import { atomicWriteMany } from './files.js';
import { buildExecutionSnapshot } from './execution-view.js';
import { readProject } from './project.js';
import { decideWaveReview, launchAuthorizedWave, listWaveReviews, readWaveReview, refreshWaveReview, waveDecisionSchema, waveReviewArtifact } from './wave-review.js';

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
  const snapshots=new Map<string,Promise<Awaited<ReturnType<typeof buildExecutionSnapshot>>>>();
  const snapshotFor=(root:string)=>{const existing=snapshots.get(root);if(existing)return existing;const work=buildExecutionSnapshot(root).finally(()=>{if(snapshots.get(root)===work)snapshots.delete(root)});snapshots.set(root,work);return work;};
  const executionReviewToken=randomBytes(32).toString('hex');
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
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.username || url.password || url.hash) { send(response, 400, 'Bad Request\n', 'text/plain; charset=utf-8', headOnly); return; }
      const reviewRoute=['/api/wave-reviews','/api/wave-review','/api/wave-review/decision','/api/wave-review/refresh','/api/review-artifact'].includes(url.pathname);
      if(reviewRoute){
        const mutation=['/api/wave-review/decision','/api/wave-review/refresh'].includes(url.pathname);
        if(mutation?method!=='POST':method!=='GET'&&method!=='HEAD'){response.writeHead(405,{Allow:mutation?'POST':'GET, HEAD'});response.end();return;}
        const keys=[...url.searchParams.keys()],allowed=mutation?['project']:url.pathname==='/api/review-artifact'?['project','wave','task','hash']:['project','wave'];
        if(keys.some(key=>!allowed.includes(key)||url.searchParams.getAll(key).length!==1)){send(response,400,'Bad Request\n','text/plain; charset=utf-8',headOnly);return;}
        const selected=(await executionViewProjects(projectRoot)).find(item=>item.key===(url.searchParams.get('project')??'root'));
        if(!selected){send(response,404,'Project not found\n','text/plain; charset=utf-8',headOnly);return;}
        if(mutation){
          const origin=`http://${request.headers.host}`,address=server.address();
          if(!address||typeof address==='string'||request.headers.host!==`127.0.0.1:${address.port}`||(request.headers.origin&&request.headers.origin!==origin)||request.headers['x-spec-loop-review-token']!==executionReviewToken){send(response,403,'Review capability or Origin is invalid\n','text/plain; charset=utf-8');return;}
          if(request.headers['content-type']!=='application/json'){send(response,415,'JSON required\n','text/plain; charset=utf-8');return;}
          if(Number(request.headers['content-length']??0)>65_536){send(response,413,'Review decision too large\n','text/plain; charset=utf-8');return;}
          request.setTimeout(5_000,()=>request.destroy(new Error('review request timeout')));
          const chunks:Buffer[]=[];let size=0;
          for await(const chunk of request){size+=chunk.length;if(size>65_536)throw new Error('review decision too large');chunks.push(Buffer.from(chunk));}
          request.setTimeout(0);
          const body=JSON.parse(Buffer.concat(chunks).toString());
          if(url.pathname==='/api/wave-review/refresh'){
            const input=z.object({wave_id:z.string()}).strict().parse(body);const bundle=await refreshWaveReview(selected.root,input.wave_id);send(response,200,JSON.stringify({bundle}),'application/json; charset=utf-8');return;
          }
          const input=z.object({wave_id:z.string(),decision:waveDecisionSchema,start_next:z.boolean().default(false)}).strict().parse(body);
          if(input.start_next&&!input.decision.authorize_next)throw new Error('starting the next wave requires explicit next-plan authorization');
          const review=await decideWaveReview(selected.root,input.wave_id,input.decision),next=input.start_next?await launchAuthorizedWave(selected.root,review.decision!.authorization_id!):null;
          send(response,200,JSON.stringify({review,next}),'application/json; charset=utf-8');return;
        }
        if(url.pathname==='/api/wave-reviews'){send(response,200,JSON.stringify(await listWaveReviews(selected.root)),'application/json; charset=utf-8',headOnly);return;}
        if(url.pathname==='/api/review-artifact'){const artifact=await waveReviewArtifact(selected.root,url.searchParams.get('wave')??'',url.searchParams.get('task')??'',url.searchParams.get('hash')??'');send(response,200,artifact.content,artifact.media_type,headOnly);return;}
        send(response,200,JSON.stringify(await readWaveReview(selected.root,url.searchParams.get('wave')??'')),'application/json; charset=utf-8',headOnly);return;
      }
      if (method !== 'GET' && method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
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
        const snapshot = await snapshotFor(selected.root), etag = `"${selected.key}:${snapshot.revision}"`;
        if (request.headers['if-none-match'] === etag) { response.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); response.end(); return; }
        const body = `${JSON.stringify(snapshot)}\n`;
        response.setHeader('ETag', etag); send(response, 200, body, 'application/json; charset=utf-8', headOnly); return;
      }
      const asset = assets[url.pathname as keyof typeof assets];
      if (asset) {
        if (url.search) { send(response, 400, 'Bad Request\n', 'text/plain; charset=utf-8', headOnly); return; }
        const source = await readFile(asset.file);
        const body = url.pathname === '/' ? source.toString('utf8').replace('__CSP_NONCE__', executionViewStyleNonce).replace('__REVIEW_TOKEN__',executionReviewToken) : source;
        send(response, 200, body, asset.type, headOnly); return;
      }
      send(response, 404, 'Not Found\n', 'text/plain; charset=utf-8', headOnly);
    } catch (error) {
      const reviewRequest=(request.url??'').startsWith('/api/wave-review');
      send(response, reviewRequest?409:500, `${JSON.stringify({ error: (error as Error).message })}\n`, 'application/json; charset=utf-8', headOnly);
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
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>server.closeAllConnections(),1_000);server.close(error=>{clearTimeout(timer);if(error&&(error as NodeJS.ErrnoException).code!=='ERR_SERVER_NOT_RUNNING')reject(error);else resolve();});server.closeIdleConnections();});
}

const markerSchema=z.object({schema_version:z.literal(1),project_root:z.string(),pid:z.number().int().positive(),process_started_at:z.string().min(5),url:z.string().url().refine(value=>new URL(value).hostname==='127.0.0.1'),started_at:z.iso.datetime()}).strict();
const markerFile=(root:string)=>path.join(root,'.spec-loop','execution-view.json');

async function processStartedAt(pid:number){return requireProcessIdentity(await identifyProcess(pid),'execution view')}
async function readViewMarker(root:string){return markerSchema.parse(JSON.parse(await readFile(markerFile(root),'utf8')))}
async function healthy(url:string,timeoutMs=1000){try{const response=await fetch(new URL('/api/projects',url),{signal:AbortSignal.timeout(Math.max(1,Math.ceil(timeoutMs)))});const ok=response.ok;await response.body?.cancel();return ok}catch{return false}}

export async function executionViewStatus(projectRoot:string,timeoutMs=6000){
  const deadline=performance.now()+timeoutMs;
  const root=await realpath(projectRoot),info=await lstat(markerFile(root)).catch(()=>null);if(!info)return{running:false,reason:'not_started' as const,marker:null};if(!info.isFile()||info.isSymbolicLink())throw new Error('execution view marker is invalid');
  let marker:z.infer<typeof markerSchema>;try{marker=await readViewMarker(root)}catch(error){return{running:false,reason:`invalid_marker: ${(error as Error).message}`,marker:null}}
  if(marker.project_root!==root)return{running:false,reason:'project_root_mismatch' as const,marker};
  const probe=await inspectProcess(marker.pid,marker.process_started_at,{timeoutMs:Math.max(1,deadline-performance.now())});
  if(probe.status==='unknown')return{running:false,reason:'identity_unknown' as const,marker};
  if(probe.status!=='alive')return{running:false,reason:'stale_pid' as const,marker};
  if(!(await healthy(marker.url,Math.min(1000,Math.max(1,deadline-performance.now())))))return{running:true,reason:'unhealthy' as const,marker};return{running:true,reason:'healthy' as const,marker};
}

export async function serveManagedExecutionView(projectRoot:string,port=0):Promise<void>{
  const root=await realpath(projectRoot),identity=processStartedAt(process.pid),{server,url}=await startExecutionViewServer(root,{port}),processStart=await identity,marker=markerSchema.parse({schema_version:1,project_root:root,pid:process.pid,process_started_at:processStart,url,started_at:new Date().toISOString()});await atomicWriteMany(root,[{file:markerFile(root),content:`${JSON.stringify(marker,null,2)}\n`}]);
  await new Promise<void>(resolve=>{let closing=false;const stop=()=>{if(closing)return;closing=true;closeExecutionViewServer(server).finally(resolve)};process.once('SIGINT',stop);process.once('SIGTERM',stop);server.once('close',resolve)});const current=await readViewMarker(root).catch(()=>null);if(current?.pid===process.pid&&current.process_started_at===processStart)await rm(markerFile(root),{force:true});
}

export async function startManagedExecutionView(projectRoot:string,port=0,options:{timeoutMs?:number}={}){
  const root=await realpath(projectRoot),timeoutMs=options.timeoutMs??15_000;if(!Number.isFinite(timeoutMs)||timeoutMs<1)throw new Error('view startup timeout must be positive');
  const deadline=performance.now()+timeoutMs;
  return withOwnedDirectoryLock(path.join(root,'.spec-loop','locks','execution-view.lock'),{name:'execution view lifecycle',maxWaitMs:timeoutMs},async()=>{
    const remaining=()=>Math.max(1,deadline-performance.now()),current=await executionViewStatus(root,remaining());if(current.running)return current.marker;
    if(current.reason==='identity_unknown'||current.reason.startsWith('invalid_marker')||current.reason==='project_root_mismatch')throw new Error(`execution view requires reconcile: ${current.reason}`);
    if(current.marker)await rm(markerFile(root),{force:true});if(performance.now()>=deadline)throw new Error('execution view startup deadline reached');
    const child=spawn(process.execPath,[fileURLToPath(new URL('./cli.js',import.meta.url)),'_view-serve',root,'--port',String(port)],{cwd:root,detached:true,stdio:'ignore'});child.unref();let ready=false;
    const startProbe=child.pid?identifyProcess(child.pid,remaining()):Promise.resolve(null);
    try{while(performance.now()<deadline){const status=await executionViewStatus(root,remaining());if(status.running&&status.reason==='healthy'&&status.marker?.pid===child.pid){ready=true;return status.marker;}if(child.exitCode!==null||child.signalCode!==null)break;try{process.kill(child.pid!,0)}catch{break}await new Promise(resolve=>setTimeout(resolve,Math.min(50,remaining())));}throw new Error(`execution view did not become healthy within ${timeoutMs}ms`);}
    finally{if(!ready){const start=await startProbe;const stopped=await terminateProcessTree(child.pid,start,100,{timeoutMs:1000});if(!stopped.stopped)child.kill('SIGKILL');const marker=await readViewMarker(root).catch(()=>null);if(marker&&marker.pid===child.pid&&marker.process_started_at===start)await rm(markerFile(root),{force:true});}}
  });
}

export async function stopManagedExecutionView(projectRoot:string){
  const root=await realpath(projectRoot);
  return withOwnedDirectoryLock(path.join(root,'.spec-loop','locks','execution-view.lock'),{name:'execution view lifecycle',maxWaitMs:3000},async()=>{
    const status=await executionViewStatus(root,1000);if(status.reason==='identity_unknown'||status.reason.startsWith('invalid_marker'))throw new Error(`execution view stop cannot verify owner: ${status.reason}`);
    if(!status.running||!status.marker){if(status.marker&&status.reason==='stale_pid')await rm(markerFile(root),{force:true});return{stopped:false,reason:status.reason};}
    if(status.marker.pid===process.pid)throw new Error('execution view cannot stop its own control process');
    const result=await terminateProcessTree(status.marker.pid,status.marker.process_started_at,1000,{timeoutMs:3000});if(!result.stopped)throw new Error(`execution view stop remains unverified: ${result.reason}`);
    const current=await readViewMarker(root).catch(()=>null);if(current?.pid===status.marker.pid&&current.process_started_at===status.marker.process_started_at)await rm(markerFile(root),{force:true});return{stopped:true,reason:'stopped'};
  });
}
