import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Handlebars from "handlebars";
import * as yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const templateSrc = readFileSync(join(ROOT, "docker-compose.yml.hbs"), "utf-8");
const template = Handlebars.compile(templateSrc, { noEscape: true });

function render(overrides = {}) {
  const defaults = {
    stack: {
      project_name: "test-stack",
      install_dir: "/home/openclaw",
      cloudflare: { tunnel_token: "cf-token" },
      ...overrides.stack,
    },
    claws: overrides.claws ?? {
      main: {
        gateway_port: 18789,
        dashboard_port: 6090,
        gateway_token: "gw-tok",
        domain: "example.com",
        domain_path: "",
        dashboard_path: "/dash",
        allowed_origin: "https://example.com",
        allow_updates: false,
        anthropic_api_key: "ak",
        anthropic_base_url: "https://gw/anthropic",
        openai_api_key: "ok",
        openai_base_url: "https://gw/openai/v1",
        openai_codex_base_url: "https://gw/openai-codex",
        telegram: { bot_token: "bot:tok", allow_from: "123" },
        vps_hostname: "vps1",
        log_worker_url: "",
        log_worker_token: "",
        events_url: "",
        llemtry_url: "",
        enable_events_logging: false,
        enable_llemtry_logging: false,
        resources: { cpus: "4", memory: "8G" },
        mdns_hostname: "main",
      },
    },
  };
  const rendered = template(defaults);
  return { rendered, parsed: yaml.load(rendered) };
}

describe("docker-compose.yml.hbs", () => {
  it("renders valid YAML", () => {
    const { parsed } = render();
    expect(parsed).toBeDefined();
    expect(parsed.services).toBeDefined();
  });

  it("generates correct service name for single claw", () => {
    const { parsed } = render();
    expect(parsed.services["test-stack-openclaw-main"]).toBeDefined();
  });

  it("binds ports to 127.0.0.1", () => {
    const { rendered } = render();
    expect(rendered).toContain("127.0.0.1:18789:18789");
    expect(rendered).toContain("127.0.0.1:6090:6090");
  });

  it("sets environment variables", () => {
    const { rendered } = render();
    expect(rendered).toContain("OPENCLAW_GATEWAY_PORT=18789");
    expect(rendered).toContain("NODE_ENV=production");
  });

  it("always outputs TELEGRAM_BOT_TOKEN", () => {
    const { rendered } = render();
    expect(rendered).toContain("TELEGRAM_BOT_TOKEN=bot:tok");
    expect(rendered).toContain("ADMIN_TELEGRAM_ID=123");
  });

  it("generates multiple claw services", () => {
    const claws = {
      main: {
        gateway_port: 18789, dashboard_port: 6090, gateway_token: "t1",
        domain: "a.com", domain_path: "", dashboard_path: "/d1",
        allowed_origin: "https://a.com", allow_updates: false,
        anthropic_api_key: "ak", anthropic_base_url: "u",
        openai_api_key: "ok", openai_base_url: "u", openai_codex_base_url: "u",
        telegram: { bot_token: "", allow_from: "" },
        vps_hostname: "", log_worker_url: "", log_worker_token: "",
        events_url: "", llemtry_url: "",
        enable_events_logging: false, enable_llemtry_logging: false,
        resources: { cpus: "4", memory: "8G" },
      },
      secondary: {
        gateway_port: 18790, dashboard_port: 6091, gateway_token: "t2",
        domain: "b.com", domain_path: "", dashboard_path: "/d2",
        allowed_origin: "https://b.com", allow_updates: false,
        anthropic_api_key: "ak", anthropic_base_url: "u",
        openai_api_key: "ok", openai_base_url: "u", openai_codex_base_url: "u",
        telegram: { bot_token: "", allow_from: "" },
        vps_hostname: "", log_worker_url: "", log_worker_token: "",
        events_url: "", llemtry_url: "",
        enable_events_logging: false, enable_llemtry_logging: false,
        resources: { cpus: "2", memory: "4G" },
      },
    };
    const { parsed } = render({ claws });
    expect(parsed.services["test-stack-openclaw-main"]).toBeDefined();
    expect(parsed.services["test-stack-openclaw-secondary"]).toBeDefined();
  });

  it("includes cloudflared service", () => {
    const { parsed } = render();
    expect(parsed.services["cloudflared"]).toBeDefined();
  });

  it("conditionally includes vector service", () => {
    const { parsed: without } = render();
    expect(without.services["vector"]).toBeUndefined();

    const { parsed: withVector } = render({
      stack: {
        vector: true,
        logging: { worker_url: "https://log.example.com", worker_token: "lt" },
      },
    });
    expect(withVector.services["vector"]).toBeDefined();
  });

  it("conditionally includes egress-proxy service", () => {
    const { parsed: without } = render();
    expect(without.services["egress-proxy"]).toBeUndefined();

    const { parsed: withProxy } = render({
      stack: {
        egress_proxy: { port: 8080, auth_token: "at", log_level: "info" },
      },
    });
    expect(withProxy.services["egress-proxy"]).toBeDefined();
  });

  it("conditionally includes sandbox-registry service", () => {
    const { parsed: without } = render();
    expect(without.services["sandbox-registry"]).toBeUndefined();

    const { parsed: withReg } = render({
      stack: {
        sandbox_registry_container: true,
        sandbox_registry: { port: 5000, token: "sr-tok", log_level: "warn" },
      },
    });
    expect(withReg.services["sandbox-registry"]).toBeDefined();
  });

  it("sets resource limits from claw config", () => {
    const { rendered } = render();
    expect(rendered).toContain('cpus: "4"');
    expect(rendered).toContain('memory: "8G"');
  });

  it("sets healthcheck with correct port", () => {
    const { rendered } = render();
    expect(rendered).toContain("http://localhost:18789/");
  });

  it("includes openclaw-net network", () => {
    const { parsed } = render();
    expect(parsed.networks["openclaw-net"]).toBeDefined();
  });
});
