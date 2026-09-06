#!/usr/bin/env node

import { createHmac, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const baseUrl = 'https://114.132.189.139'
const host = 'ubuntu@114.132.189.139'
const key = resolve(homedir(), '.ssh/id_ed25519')
const revision = 'e7e5c31b1b4356b583d4f2db226c77cad668712c'
const repository = '/Users/zhangbo/personal-workspace/workspace/spec-loop/projects/erp'
const evidenceFile = resolve(repository, '.spec-loop/output/TASK-165-production-smoke.json')
const suffix = randomBytes(6).toString('hex')
const fullUsername = `task165-full-${suffix}`
const limitedUsername = `task165-limited-${suffix}`
const limitedRole = `TASK165_LIMITED_${suffix.toUpperCase()}`
const fullPassword = `T165-F-${randomBytes(24).toString('base64url')}!`
const limitedPassword = `T165-L-${randomBytes(24).toString('base64url')}!`
const checks = []

function fail(message) {
  throw new Error(message)
}

function sqlUtf8(value) {
  return `CONVERT(0x${Buffer.from(value, 'utf8').toString('hex')} USING utf8mb4)`
}

function bcrypt(password) {
  const result = spawnSync('htpasswd', ['-inBC', '12', 'task165'], {
    input: `${password}\n`,
    encoding: 'utf8',
  })
  const hash = result.stdout.trim().split(':', 2)[1]
  if (result.status !== 0 || !hash?.startsWith('$2')) fail('could not generate bcrypt hash')
  return `{bcrypt}${hash}`
}

function remoteMysql(sql) {
  const remote = `set -eu
container=$(sudo docker ps --filter label=com.docker.compose.service=mysql --format '{{.ID}}' | head -1)
test -n "$container"
sudo docker exec -i "$container" sh -lc 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=socket --default-character-set=utf8mb4 --batch --skip-column-names -uroot "$MYSQL_DATABASE"'`
  const result = spawnSync(
    'ssh',
    ['-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remote],
    { input: sql, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  if (result.status !== 0) fail(`production fixture SQL failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function prepare() {
  remoteMysql(`
START TRANSACTION;
SET @actor_id = (SELECT MIN(id) FROM common_user);
SET @super_id = (SELECT id FROM common_role WHERE role_code='SUPER_ADMIN' AND enabled=TRUE);
INSERT INTO common_role
  (role_code, role_name, description, system_role, enabled, created_by, updated_by)
VALUES
  (${sqlUtf8(limitedRole)}, 'TASK-165 production smoke restricted role',
   'Ephemeral no-business-permission role', FALSE, TRUE, @actor_id, @actor_id);
SET @limited_role_id = LAST_INSERT_ID();
INSERT INTO common_role_data_scope
  (role_id, scope_type, scope_key, enabled, created_by, updated_by)
VALUES
  (@limited_role_id, 'COMPANY', '*', TRUE, @actor_id, @actor_id),
  (@limited_role_id, 'FACTORY', '*', TRUE, @actor_id, @actor_id);
INSERT INTO common_user
  (username, display_name, password_hash, status, enabled, created_by, updated_by)
VALUES
  (${sqlUtf8(fullUsername)}, 'TASK-165 production full smoke', ${sqlUtf8(bcrypt(fullPassword))},
   'ACTIVE', TRUE, @actor_id, @actor_id);
SET @full_id = LAST_INSERT_ID();
INSERT INTO common_user_role
  (user_id, role_id, assignment_reason, enabled, created_by, updated_by)
VALUES
  (@full_id, @super_id, 'TASK-165 ephemeral production smoke', TRUE, @actor_id, @actor_id);
INSERT INTO common_user
  (username, display_name, password_hash, status, enabled, created_by, updated_by)
VALUES
  (${sqlUtf8(limitedUsername)}, 'TASK-165 production restricted smoke', ${sqlUtf8(bcrypt(limitedPassword))},
   'ACTIVE', TRUE, @actor_id, @actor_id);
SET @limited_id = LAST_INSERT_ID();
INSERT INTO common_user_role
  (user_id, role_id, assignment_reason, enabled, created_by, updated_by)
VALUES
  (@limited_id, @limited_role_id, 'TASK-165 ephemeral authorization denial smoke', TRUE, @actor_id, @actor_id);
COMMIT;
`)
}

function cleanup() {
  return remoteMysql(`
START TRANSACTION;
SET @full_id = (SELECT id FROM common_user WHERE username=${sqlUtf8(fullUsername)});
SET @limited_id = (SELECT id FROM common_user WHERE username=${sqlUtf8(limitedUsername)});
SET @limited_role_id = (SELECT id FROM common_role WHERE role_code=${sqlUtf8(limitedRole)});
DELETE FROM erp_mfa_recovery_code WHERE user_id IN (@full_id, @limited_id);
DELETE FROM erp_mfa_challenge WHERE user_id IN (@full_id, @limited_id);
DELETE FROM erp_user_mfa WHERE user_id IN (@full_id, @limited_id);
DELETE FROM common_user_role WHERE user_id IN (@full_id, @limited_id);
DELETE FROM erp_login_guard WHERE username_key IN (${sqlUtf8(fullUsername)}, ${sqlUtf8(limitedUsername)});
DELETE FROM common_user WHERE id IN (@full_id, @limited_id);
DELETE FROM common_role_permission WHERE role_id=@limited_role_id;
DELETE FROM common_role_data_scope WHERE role_id=@limited_role_id;
DELETE FROM common_role WHERE id=@limited_role_id;
COMMIT;
SELECT
  (SELECT COUNT(*) FROM common_user WHERE username IN (${sqlUtf8(fullUsername)}, ${sqlUtf8(limitedUsername)})) +
  (SELECT COUNT(*) FROM common_role WHERE role_code=${sqlUtf8(limitedRole)}) +
  (SELECT COUNT(*) FROM erp_login_guard WHERE username_key IN (${sqlUtf8(fullUsername)}, ${sqlUtf8(limitedUsername)}));
`)
}

function cookieJar() {
  const values = new Map()
  return {
    absorb(headers) {
      const cookies = typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : [headers.get('set-cookie')].filter(Boolean)
      for (const cookie of cookies) {
        const pair = cookie.split(';', 1)[0]
        const separator = pair.indexOf('=')
        if (separator > 0) values.set(pair.slice(0, separator), pair.slice(separator + 1))
      }
    },
    header() {
      return [...values].map(([name, value]) => `${name}=${value}`).join('; ')
    },
  }
}

async function csrf(jar) {
  const response = await fetch(`${baseUrl}/api/v1/security/csrf`, {
    headers: jar.header() ? { Cookie: jar.header() } : {},
  })
  jar.absorb(response.headers)
  const payload = await envelope(response, 'csrf')
  return payload.data.token
}

async function envelope(response, label, expectedStatus = 200) {
  let payload
  try {
    payload = await response.json()
  } catch {
    fail(`${label}: non-JSON HTTP ${response.status}`)
  }
  if (response.status !== expectedStatus) {
    fail(`${label}: expected HTTP ${expectedStatus}, got ${response.status} (${payload?.code ?? 'no-code'})`)
  }
  if (expectedStatus === 200 && (payload?.code !== 'OK' || !('data' in payload))) {
    fail(`${label}: invalid success envelope`)
  }
  checks.push({ label, status: response.status, code: payload?.code ?? null })
  return payload
}

async function get(jar, path, label, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: jar.header() ? { Cookie: jar.header() } : {},
  })
  jar.absorb(response.headers)
  return envelope(response, label, expectedStatus)
}

async function post(jar, path, body, label, expectedStatus = 200) {
  const token = await csrf(jar)
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-XSRF-TOKEN': token,
      Cookie: jar.header(),
    },
    body: JSON.stringify(body),
  })
  jar.absorb(response.headers)
  return envelope(response, label, expectedStatus)
}

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let buffer = 0
  let bits = 0
  const output = []
  for (const character of value.toUpperCase()) {
    const decoded = alphabet.indexOf(character)
    if (decoded < 0) fail('MFA setup returned an invalid Base32 secret')
    buffer = (buffer << 5) | decoded
    bits += 5
    if (bits >= 8) {
      output.push((buffer >> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(output)
}

function currentTotp(secret) {
  const counter = Math.floor(Date.now() / 1000 / 30)
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', decodeBase32(secret)).update(bytes).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  return String(binary % 1_000_000).padStart(6, '0')
}

async function authenticatedProductionSmoke() {
  const enrollmentJar = cookieJar()
  const login = await post(
    enrollmentJar,
    '/api/v1/auth/login',
    { username: fullUsername, password: fullPassword },
    'full password login',
  )
  if (login.data?.username !== fullUsername || login.data?.mfaRequired) {
    fail('full password login returned the wrong state')
  }
  const setup = await post(
    enrollmentJar,
    '/api/v1/auth/mfa/setup',
    { currentPassword: fullPassword },
    'MFA setup',
  )
  if (!setup.data?.secret || !setup.data?.otpauthUri?.startsWith('otpauth://totp/')) {
    fail('MFA setup did not return a valid enrollment contract')
  }
  const confirmed = await post(
    enrollmentJar,
    '/api/v1/auth/mfa/confirm',
    { currentPassword: fullPassword, code: currentTotp(setup.data.secret) },
    'MFA confirm',
  )
  if (confirmed.data?.recoveryCodes?.length !== 8) fail('MFA confirm did not return eight recovery codes')
  await post(enrollmentJar, '/api/v1/auth/logout', {}, 'full logout after enrollment')

  const mfaJar = cookieJar()
  const challenge = await post(
    mfaJar,
    '/api/v1/auth/login',
    { username: fullUsername, password: fullPassword },
    'MFA password challenge',
  )
  if (!challenge.data?.mfaRequired || !challenge.data?.challengeId) {
    fail('MFA-enabled login did not return a challenge')
  }
  const completed = await post(
    mfaJar,
    '/api/v1/auth/login/mfa',
    { challengeId: challenge.data.challengeId, code: currentTotp(setup.data.secret) },
    'MFA TOTP login',
  )
  if (completed.data?.username !== fullUsername || completed.data?.mfaRequired) {
    fail('MFA completion returned the wrong principal')
  }
  const status = await get(mfaJar, '/api/v1/auth/mfa', 'MFA active status')
  if (status.data?.enabled !== true) fail('MFA status is not active after confirmation')
  await get(mfaJar, '/api/v1/auth/me', 'authenticated current user')

  const organization = completed.data?.organization ?? {}
  const company = encodeURIComponent(organization.companyCode ?? 'DEFAULT')
  const factory = encodeURIComponent(organization.factoryCode ?? 'DEFAULT')
  const endpoints = [
    [`/api/v1/purchase/workbench?companyCode=${company}&factoryCode=${factory}&limit=100`, 'purchase workbench'],
    [`/api/v1/sales/workbench?companyCode=${company}&factoryCode=${factory}&limit=100`, 'sales workbench'],
    [`/api/v1/inventory/workbench?companyCode=${company}&factoryCode=${factory}&balancePage=0&transactionPage=0&lotPage=0&genealogyPage=0&size=20`, 'inventory workbench'],
  ]
  for (const [path, label] of endpoints) await get(mfaJar, path, label)

  const limitedJar = cookieJar()
  const limited = await post(
    limitedJar,
    '/api/v1/auth/login',
    { username: limitedUsername, password: limitedPassword },
    'restricted password login',
  )
  if (limited.data?.username !== limitedUsername) fail('restricted login returned the wrong principal')
  await get(
    limitedJar,
    `/api/v1/purchase/workbench?companyCode=${company}&factoryCode=${factory}&limit=100`,
    'restricted purchase denial',
    403,
  )
}

let smokeError
let cleanupCount
try {
  prepare()
  await authenticatedProductionSmoke()
} catch (error) {
  smokeError = error
} finally {
  try {
    cleanupCount = cleanup()
  } catch (cleanupError) {
    if (smokeError) {
      smokeError = new AggregateError([smokeError, cleanupError], 'smoke and cleanup both failed')
    } else {
      smokeError = cleanupError
    }
  }
}

if (cleanupCount !== '0') fail(`ephemeral fixture cleanup left ${cleanupCount || 'unknown'} rows`)
checks.push({ label: 'ephemeral database cleanup', status: 0, code: 'ZERO_ROWS' })
if (smokeError) throw smokeError

const evidence = {
  task: 'TASK-165',
  revision,
  environment: 'production',
  endpoint: baseUrl,
  completedAt: new Date().toISOString(),
  browserVisualReview: 'not-run-in-app-browser-unavailable',
  credentialsPersisted: false,
  ephemeralFixtureRowsAfterCleanup: 0,
  checks,
  result: 'PASS',
}
mkdirSync(dirname(evidenceFile), { recursive: true })
writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`PASS: TASK-165 production authentication, TOTP MFA, authorized reads, denied read and zero-residue cleanup passed (${checks.length} checks).\n`)
