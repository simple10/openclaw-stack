export type { Log } from './log'
export type { Provider, RouteMatch } from './routing'
export type { GenericRouteMatch } from './routing'
export type { ProviderConfig } from './config'

// Use `wrangler types --env-file .dev.vars.example` to generate Env var types
//
// export interface Env {
//   // Vars (wrangler.toml)
// }

// --- KV schema types ---

/** The 3 original providers with dedicated route handling. */
export type LegacyProvider = 'anthropic' | 'openai' | 'openai-codex'

export interface UserCredentials {
  anthropic?: {
    apiKey?: string       // sk-ant-api-* (regular API key)
    oauthToken?: string   // sk-ant-oat-* (Claude Code subscription)
  }
  openai?: {
    apiKey?: string       // static API key
    oauth?: {             // Codex OAuth (priority over apiKey)
      accessToken: string
      refreshToken: string
      expiresAt: number   // epoch ms
    }
  }
  /** Generic OpenAI-compatible providers (deepseek, groq, mistral, etc.) */
  providers?: Record<string, { apiKey: string }>
}

export interface UserEntry {
  name: string
  ip?: string
  tokens: string[]
  createdAt: string       // ISO 8601
}

export type UsersRegistry = Record<string, UserEntry>
