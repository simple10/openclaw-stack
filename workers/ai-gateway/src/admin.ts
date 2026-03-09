import type { Log } from './types'
import type { UserCredentials, UserEntry, UsersRegistry } from './types'
import { jsonError } from './errors'

/** Generate a random hex string of the given byte length. */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 hash of a string, returned as hex. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

/** Base64url-encode a buffer (no padding). */
function base64url(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Generate a JWT-shaped gateway auth token for OpenClaw's openai-codex provider.
 * Uses anonymized claims so the token passes OpenClaw's JWT validation without
 * containing any real user data. The gateway matches the full token (via SHA-256
 * hash lookup) and swaps it for the real Codex OAuth credentials.
 */
async function generateCodexJwt(): Promise<string> {
  const enc = new TextEncoder()
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    exp: 9999999999,
    'https://api.openai.com/auth': {
      chatgpt_account_id: crypto.randomUUID(),
      chatgpt_user_id: `user-${randomHex(12)}`,
    },
    'https://api.openai.com/profile': {
      email: 'user@example.com',
    },
    sub: 'gateway-proxy',
    iat: Math.floor(Date.now() / 1000),
    iss: 'https://auth.openai.com',
  }

  const headerB64 = base64url(enc.encode(JSON.stringify(header)))
  const payloadB64 = base64url(enc.encode(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`

  const key = await crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  ) as CryptoKey
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput))

  return `${headerB64}.${payloadB64}.${base64url(sig)}`
}

/**
 * Generate a Codex paste JWT and store its hash as a valid auth token in KV.
 * Returns the raw JWT string for the user to paste into OpenClaw.
 */
async function generateAndStoreCodexToken(
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<string> {
  const jwt = await generateCodexJwt()
  const hash = await sha256Hex(jwt)

  // Store token hash → userId mapping in KV
  await kv.put(`token:${hash}`, userId)

  // Add hash to user's tokens list in registry
  const registry = await getRegistry(kv)
  const user = registry[userId]
  if (user) {
    user.tokens.push(hash)
    await putRegistry(kv, registry)
  }

  log.info(`[admin] generated codex paste token for user ${userId}`)
  return jwt
}

/** Read the users registry from KV, returning an empty object if missing. */
async function getRegistry(kv: KVNamespace): Promise<UsersRegistry> {
  const raw = await kv.get('users')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** Write the users registry back to KV. */
async function putRegistry(kv: KVNamespace, registry: UsersRegistry): Promise<void> {
  await kv.put('users', JSON.stringify(registry))
}

// Path patterns for admin routes
const USER_CREDS_RE = /^\/admin\/users\/([^/]+)\/creds$/
const USER_ID_RE = /^\/admin\/users\/([^/]+)$/

/**
 * Handle all /admin/* requests. Caller has already validated the admin token.
 */
export async function handleAdminRequest(
  request: Request,
  pathname: string,
  kv: KVNamespace,
  log: Log
): Promise<Response> {
  // POST /admin/users — create user
  if (request.method === 'POST' && pathname === '/admin/users') {
    return createUser(request, kv, log)
  }

  // GET /admin/users — list users
  if (request.method === 'GET' && pathname === '/admin/users') {
    return listUsers(kv)
  }

  // PUT /admin/users/:id/creds — update credentials
  const credsMatch = pathname.match(USER_CREDS_RE)
  if (request.method === 'PUT' && credsMatch) {
    return updateUserCreds(request, credsMatch[1], kv, log)
  }

  // DELETE /admin/users/:id — delete user
  const deleteMatch = pathname.match(USER_ID_RE)
  if (request.method === 'DELETE' && deleteMatch) {
    return deleteUser(deleteMatch[1], kv, log)
  }

  return jsonError('Not found', 404)
}

/**
 * Handle POST /auth/rotate — generate a new token, expire old ones in 1 hour.
 * Caller has already authenticated the user.
 */
export async function handleTokenRotation(
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<Response> {
  const registry = await getRegistry(kv)
  const user = registry[userId]
  if (!user) {
    return jsonError('User not found', 404)
  }

  const newToken = randomHex(24)
  const expiresInSeconds = 3600 // 1 hour

  // Create new token mapping (no TTL — permanent until rotated)
  await kv.put(`token:${newToken}`, userId)

  // Set TTL on all old tokens (they'll auto-delete after 1 hour)
  const oldTokens = user.tokens
  const expireAt = Math.floor(Date.now() / 1000) + expiresInSeconds
  for (const oldToken of oldTokens) {
    await kv.put(`token:${oldToken}`, userId, { expiration: expireAt })
  }

  // Update registry with new token appended
  user.tokens = [...oldTokens, newToken]
  registry[userId] = user
  await putRegistry(kv, registry)

  log.info(`[admin] rotated token for user ${userId}, ${oldTokens.length} old token(s) expire in ${expiresInSeconds}s`)

  return jsonResponse({
    token: newToken,
    oldTokensExpireAt: new Date(expireAt * 1000).toISOString(),
  })
}

// --- CRUD handlers ---

async function createUser(
  request: Request,
  kv: KVNamespace,
  log: Log
): Promise<Response> {
  let body: { name?: string; ip?: string; creds?: UserCredentials }
  try {
    body = await request.json()
  } catch {
    return jsonError('Invalid JSON body', 400)
  }

  if (!body.name || typeof body.name !== 'string') {
    return jsonError('Missing required field: name', 400)
  }

  const userId = `usr_${randomHex(8)}`
  const token = randomHex(24)

  // Store token → userId mapping
  await kv.put(`token:${token}`, userId)

  // Store credentials (default to empty if not provided)
  const creds: UserCredentials = body.creds ?? {}
  await kv.put(`creds:${userId}`, JSON.stringify(creds))

  // Update users registry
  const registry = await getRegistry(kv)
  const entry: UserEntry = {
    name: body.name,
    ip: body.ip,
    tokens: [token],
    createdAt: new Date().toISOString(),
  }
  registry[userId] = entry
  await putRegistry(kv, registry)

  log.info(`[admin] created user ${userId} (${body.name})`)

  return jsonResponse({ userId, token }, 201)
}

async function listUsers(kv: KVNamespace): Promise<Response> {
  const registry = await getRegistry(kv)
  return jsonResponse(registry)
}

async function updateUserCreds(
  request: Request,
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<Response> {
  const registry = await getRegistry(kv)
  if (!registry[userId]) {
    return jsonError('User not found', 404)
  }

  let creds: UserCredentials
  try {
    creds = await request.json()
  } catch {
    return jsonError('Invalid JSON body', 400)
  }

  await kv.put(`creds:${userId}`, JSON.stringify(creds))
  log.info(`[admin] updated credentials for user ${userId}`)

  return jsonResponse({ ok: true })
}

async function deleteUser(
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<Response> {
  const registry = await getRegistry(kv)
  const user = registry[userId]
  if (!user) {
    return jsonError('User not found', 404)
  }

  // Delete all token mappings
  for (const token of user.tokens) {
    await kv.delete(`token:${token}`)
  }

  // Delete credentials
  await kv.delete(`creds:${userId}`)

  // Remove from registry
  delete registry[userId]
  await putRegistry(kv, registry)

  log.info(`[admin] deleted user ${userId} (${user.name})`)

  return jsonResponse({ ok: true })
}

// --- Self-service credential endpoints ---

/** GET /auth/creds — return masked credentials for the authenticated user. */
export async function handleGetUserCreds(
  userId: string,
  kv: KVNamespace
): Promise<Response> {
  const raw = await kv.get(`creds:${userId}`)
  const creds: UserCredentials = raw ? JSON.parse(raw) : {}
  return jsonResponse(maskCredentials(creds))
}

/** PUT /auth/creds — merge-update credentials for the authenticated user. */
export async function handleUpdateUserCreds(
  request: Request,
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<Response> {
  let update: Record<string, unknown>
  try {
    update = await request.json()
  } catch {
    return jsonError('Invalid JSON body', 400)
  }

  const raw = await kv.get(`creds:${userId}`)
  const existing: UserCredentials = raw ? JSON.parse(raw) : {}
  const merged = mergeCredentials(existing, update)

  await kv.put(`creds:${userId}`, JSON.stringify(merged))
  log.info(`[admin] user ${userId} updated their credentials`)

  // Auto-generate codex paste token when openai.oauth is set/updated
  const openaiUpdate = update.openai as Record<string, unknown> | undefined
  let codexPasteToken: string | undefined
  if (openaiUpdate?.oauth && openaiUpdate.oauth !== null) {
    codexPasteToken = await generateAndStoreCodexToken(userId, kv, log)
  }

  const response: Record<string, unknown> = maskCredentials(merged)
  if (codexPasteToken) {
    response.codexPasteToken = codexPasteToken
  }

  return jsonResponse(response)
}

/** POST /auth/codex-token — generate a new codex paste token for the authenticated user. */
export async function handleCodexTokenGeneration(
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<Response> {
  const raw = await kv.get(`creds:${userId}`)
  const creds: UserCredentials = raw ? JSON.parse(raw) : {}
  if (!creds.openai?.oauth) {
    return jsonError('No Codex OAuth credentials configured — add them first', 400)
  }

  const jwt = await generateAndStoreCodexToken(userId, kv, log)
  return jsonResponse({ codexPasteToken: jwt })
}

// --- Mask / Merge helpers ---

/** Mask a string to show first 8 + last 4 chars: "sk-ant-api...4f2a" */
export function maskString(s: string): string {
  if (s.length <= 16) return '***'
  return s.slice(0, 8) + '...' + s.slice(-4)
}

/** Return a masked copy of credentials (safe for client display). */
export function maskCredentials(creds: UserCredentials): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  if (creds.anthropic) {
    const a: Record<string, unknown> = {}
    if (creds.anthropic.apiKey) a.apiKey = maskString(creds.anthropic.apiKey)
    if (creds.anthropic.oauthToken) a.oauthToken = maskString(creds.anthropic.oauthToken)
    if (Object.keys(a).length > 0) result.anthropic = a
  }

  if (creds.openai) {
    const o: Record<string, unknown> = {}
    if (creds.openai.apiKey) o.apiKey = maskString(creds.openai.apiKey)
    if (creds.openai.oauth) {
      o.oauth = {
        status: 'configured',
        expiresAt: creds.openai.oauth.expiresAt,
      }
    }
    if (Object.keys(o).length > 0) result.openai = o
  }

  return result
}

/**
 * Deep-merge credential update into existing credentials.
 * - Field present with value → update
 * - Field present with null → delete
 * - Field absent → keep existing
 */
export function mergeCredentials(
  existing: UserCredentials,
  update: Record<string, unknown>
): UserCredentials {
  const result: UserCredentials = structuredClone(existing)

  if ('anthropic' in update) {
    if (update.anthropic === null) {
      delete result.anthropic
    } else {
      const u = update.anthropic as Record<string, unknown>
      if (!result.anthropic) result.anthropic = {}
      if ('apiKey' in u) {
        if (u.apiKey === null) delete result.anthropic.apiKey
        else result.anthropic.apiKey = u.apiKey as string
      }
      if ('oauthToken' in u) {
        if (u.oauthToken === null) delete result.anthropic.oauthToken
        else result.anthropic.oauthToken = u.oauthToken as string
      }
      // Clean up empty provider section
      if (!result.anthropic.apiKey && !result.anthropic.oauthToken) {
        delete result.anthropic
      }
    }
  }

  if ('openai' in update) {
    if (update.openai === null) {
      delete result.openai
    } else {
      const u = update.openai as Record<string, unknown>
      if (!result.openai) result.openai = {}
      if ('apiKey' in u) {
        if (u.apiKey === null) delete result.openai.apiKey
        else result.openai.apiKey = u.apiKey as string
      }
      if ('oauth' in u) {
        if (u.oauth === null) delete result.openai.oauth
        else result.openai.oauth = u.oauth as NonNullable<NonNullable<UserCredentials['openai']>['oauth']>
      }
      // Clean up empty provider section
      if (!result.openai.apiKey && !result.openai.oauth) {
        delete result.openai
      }
    }
  }

  return result
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
