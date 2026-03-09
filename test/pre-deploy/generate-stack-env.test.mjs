import { describe, it, expect } from "vitest";
import { generateStackEnv } from "../../build/pre-deploy-lib.mjs";

describe("generateStackEnv", () => {
  const env = {
    VPS_IP: "10.0.0.1",
    SSH_KEY: "/home/user/.ssh/id_ed25519",
    SSH_PORT: "222",
    SSH_USER: "adminclaw",
  };

  const config = {
    stack: {
      install_dir: "/home/openclaw",
      project_name: "openclaw-stack",
      logging: { vector: true },
      openclaw: { version: "stable" },
    },
    host: {
      hostname: "vps1",
      host_alerter: { daily_report: "9:30 AM PST" },
    },
  };

  const claws = {
    main: {
      domain: "example.com",
      dashboard_path: "/dash",
      gateway_port: 18789,
      dashboard_port: 6090,
    },
  };

  it("includes ENV__ vars from .env", () => {
    const result = generateStackEnv(env, config, claws);
    expect(result).toContain("ENV__VPS_IP=10.0.0.1");
    expect(result).toContain("ENV__SSH_PORT=222");
  });

  it("includes stack config", () => {
    const result = generateStackEnv(env, config, claws);
    expect(result).toContain("STACK__STACK__INSTALL_DIR=/home/openclaw");
    expect(result).toContain("STACK__STACK__PROJECT_NAME=openclaw-stack");
  });

  it("includes derived values", () => {
    const result = generateStackEnv(env, config, claws);
    expect(result).toContain("STACK__STACK__IMAGE=openclaw-openclaw-stack:local");
    expect(result).toContain("STACK__STACK__INSTANCES_DIR=/home/openclaw/instances");
    expect(result).toContain("STACK__CLAWS__IDS=main");
  });

  it("includes per-claw values", () => {
    const result = generateStackEnv(env, config, claws);
    expect(result).toContain("STACK__CLAWS__MAIN__DOMAIN=example.com");
    expect(result).toContain("STACK__CLAWS__MAIN__GATEWAY_PORT=18789");
  });

  it("includes host alerter schedule", () => {
    const result = generateStackEnv(env, config, claws);
    expect(result).toContain("STACK__HOST__HOSTALERT__CRON_EXPR=");
    expect(result).toContain("STACK__HOST__HOSTALERT__CRON_TZ=");
  });

  it("handles multiple claws", () => {
    const multiClaws = {
      main: { ...claws.main },
      secondary: { domain: "s.com", gateway_port: 18790, dashboard_port: 6091 },
    };
    const result = generateStackEnv(env, config, multiClaws);
    expect(result).toContain("STACK__CLAWS__IDS=main,secondary");
    expect(result).toContain("STACK__CLAWS__SECONDARY__DOMAIN=s.com");
  });

  it("includes openclaw version when set", () => {
    const result = generateStackEnv(env, config, claws);
    expect(result).toContain("STACK__STACK__OPENCLAW__VERSION=stable");
  });

  it("includes logging vector flag", () => {
    const result = generateStackEnv(env, config, claws);
    expect(result).toContain("STACK__STACK__LOGGING__VECTOR=true");
  });
});
