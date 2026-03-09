import type { Log, Provider, UserCredentials } from './types'
import { refreshOpenAIToken } from './openai-oauth'

const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry

/** Load and parse user credentials from KV. Returns undefined on missing or invalid data. */
async function loadCredentials(
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<UserCredentials | undefined> {
  const raw = await kv.get(`creds:${userId}`)
  if (!raw) {
    log.warn(`[keys] no credentials in KV for user ${userId}`)
    return undefined
  }

  try {
    return JSON.parse(raw)
  } catch {
    log.error(`[keys] failed to parse credentials for user ${userId}`)
    return undefined
  }
}

/** Resolve the upstream API key for a provider from the user's KV credentials. */
export async function getProviderApiKey(
  provider: Provider,
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<string | undefined> {
  const creds = await loadCredentials(userId, kv, log)
  if (!creds) return undefined

  if (provider === 'anthropic') {
    return resolveAnthropicKey(creds, log)
  }

  return resolveOpenAIKey(creds, userId, kv, log)
}

function resolveAnthropicKey(creds: UserCredentials, log: Log): string | undefined {
  const key = creds.anthropic?.oauthToken ?? creds.anthropic?.apiKey
  if (!key) log.warn('[keys] no Anthropic credentials found for user')
  return key
}

async function resolveOpenAIKey(
  creds: UserCredentials,
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<string | undefined> {
  const oauth = creds.openai?.oauth
  if (oauth) {
    const now = Date.now()

    // Token still fresh — use it
    if (now < oauth.expiresAt - REFRESH_BUFFER_MS) {
      log.debug('[keys] using cached OpenAI OAuth token (expires in', Math.round((oauth.expiresAt - now) / 1000), 's)')
      return oauth.accessToken
    }

    // Token needs refresh
    log.info('[keys] OpenAI OAuth token expiring soon, refreshing...')
    const result = await refreshOpenAIToken(oauth.refreshToken, log)

    if (result) {
      // Write updated tokens back to KV
      creds.openai!.oauth = {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
      }
      await kv.put(`creds:${userId}`, JSON.stringify(creds))
      log.info('[keys] OpenAI OAuth tokens refreshed for user', userId)
      return result.accessToken
    }

    // Refresh failed — use stale token if not yet expired
    if (now < oauth.expiresAt) {
      log.warn('[keys] OpenAI OAuth refresh failed but token not yet expired, using stale token')
      return oauth.accessToken
    }

    log.error('[keys] OpenAI OAuth refresh failed and token expired for user', userId)
    // Fall through to static API key
  }

  const key = creds.openai?.apiKey
  if (!key) log.warn('[keys] no OpenAI credentials found for user')
  return key
}

/** Resolve the API key for a generic provider from the user's KV credentials. */
export async function getGenericApiKey(
  provider: string,
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<string | undefined> {
  const creds = await loadCredentials(userId, kv, log)
  if (!creds) return undefined

  const key = creds.providers?.[provider]?.apiKey
  if (!key) log.warn(`[keys] no ${provider} credentials found for user ${userId}`)
  return key
}
