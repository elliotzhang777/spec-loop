import { createServer, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExecutionSnapshot } from './execution-view.js';

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
      if (url.username || url.password || url.search || url.hash) { send(response, 400, 'Bad Request\n', 'text/plain; charset=utf-8', headOnly); return; }
      if (url.pathname === '/api/snapshot') {
        const snapshot = await buildExecutionSnapshot(projectRoot), etag = `"${snapshot.revision}"`;
        if (request.headers['if-none-match'] === etag) { response.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); response.end(); return; }
        const body = `${JSON.stringify(snapshot)}\n`;
        response.setHeader('ETag', etag); send(response, 200, body, 'application/json; charset=utf-8', headOnly); return;
      }
      const asset = assets[url.pathname as keyof typeof assets];
      if (asset) {
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
