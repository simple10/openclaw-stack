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
