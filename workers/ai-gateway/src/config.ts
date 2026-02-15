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

// Use the Cloudflare AI Gateway if env vars are set
const useCfGateway = env.CF_AI_GATEWAY_TOKEN && env.CF_AI_GATEWAY_ID && env.CF_AI_GATEWAY_TOKEN

/**
 * Provider Config
 *
 * Change these to any upstream provider or proxy endpoints: Azure, AWS Bedrock, etc.
 * Defaults to using Cloudflare AI Gateway if env vars are configured.
 */
export const PROVIDER_CONFIG = {
  // ── Anthropic ──────────────────────────────────────────────
  anthropic: useCfGateway ? cfAiGateway : { baseUrl: 'https://api.anthropic.com' },

  // ── OpenAI ─────────────────────────────────────────────────
  openai: useCfGateway ? cfAiGateway : { baseUrl: 'https://api.openai.com' },
}
