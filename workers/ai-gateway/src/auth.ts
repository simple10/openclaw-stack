/**
 * Extract the bearer token from Authorization or x-api-key header.
 * Returns the raw token string, or null if no token is present.
 */
export function extractToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization')
  if (authHeader) {
    if (!authHeader.startsWith('Bearer ')) return null
    return authHeader.slice(7)
  }

  return request.headers.get('x-api-key') ?? null
}

/**
 * Look up a user token in KV. Returns the userId or null if the token
 * is invalid/expired (expired tokens are auto-deleted by KV TTL).
 *
 * Supports three token formats:
 * 1. Exact hex tokens (e.g. gateway auth tokens)
 * 2. JWT tokens — stored by SHA-256 hash since JWTs exceed KV key limits
 * 3. Provider-prefixed tokens — OpenClaw may prepend a prefix (e.g. "sk-ant-api03-xxxxx-TOKEN")
 */
export async function authenticateRequest(
  request: Request,
  kv: KVNamespace
): Promise<string | null> {
  const token = extractToken(request)
  if (!token) return null

  // Try exact match first (regular hex tokens)
  const userId = await kv.get(`token:${token}`)
  if (userId) return userId

  // JWT tokens are too long for KV keys — look up by SHA-256 hash
  if (token.split('.').length === 3) {
    const hash = await sha256Hex(token)
    const jwtUserId = await kv.get(`token:${hash}`)
    if (jwtUserId) return jwtUserId
  }

  // Fallback: strip provider prefix (last dash-segment is the real token)
  if (token.includes('-')) {
    const lastSegment = token.split('-').pop()!
    return kv.get(`token:${lastSegment}`)
  }

  return null
}

/** SHA-256 hash of a string, returned as hex. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Validate the admin token from the request against the expected value.
 * Uses timing-safe comparison via SHA-256 digest.
 */
export async function validateAdminToken(
  request: Request,
  expectedToken: string
): Promise<boolean> {
  const token = extractToken(request)
  if (!token) return false
  return timingSafeEqual(token, expectedToken)
}

/** Constant-time string comparison via SHA-256 digest. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ])

  const viewA = new Uint8Array(digestA)
  const viewB = new Uint8Array(digestB)

  if (viewA.length !== viewB.length) return false

  let result = 0
  for (let i = 0; i < viewA.length; i++) {
    result |= viewA[i] ^ viewB[i]
  }
  return result === 0
}
