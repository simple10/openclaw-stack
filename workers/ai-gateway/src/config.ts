import { env } from 'cloudflare:workers'

export interface ProviderConfig {
  baseUrl: string
  headers?: Record<string, string>
  /** When set, requests are routed through this egress proxy URL (e.g. VPS sidecar) */
  egressProxyUrl?: string
}

/**
 * Provider Config
 *
 * Returns the provider config for a given provider. Must be called at request time
 * (not module-level) so that env vars/secrets are available from the Workers runtime.
 *
 * Change these to any upstream provider or proxy endpoints: Azure, AWS Bedrock, etc.
 * Defaults to using Cloudflare AI Gateway if env vars are configured.
 */
export function getProviderConfig(provider: string): ProviderConfig {
  // Cloudflare AI Gateway (optional):
  // Provides observability and token cost estimates, LLM routing, and more.
  // Same config can be used for all providers — CF AI Gateway uses the model to route upstream.
  const useCfGateway = env.CF_AI_GATEWAY_TOKEN && env.CF_AI_GATEWAY_ID && env.CF_AI_GATEWAY_ACCOUNT_ID
  const cfAiGateway: ProviderConfig = {
    baseUrl: `https://gateway.ai.cloudflare.com/v1/${env.CF_AI_GATEWAY_ACCOUNT_ID}/${env.CF_AI_GATEWAY_ID}`,
    headers: { 'cf-aig-authorization': `Bearer ${env.CF_AI_GATEWAY_TOKEN}` },
  }

  switch (provider) {
    // ── Anthropic ──────────────────────────────────────────────
    case 'anthropic':
      return useCfGateway ? cfAiGateway : { baseUrl: 'https://api.anthropic.com' }

    // ── OpenAI ─────────────────────────────────────────────────
    case 'openai':
      return useCfGateway ? cfAiGateway : { baseUrl: 'https://api.openai.com' }

    // ── OpenAI Codex subscription ─────────────────────────────
    // Uses chatgpt.com/backend-api instead of api.openai.com.
    // chatgpt.com's Cloudflare WAF blocks requests from CF Worker IPs (403),
    // so codex requests are routed through a VPS egress proxy sidecar.
    case 'openai-codex':
      return {
        baseUrl: 'https://chatgpt.com/backend-api',
        egressProxyUrl: env.EGRESS_PROXY_URL || undefined,
        headers: env.EGRESS_PROXY_AUTH_TOKEN
          ? {
              'X-Proxy-Auth': `Bearer ${env.EGRESS_PROXY_AUTH_TOKEN}`,
              // CF Access service token — authenticates to Cloudflare Zero Trust
              ...(env.CF_ACCESS_CLIENT_ID && {
                'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
                'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
              }),
            }
          : undefined,
      }

    default:
      return { baseUrl: '' }
  }
}

// --- Generic provider defaults ---

/** Verified base URLs for generic OpenAI-compatible providers.
 *  Base URLs do NOT include /v1 — the directPath from route matching provides it.
 *  e.g. Groq: baseUrl="https://api.groq.com/openai" + "/v1/chat/completions" */
const PROVIDER_DEFAULTS: Record<string, { baseUrl: string }> = {
  cohere:     { baseUrl: 'https://api.cohere.ai/compatibility' },
  deepseek:   { baseUrl: 'https://api.deepseek.com' },
  fireworks:  { baseUrl: 'https://api.fireworks.ai/inference' },
  groq:       { baseUrl: 'https://api.groq.com/openai' },
  minimax:    { baseUrl: 'https://api.minimax.io' },
  mistral:    { baseUrl: 'https://api.mistral.ai' },
  moonshot:   { baseUrl: 'https://api.moonshot.ai' },
  openrouter: { baseUrl: 'https://openrouter.ai/api' },
  perplexity: { baseUrl: 'https://api.perplexity.ai' },
  together:   { baseUrl: 'https://api.together.xyz' },
  xai:        { baseUrl: 'https://api.x.ai' },
}

/** Look up the config for a generic provider. Includes egress proxy if configured. Returns null for unknown providers. */
export function getGenericProviderConfig(provider: string): ProviderConfig | null {
  const defaults = PROVIDER_DEFAULTS[provider]
  if (!defaults) return null

  return {
    baseUrl: defaults.baseUrl,
    egressProxyUrl: env.EGRESS_PROXY_URL || undefined,
    headers: env.EGRESS_PROXY_AUTH_TOKEN
      ? {
          'X-Proxy-Auth': `Bearer ${env.EGRESS_PROXY_AUTH_TOKEN}`,
          ...(env.CF_ACCESS_CLIENT_ID && {
            'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
            'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
          }),
        }
      : undefined,
  }
}
