import type { Provider } from './routing'
import { env } from 'cloudflare:workers'

export interface ProviderConfig {
  baseUrl: string
  headers?: Record<string, string>
}

// Cloudflare AI Gateway Config (optional):
// Provides observability and token cost estimates, provides LLM routing, and more
// Same config can be used for all providers - CF AI Gateway uses the model to route upstream.
const cfAiGateway = {
  baseUrl: `https://gateway.ai.cloudflare.com/v1/${env.CF_AI_GATEWAY_ACCOUNT_ID}/${env.CF_AI_GATEWAY_ID}`,
  headers: { 'cf-aig-authorization': `Bearer ${env.CF_AI_GATEWAY_TOKEN}` },
}

export const PROVIDER_CONFIG = {
  // ── Anthropic ──────────────────────────────────────────────
  // Cloudflare AI Gateway (optional):
  // anthropic: cfAiGateway,
  // Direct API (default)
  anthropic: { baseUrl: 'https://api.anthropic.com' },

  // ── OpenAI ─────────────────────────────────────────────────
  // Cloudflare AI Gateway (optional):
  // openai: cfAiGateway,
  // Direct API — replace the line above to bypass CF AI Gateway:
  openai: { baseUrl: 'https://api.openai.com' },
}
