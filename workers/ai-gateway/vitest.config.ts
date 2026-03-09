import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: {
          configPath: "./wrangler.jsonc.example",
        },
        miniflare: {
          kvNamespaces: ["AUTH_KV"],
          bindings: {
            LOG_LEVEL: "debug",
            ADMIN_AUTH_TOKEN: "test-admin-token",
            LLEMTRY_ENABLED: "false",
            LLEMTRY_ENDPOINT: "https://example.com/llemtry",
            LLEMTRY_AUTH_TOKEN: "test-llemtry-token",
          },
        },
      },
    },
  },
});
