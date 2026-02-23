import type { Provider } from './types'

/** Resolve the upstream API key for a provider based on the client's auth token. */
export function getProviderApiKey(
  provider: Provider,
  authToken: string,
  env: Env
): string | undefined {
  if (provider === 'anthropic') {
    // OAuth tokens (sk-ant-oat-*) use the dedicated OAuth secret
    if (authToken.startsWith('sk-ant-oat')) {
      return env.CLAUDE_CODE_OAUTH_TOKEN
    }
    return env.ANTHROPIC_API_KEY
  }
  return env.OPENAI_API_KEY
}
