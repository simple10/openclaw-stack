export type Provider = 'anthropic' | 'openai' | 'openai-codex'

export interface RouteMatch {
  provider: Provider
  /** AI Gateway sub-path (e.g. "anthropic/messages") */
  gatewayPath: string
  /** Direct API path (e.g. "/v1/messages") */
  directPath: string
}

/** Route match for generic OpenAI-compatible providers via /proxy/{provider}/... */
export interface GenericRouteMatch {
  provider: string
  /** Direct API path including v1/ prefix (e.g. "v1/chat/completions") */
  directPath: string
}

/** Method allowed per provider-prefixed route (pathname without leading slash). */
const ROUTES: Record<string, string> = {
  // Anthropic
  'anthropic/v1/messages': 'POST',
  // OpenAI (api.openai.com)
  'openai/v1/chat/completions': 'POST',
  'openai/v1/responses': 'POST',
  'openai/v1/embeddings': 'POST',
  'openai/v1/models': 'GET',
  // OpenAI Codex subscription (chatgpt.com/backend-api)
  // OpenClaw sends codex requests on the openai base URL path (/openai/v1/codex/responses),
  // but the upstream is chatgpt.com/backend-api (not api.openai.com). ROUTE_OVERRIDES
  // remaps the provider and strips the /v1/ prefix for the correct upstream path.
  // NOTE (2026-03-01): chatgpt.com WAF blocks CF Worker IPs — see config.ts for details.
  'openai/v1/codex/responses': 'POST',
  // OpenClaw's code agent uses a dedicated openai-codex provider with its own base URL,
  // which sends requests on /openai-codex/codex/responses instead of /openai/v1/codex/responses.
  // Both routes map to the same upstream (chatgpt.com/backend-api/codex/responses).
  'openai-codex/codex/responses': 'POST',
}

/**
 * Routes where the provider/upstream differs from the path prefix.
 * OpenClaw sends codex requests on the openai base URL, but the upstream is chatgpt.com/backend-api.
 */
const ROUTE_OVERRIDES: Record<string, { provider: Provider; directPath: string }> = {
  'openai/v1/codex/responses': { provider: 'openai-codex', directPath: 'codex/responses' },
  'openai-codex/codex/responses': { provider: 'openai-codex', directPath: 'codex/responses' },
}

/** AI Gateway sub-path: strip /v1/ segment → provider/rest */
function toGatewayPath(route: string): string {
  return route.replace('/v1/', '/')
}

/** Direct API path: strip provider prefix, keep /v1/ (no leading slash — callers add the separator) */
function toDirectPath(route: string): string {
  const slash = route.indexOf('/')
  return route.slice(slash + 1)
}

/** Match a request to a provider route, returning the provider and upstream paths. */
export function matchProviderRoute(method: string, pathname: string): RouteMatch | null {
  // Strip leading slash to match route keys
  const key = pathname.startsWith('/') ? pathname.slice(1) : pathname
  const allowed = ROUTES[key]
  if (!allowed || allowed !== method) return null

  const override = ROUTE_OVERRIDES[key]
  const provider = override?.provider ?? key.split('/')[0] as Provider
  return {
    provider,
    gatewayPath: toGatewayPath(key),
    directPath: override?.directPath ?? toDirectPath(key),
  }
}

// --- Generic provider routing (OpenAI-compatible) ---

/** Known generic providers. Requests to unknown providers are rejected. */
export const GENERIC_PROVIDERS = new Set([
  'cohere',
  'deepseek',
  'fireworks',
  'groq',
  'minimax',
  'mistral',
  'moonshot',
  'openrouter',
  'perplexity',
  'together',
  'xai',
])

/** Whitelisted endpoints for generic providers: directPath → allowed method. */
const GENERIC_ENDPOINTS: Record<string, string> = {
  'v1/chat/completions': 'POST',
  'v1/embeddings': 'POST',
  'v1/models': 'GET',
}

/**
 * Match a /proxy/{provider}/{rest} request to a generic provider route.
 * Returns null if the provider is unknown or the endpoint is not whitelisted.
 */
export function matchGenericRoute(method: string, pathname: string): GenericRouteMatch | null {
  // Strip leading slash, split into segments: ["proxy", provider, ...rest]
  const path = pathname.startsWith('/') ? pathname.slice(1) : pathname
  const firstSlash = path.indexOf('/')
  if (firstSlash === -1) return null

  const prefix = path.slice(0, firstSlash)
  if (prefix !== 'proxy') return null

  const rest = path.slice(firstSlash + 1)
  const secondSlash = rest.indexOf('/')
  if (secondSlash === -1) return null

  const provider = rest.slice(0, secondSlash)
  const directPath = rest.slice(secondSlash + 1)

  if (!GENERIC_PROVIDERS.has(provider)) return null

  const allowed = GENERIC_ENDPOINTS[directPath]
  if (!allowed || allowed !== method) return null

  return { provider, directPath }
}
