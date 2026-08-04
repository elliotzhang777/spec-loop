import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { inspect, promisify } from 'node:util';
import { z } from 'zod';
import { atomicWriteMany, exists } from '../files.js';

const execFileAsync = promisify(execFile);

const requestTypes = ['proposal', 'needs_user', 'visual_review', 'verification', 'heavy_acceptance'] as const;
const receiveIdTypes = ['chat_id', 'open_id', 'user_id', 'union_id', 'email'] as const;
const tenantKeyPattern = /^[0-9a-z]{16}$/;
const placeholderValue = /^(?:todo|tbd|unknown|placeholder|configure|待填写|待补充)$/i;

function isSubstantiveIdentifier(value: string, pattern: RegExp): boolean {
  return !placeholderValue.test(value.trim()) && pattern.test(value.trim());
}

function isValidTenantKey(value: string): boolean {
  return tenantKeyPattern.test(value) && new Set(value).size >= 4;
}

const secretReferenceSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('environment'), reference: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/) }).strict(),
  z.object({
    provider: z.literal('macos-keychain'),
    service: z.string().min(1).max(256),
    account: z.string().min(1).max(256),
  }).strict(),
]);

export type SecretReference = z.infer<typeof secretReferenceSchema>;

export const feishuConnectorConfigSchema = z.object({
  schema_version: z.literal(1),
  enabled: z.boolean(),
  tenant_key: z.string().trim().min(3).max(256),
  credentials: z.object({
    app_id: secretReferenceSchema,
    app_secret: secretReferenceSchema,
  }).strict(),
  targets: z.array(z.object({
    project_id: z.string().regex(/^PROJ-[A-Z0-9][A-Z0-9-]*$/),
    receive_id_type: z.enum(receiveIdTypes),
    receive_id: z.string().trim().min(3).max(256),
  }).strict()),
  approvers: z.array(z.object({
    project_id: z.string().regex(/^PROJ-[A-Z0-9][A-Z0-9-]*$/),
    open_id: z.string().trim().regex(/^ou_[A-Za-z0-9_-]{8,128}$/),
    local_actor: z.string().trim().min(3).max(128).refine((value) => !placeholderValue.test(value), 'local actor must not be a placeholder'),
    request_types: z.array(z.enum(requestTypes)).min(1),
  }).strict()),
  notifications: z.object({
    level: z.enum(['important', 'all']).default('important'),
    aggregate_window_seconds: z.number().int().min(1).max(3600).default(30),
  }).strict(),
  retry: z.object({
    max_attempts: z.number().int().min(1).max(20).default(5),
    base_delay_ms: z.number().int().min(100).max(60_000).default(1_000),
    max_delay_ms: z.number().int().min(1_000).max(3_600_000).default(60_000),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.enabled && value.targets.length === 0) ctx.addIssue({ code: 'custom', path: ['targets'], message: 'enabled connector requires at least one target' });
  if (value.enabled && value.approvers.length === 0) ctx.addIssue({ code: 'custom', path: ['approvers'], message: 'enabled connector requires at least one approver' });
  if (value.enabled && !isValidTenantKey(value.tenant_key)) ctx.addIssue({ code: 'custom', path: ['tenant_key'], message: 'enabled connector requires a valid tenant key' });
  if (value.retry.max_delay_ms < value.retry.base_delay_ms) ctx.addIssue({ code: 'custom', path: ['retry', 'max_delay_ms'], message: 'max delay must be greater than or equal to base delay' });
  const targetKeys = value.targets.map((item) => `${item.project_id}\0${item.receive_id_type}\0${item.receive_id}`);
  if (new Set(targetKeys).size !== targetKeys.length) ctx.addIssue({ code: 'custom', path: ['targets'], message: 'duplicate target' });
  const approverKeys = value.approvers.map((item) => `${item.project_id}\0${item.open_id}`);
  if (new Set(approverKeys).size !== approverKeys.length) ctx.addIssue({ code: 'custom', path: ['approvers'], message: 'duplicate approver' });
  value.targets.forEach((target, index) => {
    const valid = target.receive_id_type === 'chat_id' ? isSubstantiveIdentifier(target.receive_id, /^oc_[A-Za-z0-9_-]{8,128}$/)
      : target.receive_id_type === 'open_id' ? isSubstantiveIdentifier(target.receive_id, /^ou_[A-Za-z0-9_-]{8,128}$/)
        : target.receive_id_type === 'union_id' ? isSubstantiveIdentifier(target.receive_id, /^on_[A-Za-z0-9_-]{8,128}$/)
          : target.receive_id_type === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target.receive_id)
            : isSubstantiveIdentifier(target.receive_id, /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/);
    if (!valid) ctx.addIssue({ code: 'custom', path: ['targets', index, 'receive_id'], message: `invalid ${target.receive_id_type} target` });
  });
});

export type FeishuConnectorConfig = z.infer<typeof feishuConnectorConfigSchema>;
export type FeishuTarget = FeishuConnectorConfig['targets'][number];

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

export interface SecretProvider {
  resolve(reference: SecretReference): Promise<string>;
}

export class LocalSecretProvider implements SecretProvider {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async resolve(reference: SecretReference): Promise<string> {
    if (reference.provider === 'environment') {
      const value = this.environment[reference.reference];
      if (!value?.trim()) throw new Error(`credential reference is unavailable: env:${reference.reference}`);
      return value.trim();
    }
    if (process.platform !== 'darwin') throw new Error('macos-keychain credential provider is only available on macOS');
    try {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', reference.service, '-a', reference.account, '-w'], {
        encoding: 'utf8', maxBuffer: 16 * 1024,
      });
      const value = stdout.trim();
      if (!value) throw new Error('empty credential');
      return value;
    } catch {
      throw new Error(`credential reference is unavailable: keychain:${reference.service}/${reference.account}`);
    }
  }
}

export async function resolveFeishuCredentials(config: FeishuConnectorConfig, provider: SecretProvider = new LocalSecretProvider()): Promise<FeishuCredentials> {
  const [appId, appSecret] = await Promise.all([
    provider.resolve(config.credentials.app_id),
    provider.resolve(config.credentials.app_secret),
  ]);
  return { appId, appSecret };
}

const authorizationHeader = /\bauthorization\b["']?\s*[:=]\s*["']?[^,;}\]\r\n]+/gi;
const sensitiveKey = '(?:app[_-]?secret|client[_-]?secret|secret|token|[a-z][a-z0-9_-]*token)';
const sensitiveJsonAssignment = new RegExp(`(["'])(${sensitiveKey})\\1\\s*:\\s*(["'])[^\\r\\n]*?\\3`, 'gi');
const sensitiveAssignment = new RegExp(`\\b(${sensitiveKey})\\b\\s*[:=]\\s*([^\\s,;]+)`, 'gi');
const bearerToken = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi;

export function redactFeishuText(value: string, secrets: string[] = []): string {
  let redacted = value
    .replace(sensitiveJsonAssignment, '$1$2$1:$3[REDACTED]$3')
    .replace(authorizationHeader, 'Authorization=[REDACTED]')
    .replace(sensitiveAssignment, '$1=[REDACTED]')
    .replace(bearerToken, 'Bearer [REDACTED]');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) redacted = redacted.split(secret).join('[REDACTED]');
  return redacted;
}

export interface FeishuLogSink {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export function createRedactingFeishuLogger(credentials: FeishuCredentials, sink: FeishuLogSink = {
  error: (message) => console.error(message),
  warn: (message) => console.warn(message),
  info: (message) => console.info(message),
  debug: (message) => console.debug(message),
}): { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void; debug: (...args: unknown[]) => void; trace: (...args: unknown[]) => void } {
  const emit = (level: keyof FeishuLogSink, args: unknown[]): void => {
    const rendered = args.map((item) => typeof item === 'string' ? item : inspect(item, { depth: 5, breakLength: Infinity })).join(' ');
    sink[level](`[feishu-sdk] ${redactFeishuText(rendered, [credentials.appId, credentials.appSecret])}`);
  };
  return {
    error: (...args) => emit('error', args),
    warn: (...args) => emit('warn', args),
    info: (...args) => emit('info', args),
    debug: (...args) => emit('debug', args),
    trace: (...args) => emit('debug', args),
  };
}

async function connectorControlRoot(projectRoot: string): Promise<string> {
  const root = path.resolve(projectRoot);
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`project root is missing, symbolic, or not a directory: ${root}`);
  const control = path.join(root, '.spec-loop');
  const controlInfo = await lstat(control).catch(() => null);
  if (!controlInfo?.isDirectory() || controlInfo.isSymbolicLink()) throw new Error(`project control root is missing, symbolic, or not a directory: ${control}`);
  const [rootReal, controlReal] = await Promise.all([realpath(root), realpath(control)]);
  if (!controlReal.startsWith(rootReal + path.sep)) throw new Error(`project control root escapes project: ${control}`);
  return control;
}

export async function feishuConnectorRoot(projectRoot: string): Promise<string> {
  const control = await connectorControlRoot(projectRoot);
  const connectors = path.join(control, 'connectors');
  const feishu = path.join(connectors, 'feishu');
  for (const dir of [connectors, feishu]) {
    const info = await lstat(dir).catch(() => null);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`connector path is symbolic or not a directory: ${dir}`);
    if (!info) await mkdir(dir);
  }
  return feishu;
}

export function defaultFeishuConfig(): FeishuConnectorConfig {
  return {
    schema_version: 1,
    enabled: false,
    tenant_key: 'configure-tenant-key',
    credentials: {
      app_id: { provider: 'environment', reference: 'SPEC_LOOP_FEISHU_APP_ID' },
      app_secret: { provider: 'environment', reference: 'SPEC_LOOP_FEISHU_APP_SECRET' },
    },
    targets: [], approvers: [],
    notifications: { level: 'important', aggregate_window_seconds: 30 },
    retry: { max_attempts: 5, base_delay_ms: 1_000, max_delay_ms: 60_000 },
  };
}

export async function initFeishuConfig(projectRoot: string): Promise<string> {
  const root = await feishuConnectorRoot(projectRoot);
  const file = path.join(root, 'config.json');
  if (await exists(file)) throw new Error('feishu connector config already exists');
  await atomicWriteMany(root, [{ file, content: `${JSON.stringify(defaultFeishuConfig(), null, 2)}\n` }]);
  return file;
}

export async function readFeishuConfig(projectRoot: string): Promise<FeishuConnectorConfig> {
  const root = await feishuConnectorRoot(projectRoot);
  const file = path.join(root, 'config.json');
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error('feishu connector config is missing, symbolic, or not a file');
  const raw = await readFile(file, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`feishu connector config is invalid JSON: ${(error as Error).message}`); }
  return feishuConnectorConfigSchema.parse(parsed);
}

export interface FeishuCardAction {
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  action: { value: unknown; tag: string; name?: string; option?: string };
  raw?: unknown;
}

export type FeishuCardActionHandler = (action: FeishuCardAction) => Promise<void> | void;
export type FeishuConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface FeishuTransport {
  preflight(config: FeishuConnectorConfig, signal?: AbortSignal): Promise<void>;
  connect(handler: FeishuCardActionHandler): Promise<void>;
  disconnect(): Promise<void>;
  connectionState(): FeishuConnectionState;
  sendCard(target: FeishuTarget, card: object): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
}

interface ChannelLike {
  rawClient: {
    application: { v6: { scope: { list(payload?: {}): Promise<{
      code?: number; msg?: string; data?: { scopes?: Array<{ scope_name: string; grant_status: number; scope_type?: 'user' | 'tenant' }> };
    }> } } };
    im: { v1: { message: { create(payload: {
      params: { receive_id_type: FeishuTarget['receive_id_type'] };
      data: { receive_id: string; msg_type: 'interactive'; content: string };
    }): Promise<{ data?: { message_id?: string } }> } } };
    request(payload: { url: string; method: 'GET'; signal?: AbortSignal }): Promise<{
      code?: number; msg?: string;
      data?: { scopes?: Array<{ scope_name: string; grant_status: number; scope_type?: 'user' | 'tenant' }> };
      bot?: { activate_status?: number; open_id?: string; app_name?: string };
    }>;
  };
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  rawWsClient?: { close(params?: { force?: boolean }): void };
  getConnectionStatus(): { state: FeishuConnectionState } | undefined;
  on(name: 'cardAction', handler: (event: {
    messageId: string; chatId: string; operator: { openId: string };
    action: { value: unknown; tag: string; name?: string; option?: string }; raw?: unknown;
  }) => Promise<void> | void): () => void;
  send(to: string, input: { card: object }): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
}

type FeishuPreflightRequester = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

async function abortableRequest(
  requester: FeishuPreflightRequester,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Pick<Response, 'ok' | 'status' | 'json'>> {
  if (signal?.aborted) throw new Error('feishu preflight was cancelled');
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      requester(url, { ...init, signal }),
      new Promise<never>((_, reject) => {
        if (!signal) return;
        abortListener = () => reject(new Error('feishu preflight was cancelled'));
        signal.addEventListener('abort', abortListener, { once: true });
      }),
    ]);
  } finally {
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  }
}

export class OfficialFeishuTransport implements FeishuTransport {
  private channel?: ChannelLike;
  private channelPromise?: Promise<ChannelLike>;
  private unsubscribe?: () => void;
  private state: FeishuConnectionState = 'idle';
  private connectionGeneration = 0;
  private connectInFlight = false;
  private sdkRequestController = new AbortController();
  private tenantAccessToken = '';
  private tenantAccessTokenExpiresAt = 0;

  constructor(
    private readonly credentials: FeishuCredentials,
    private readonly channelFactory?: () => Promise<ChannelLike>,
    private readonly preflightRequester: FeishuPreflightRequester = (url, init) => fetch(url, init),
  ) {}

  private resetSdkRequestController(): void {
    if (this.sdkRequestController.signal.aborted) this.sdkRequestController = new AbortController();
  }

  private sdkHttpInstance(): object {
    const request = async (payload: {
      url: string; method?: string; data?: unknown; params?: Record<string, unknown>; headers?: Record<string, string>;
    }): Promise<unknown> => {
      if (payload.url.includes('/open-apis/auth/v3/tenant_access_token/internal')
        && this.tenantAccessToken && this.tenantAccessTokenExpiresAt > Date.now()) {
        return { code: 0, tenant_access_token: this.tenantAccessToken, expire: Math.max(1, Math.floor((this.tenantAccessTokenExpiresAt - Date.now()) / 1000)) };
      }
      const target = new URL(payload.url);
      for (const [key, value] of Object.entries(payload.params ?? {})) {
        if (Array.isArray(value)) value.forEach((item) => target.searchParams.append(key, String(item)));
        else if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
      }
      const method = (payload.method ?? 'GET').toUpperCase();
      const headers = { ...payload.headers };
      if (payload.data !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
      }
      const response = await abortableRequest(this.preflightRequester, target.toString(), {
        method,
        headers,
        body: payload.data === undefined ? undefined : JSON.stringify(payload.data),
      }, this.sdkRequestController.signal);
      if (!response.ok) throw new Error(`Feishu SDK request failed with HTTP ${response.status}`);
      return response.json();
    };
    return {
      request,
      post: (url: string, data?: unknown, options: { headers?: Record<string, string> } = {}) => request({ url, method: 'POST', data, headers: options.headers }),
      get: (url: string, options: { params?: Record<string, unknown>; headers?: Record<string, string> } = {}) => request({ url, method: 'GET', ...options }),
      put: (url: string, data?: unknown, options: { headers?: Record<string, string> } = {}) => request({ url, method: 'PUT', data, headers: options.headers }),
      patch: (url: string, data?: unknown, options: { headers?: Record<string, string> } = {}) => request({ url, method: 'PATCH', data, headers: options.headers }),
      delete: (url: string, options: { params?: Record<string, unknown>; headers?: Record<string, string> } = {}) => request({ url, method: 'DELETE', ...options }),
      head: (url: string, options: { params?: Record<string, unknown>; headers?: Record<string, string> } = {}) => request({ url, method: 'HEAD', ...options }),
      options: (url: string, options: { params?: Record<string, unknown>; headers?: Record<string, string> } = {}) => request({ url, method: 'OPTIONS', ...options }),
    };
  }

  private async getChannel(signal?: AbortSignal): Promise<ChannelLike> {
    if (this.channel) return this.channel;
    if (signal?.aborted) throw new Error('feishu channel creation was cancelled');
    if (!this.channelPromise) {
      const channelPromise = (async () => {
        if (this.channelFactory) return this.channelFactory();
        const sdk = await import('@larksuiteoapi/node-sdk');
        return sdk.createLarkChannel({
          appId: this.credentials.appId,
          appSecret: this.credentials.appSecret,
          transport: 'websocket',
          includeRawEvent: true,
          source: 'spec-loop',
          logger: createRedactingFeishuLogger(this.credentials),
          loggerLevel: sdk.LoggerLevel.error,
          httpInstance: this.sdkHttpInstance() as never,
          handshakeTimeoutMs: 15_000,
          outbound: { retry: { maxAttempts: 1, baseDelayMs: 100 } },
        }) as ChannelLike;
      })();
      const trackedChannelPromise = channelPromise.catch((error) => {
        if (this.channelPromise === trackedChannelPromise) this.channelPromise = undefined;
        throw error;
      });
      this.channelPromise = trackedChannelPromise;
    }
    const channelPromise = this.channelPromise;
    let abortListener: (() => void) | undefined;
    try {
      this.channel = await Promise.race([
        channelPromise,
        new Promise<never>((_, reject) => {
          if (!signal) return;
          abortListener = () => reject(new Error('feishu channel creation was cancelled'));
          signal.addEventListener('abort', abortListener, { once: true });
        }),
      ]);
      return this.channel;
    } finally {
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    }
  }

  async preflight(_config: FeishuConnectorConfig, signal?: AbortSignal): Promise<void> {
    let tenantAccessToken = '';
    try {
      const tokenHttpResponse = await abortableRequest(this.preflightRequester, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: this.credentials.appId, app_secret: this.credentials.appSecret }),
      }, signal);
      if (!tokenHttpResponse.ok) throw new Error(`tenant token request failed with HTTP ${tokenHttpResponse.status}`);
      const tokenResponse = await tokenHttpResponse.json() as { code?: number; msg?: string; tenant_access_token?: string };
      if (tokenResponse.code && tokenResponse.code !== 0) throw new Error(tokenResponse.msg || `tenant token request failed with code ${tokenResponse.code}`);
      tenantAccessToken = tokenResponse.tenant_access_token ?? '';
      if (!tenantAccessToken) throw new Error('tenant_access_token missing from response');
      this.tenantAccessToken = tenantAccessToken;
      this.tenantAccessTokenExpiresAt = Date.now() + Math.max(1, Number((tokenResponse as { expire?: number }).expire ?? 300)) * 1000;
      const authorization = { Authorization: `Bearer ${tenantAccessToken}` };
      const scopeHttpResponse = await abortableRequest(this.preflightRequester, 'https://open.feishu.cn/open-apis/application/v6/scopes', {
        method: 'GET', headers: authorization,
      }, signal);
      if (!scopeHttpResponse.ok) throw new Error(`scope query failed with HTTP ${scopeHttpResponse.status}`);
      const scopeResponse = await scopeHttpResponse.json() as {
        code?: number; msg?: string;
        data?: { scopes?: Array<{ scope_name: string; grant_status: number; scope_type?: 'user' | 'tenant' }> };
      };
      if (scopeResponse.code && scopeResponse.code !== 0) throw new Error(scopeResponse.msg || `scope query failed with code ${scopeResponse.code}`);
      const granted = new Set((scopeResponse.data?.scopes ?? [])
        .filter((scope) => scope.scope_type !== 'user' && scope.grant_status === 1)
        .map((scope) => scope.scope_name));
      if (!granted.has('im:message:send_as_bot') && !granted.has('im:message')) throw new Error('required permission im:message:send_as_bot is not granted');
      const botHttpResponse = await abortableRequest(this.preflightRequester, 'https://open.feishu.cn/open-apis/bot/v3/info', {
        method: 'GET', headers: authorization,
      }, signal);
      if (!botHttpResponse.ok) throw new Error(`bot info failed with HTTP ${botHttpResponse.status}`);
      const botResponse = await botHttpResponse.json() as {
        code?: number; msg?: string; bot?: { activate_status?: number; open_id?: string; app_name?: string };
      };
      if (botResponse.code && botResponse.code !== 0) throw new Error(botResponse.msg || `bot info failed with code ${botResponse.code}`);
      if (!botResponse.bot?.open_id || botResponse.bot.activate_status !== 2) throw new Error('bot capability is unavailable or inactive');
    } catch (error) {
      throw new Error(redactFeishuText(`feishu preflight failed: ${(error as Error).message}`, [this.credentials.appId, this.credentials.appSecret, tenantAccessToken]));
    }
  }

  async connect(handler: FeishuCardActionHandler): Promise<void> {
    if (this.connectInFlight || (this.state !== 'idle' && this.state !== 'failed')) throw new Error(`feishu transport cannot connect from ${this.state}`);
    this.connectInFlight = true;
    this.resetSdkRequestController();
    const generation = ++this.connectionGeneration;
    this.state = 'connecting';
    let channel: ChannelLike | undefined;
    let unsubscribe: (() => void) | undefined;
    let acceptingEvents = false;
    try {
      channel = await this.getChannel();
      if (generation !== this.connectionGeneration) throw new Error('feishu connection was cancelled');
      unsubscribe = channel.on('cardAction', async (event) => {
        if (!acceptingEvents || generation !== this.connectionGeneration) return;
        return handler({
        messageId: event.messageId,
        chatId: event.chatId,
        operatorOpenId: event.operator.openId,
        action: event.action,
        raw: event.raw,
        });
      });
      this.unsubscribe = unsubscribe;
      await channel.connect();
      if (generation !== this.connectionGeneration) throw new Error('feishu connection was cancelled');
      this.state = 'connected';
      acceptingEvents = true;
    } catch (error) {
      acceptingEvents = false;
      unsubscribe?.();
      if (this.unsubscribe === unsubscribe) this.unsubscribe = undefined;
      await channel?.disconnect().catch(() => undefined);
      this.state = generation === this.connectionGeneration ? 'failed' : 'idle';
      throw new Error(redactFeishuText(`feishu connection failed: ${(error as Error).message}`, [this.credentials.appId, this.credentials.appSecret]));
    } finally {
      this.connectInFlight = false;
    }
  }

  async disconnect(): Promise<void> {
    this.connectionGeneration += 1;
    this.sdkRequestController.abort();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try { this.channel?.rawWsClient?.close({ force: true }); }
    catch { /* best effort: the wrapper action gate is already closed */ }
    if (this.channel) await this.channel.disconnect().catch(() => undefined);
    this.state = 'idle';
  }

  connectionState(): FeishuConnectionState {
    return this.channel?.getConnectionStatus()?.state ?? this.state;
  }

  async sendCard(target: FeishuTarget, card: object): Promise<{ messageId: string }> {
    try {
      const channel = await this.getChannel();
      const result = await channel.rawClient.im.v1.message.create({
        params: { receive_id_type: target.receive_id_type },
        data: { receive_id: target.receive_id, msg_type: 'interactive', content: JSON.stringify(card) },
      });
      const messageId = result.data?.message_id;
      if (!messageId) throw new Error('message_id missing from create response');
      return { messageId };
    }
    catch (error) { throw new Error(redactFeishuText(`feishu card send failed: ${(error as Error).message}`, [this.credentials.appId, this.credentials.appSecret])); }
  }

  async updateCard(messageId: string, card: object): Promise<void> {
    try {
      const channel = await this.getChannel();
      await channel.updateCard(messageId, card);
    }
    catch (error) { throw new Error(redactFeishuText(`feishu card update failed: ${(error as Error).message}`, [this.credentials.appId, this.credentials.appSecret])); }
  }
}

export class FakeFeishuTransport implements FeishuTransport {
  readonly sent: Array<{ target: FeishuTarget; card: object; messageId: string }> = [];
  readonly updated: Array<{ messageId: string; card: object }> = [];
  private handler?: FeishuCardActionHandler;
  private state: FeishuConnectionState = 'idle';

  async preflight(_config: FeishuConnectorConfig, _signal?: AbortSignal): Promise<void> {}
  async connect(handler: FeishuCardActionHandler): Promise<void> { this.handler = handler; this.state = 'connected'; }
  async disconnect(): Promise<void> { this.handler = undefined; this.state = 'idle'; }
  connectionState(): FeishuConnectionState { return this.state; }
  async sendCard(target: FeishuTarget, card: object): Promise<{ messageId: string }> {
    const messageId = `fake-${this.sent.length + 1}`;
    this.sent.push({ target, card, messageId });
    return { messageId };
  }
  async updateCard(messageId: string, card: object): Promise<void> { this.updated.push({ messageId, card }); }
  async emitCardAction(action: FeishuCardAction): Promise<void> {
    if (!this.handler) throw new Error('fake feishu transport is not connected');
    await this.handler(action);
  }
}

export interface ConnectorLease {
  schema_version: 1;
  holder: string;
  pid: number;
  token: string;
  acquired_at: string;
  expires_at: string;
}

const leaseSchema = z.object({
  schema_version: z.literal(1), holder: z.string().min(3), pid: z.number().int().positive(), token: z.uuid(),
  acquired_at: z.iso.datetime(), expires_at: z.iso.datetime(),
}).strict();

const leaseHeartbeatSchema = z.object({
  schema_version: z.literal(1), token: z.uuid(), expires_at: z.iso.datetime(),
}).strict();

function leaseHeartbeatFile(root: string, token: string): string {
  return path.join(root, `lease-heartbeat-${token}.json`);
}

function leaseStopFile(root: string, token: string): string {
  return path.join(root, `lease-stop-${token}.json`);
}

async function readRegularJson(file: string, description: string): Promise<unknown | null> {
  const info = await lstat(file).catch(() => null);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${description} is symbolic or not a file`);
  return JSON.parse(await readFile(file, 'utf8'));
}

async function withLeaseMutationLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const directory = path.join(root, 'lease-mutation.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(directory, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!acquired) throw new Error('feishu connector lease mutation is busy; explicit recovery is required');
  try {
    return await action();
  } finally {
    await rmdir(directory);
  }
}

export async function acquireFeishuLease(projectRoot: string, holder: string, ttlMs = 60_000): Promise<ConnectorLease> {
  if (!holder.trim() || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1_000) throw new Error('invalid feishu connector lease request');
  const root = await feishuConnectorRoot(projectRoot);
  const file = path.join(root, 'lease.json');
  return withLeaseMutationLock(root, async () => {
    const now = Date.now();
    const lease: ConnectorLease = {
      schema_version: 1, holder: holder.trim(), pid: process.pid, token: randomUUID(),
      acquired_at: new Date(now).toISOString(), expires_at: new Date(now + ttlMs).toISOString(),
    };
    const writeExclusive = async (): Promise<void> => {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`); }
      finally { await handle.close(); }
    };
    try { await writeExclusive(); return lease; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await readFeishuLease(projectRoot);
    if (existing && Date.parse(existing.expires_at) > Date.now()) throw new Error(`feishu connector lease is held by ${existing.holder}`);
    const stale = `${file}.stale-${randomUUID()}`;
    try { await rename(file, stale); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rm(stale, { force: true });
    if (existing) {
      await rm(leaseHeartbeatFile(root, existing.token), { force: true });
      await rm(leaseStopFile(root, existing.token), { force: true });
    }
    await writeExclusive();
    return lease;
  });
}

export async function readFeishuLease(projectRoot: string): Promise<ConnectorLease | null> {
  const root = await feishuConnectorRoot(projectRoot);
  const file = path.join(root, 'lease.json');
  const raw = await readRegularJson(file, 'feishu connector lease');
  if (!raw) return null;
  const lease = leaseSchema.parse(raw);
  const heartbeatRaw = await readRegularJson(leaseHeartbeatFile(root, lease.token), 'feishu connector lease heartbeat');
  if (!heartbeatRaw) return lease;
  const heartbeat = leaseHeartbeatSchema.parse(heartbeatRaw);
  return Date.parse(heartbeat.expires_at) > Date.parse(lease.expires_at)
    ? { ...lease, expires_at: heartbeat.expires_at }
    : lease;
}

export async function releaseFeishuLease(projectRoot: string, token: string): Promise<void> {
  const root = await feishuConnectorRoot(projectRoot);
  const file = path.join(root, 'lease.json');
  await withLeaseMutationLock(root, async () => {
    const current = await readFeishuLease(projectRoot);
    if (!current) return;
    if (current.token !== token) throw new Error('feishu connector lease token does not match');
    await rm(file);
    await rm(leaseHeartbeatFile(root, token), { force: true });
    await rm(leaseStopFile(root, token), { force: true });
  });
}

export async function renewFeishuLease(projectRoot: string, token: string, ttlMs = 60_000): Promise<ConnectorLease> {
  if (ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1_000) throw new Error('invalid feishu connector lease renewal');
  const root = await feishuConnectorRoot(projectRoot);
  return withLeaseMutationLock(root, async () => {
    const current = await readFeishuLease(projectRoot);
    if (!current || current.token !== token || Date.parse(current.expires_at) <= Date.now()) throw new Error('feishu connector lease was lost');
    const renewed: ConnectorLease = { ...current, expires_at: new Date(Date.now() + ttlMs).toISOString() };
    const heartbeat = { schema_version: 1, token, expires_at: renewed.expires_at };
    await atomicWriteMany(root, [{ file: leaseHeartbeatFile(root, token), content: `${JSON.stringify(heartbeat, null, 2)}\n` }]);
    return renewed;
  });
}

export async function withFeishuLeaseFence<T>(projectRoot: string, token: string, action: () => Promise<T>): Promise<T> {
  const root = await feishuConnectorRoot(projectRoot);
  return withLeaseMutationLock(root, async () => {
    const current = await readFeishuLease(projectRoot);
    if (!current || current.token !== token || Date.parse(current.expires_at) <= Date.now()) throw new Error('feishu connector lease was lost');
    return action();
  });
}

export interface RunFeishuConnectorOptions {
  holder?: string;
  transport?: FeishuTransport;
  secretProvider?: SecretProvider;
  signal?: AbortSignal;
  leaseTtlMs?: number;
}

export async function runFeishuConnector(projectRoot: string, options: RunFeishuConnectorOptions = {}): Promise<void> {
  const config = await readFeishuConfig(projectRoot);
  if (!config.enabled) throw new Error('feishu connector is disabled');
  const holder = options.holder ?? `spec-loop-feishu-${process.pid}`;
  const ttlMs = options.leaseTtlMs ?? 60_000;
  const controller = new AbortController();
  const signal = controller.signal;
  let acceptingActions = false;
  const closeActionGate = (): void => { acceptingActions = false; };
  signal.addEventListener('abort', closeActionGate, { once: true });
  const stop = (): void => controller.abort();
  const forwardAbort = (): void => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (!options.signal) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  let transport: FeishuTransport | undefined;
  let lease: ConnectorLease | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let heartbeatWork: Promise<void> = Promise.resolve();
  const heartbeatDelay = Math.max(500, Math.floor(ttlMs / 3));
  const scheduleHeartbeat = (): void => {
    heartbeatTimer = setTimeout(() => {
      heartbeatWork = (async () => {
        if (!lease) throw new Error('feishu connector lease is unavailable');
        if (await exists(leaseStopFile(await feishuConnectorRoot(projectRoot), lease.token))) {
          controller.abort();
          return;
        }
        await renewFeishuLease(projectRoot, lease.token, ttlMs);
      })().catch(() => controller.abort()).finally(() => {
        if (!signal.aborted) scheduleHeartbeat();
      });
    }, heartbeatDelay);
  };
  try {
    if (signal.aborted) return;
    transport = options.transport ?? new OfficialFeishuTransport(await resolveFeishuCredentials(config, options.secretProvider));
    if (signal.aborted) return;
    let preflightTimedOut = false;
    const preflightTimer = setTimeout(() => {
      preflightTimedOut = true;
      controller.abort();
    }, 15_000);
    try {
      await transport.preflight(config, signal);
    } catch (error) {
      if (preflightTimedOut) throw new Error('feishu preflight timed out');
      if (signal.aborted) return;
      throw error;
    } finally {
      clearTimeout(preflightTimer);
    }
    if (signal.aborted) return;
    lease = await acquireFeishuLease(projectRoot, holder, ttlMs);
    if (signal.aborted) return;
    scheduleHeartbeat();
    const connectPromise = transport.connect(async () => {
      if (signal.aborted || !acceptingActions || !lease) return;
      try {
        await withFeishuLeaseFence(projectRoot, lease.token, async () => {
          if (signal.aborted || !acceptingActions) return;
          /* Confirmation handling is added by TASK-024. */
        });
      } catch {
        controller.abort();
      }
    });
    let connectAbortListener: (() => void) | undefined;
    const connected = await Promise.race([
      connectPromise.then(() => true),
      new Promise<false>((resolve) => {
        connectAbortListener = () => resolve(false);
        signal.addEventListener('abort', connectAbortListener, { once: true });
      }),
    ]);
    if (connectAbortListener) signal.removeEventListener('abort', connectAbortListener);
    if (!connected || signal.aborted) return;
    await renewFeishuLease(projectRoot, lease.token, ttlMs).catch(() => controller.abort());
    acceptingActions = !signal.aborted;
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    }
  } finally {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    await heartbeatWork;
    signal.removeEventListener('abort', closeActionGate);
    options.signal?.removeEventListener('abort', forwardAbort);
    if (!options.signal) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    await transport?.disconnect().catch(() => undefined);
    if (lease) await releaseFeishuLease(projectRoot, lease.token).catch(() => undefined);
  }
}

export async function stopFeishuConnector(projectRoot: string): Promise<{ stopped: boolean; holder: string | null }> {
  const lease = await readFeishuLease(projectRoot);
  if (!lease || Date.parse(lease.expires_at) <= Date.now()) return { stopped: false, holder: lease?.holder ?? null };
  const root = await feishuConnectorRoot(projectRoot);
  const request = { schema_version: 1, token: lease.token, requested_at: new Date().toISOString() };
  await atomicWriteMany(root, [{ file: leaseStopFile(root, lease.token), content: `${JSON.stringify(request, null, 2)}\n` }]);
  return { stopped: true, holder: lease.holder };
}

export async function feishuConnectorStatus(projectRoot: string, provider: SecretProvider = new LocalSecretProvider()): Promise<Record<string, unknown>> {
  const config = await readFeishuConfig(projectRoot);
  const lease = await readFeishuLease(projectRoot);
  let credentialsAvailable = false;
  let credentialError: string | null = null;
  if (config.enabled) {
    try { await resolveFeishuCredentials(config, provider); credentialsAvailable = true; }
    catch (error) { credentialError = redactFeishuText((error as Error).message); }
  }
  return {
    enabled: config.enabled,
    tenant_configured: isValidTenantKey(config.tenant_key),
    target_count: config.targets.length,
    approver_count: config.approvers.length,
    credentials_available: credentialsAvailable,
    credential_error: credentialError,
    lease: lease ? { holder: lease.holder, pid: lease.pid, expires_at: lease.expires_at, expired: Date.parse(lease.expires_at) <= Date.now() } : null,
  };
}
