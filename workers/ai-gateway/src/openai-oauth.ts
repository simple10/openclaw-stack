import type { Log } from './types'

const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann' // public Codex client ID

interface RefreshResult {
  accessToken: string
  refreshToken: string
  expiresAt: number // epoch ms
}

/**
 * Exchange a refresh token for a new access token via OpenAI's OAuth endpoint.
 * Returns null if the refresh fails (caller handles fallback).
 */
export async function refreshOpenAIToken(
  refreshToken: string,
  log: Log
): Promise<RefreshResult | null> {
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      log.error('[openai-oauth] refresh failed:', res.status, body)
      return null
    }

    const data = (await res.json()) as {
      access_token: string
      refresh_token?: string
      expires_in: number
    }

    return {
      accessToken: data.access_token,
      // OpenAI uses refresh token rotation — new refresh_token replaces the old one
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    }
  } catch (err) {
    log.error('[openai-oauth] refresh request error:', err)
    return null
  }
}
