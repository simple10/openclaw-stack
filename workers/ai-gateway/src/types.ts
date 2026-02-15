export type { Log } from './log'
export type { Provider, RouteMatch } from './routing'
export type { ProviderConfig } from './config'

export interface Env {
  // Vars (wrangler.toml)
  /** Cloudflare AI Gateway ID */
  CF_AI_GATEWAY_ID: string
  /** Log level: debug | info | warn | error (default: info) */
  LOG_LEVEL?: string

  //
  // Secrets (wrangler secret put)
  //

  /** Cloudflare Account ID */
  CF_AI_GATEWAY_ACCOUNT_ID: string
  /** Token used to authorize requests to this worker */
  AUTH_TOKEN: string
  /** OpenAI API Key - can be omitted if BYOK is configured in Cloudflare AI Gateway */
  OPENAI_API_KEY: string
  /** Anthropic API Key - can be omitted if BYOK is configured in Cloudflare AI Gateway */
  ANTHROPIC_API_KEY: string
  /** OAuth token for Claude Code (sk-ant-oat prefix) — used instead of ANTHROPIC_API_KEY for OAuth clients */
  CLAUDE_CODE_OAUTH_TOKEN: string
  /** Token used to authorize the forwarded request in the Cloudflare AI Gateway */
  CF_AI_GATEWAY_TOKEN: string
}
