// Secrets not in wrangler.jsonc vars — merge into the generated Env interface
declare namespace Cloudflare {
  interface Env {
    AUTH_TOKEN: string
  }
}
