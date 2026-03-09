import { describe, it, expect, vi } from "vitest";
import { validateClaw } from "../../build/pre-deploy-lib.mjs";

describe("validateClaw", () => {
  const validClaw = {
    domain: "example.com",
    gateway_port: 18789,
    dashboard_port: 6090,
    telegram: { bot_token: "123:abc" },
  };

  it("accepts a valid claw", () => {
    expect(() => validateClaw("main", validClaw, () => {})).not.toThrow();
  });

  it("throws on missing domain", () => {
    const claw = { ...validClaw, domain: undefined };
    expect(() => validateClaw("main", claw, () => {})).toThrow("missing required field: domain");
  });

  it("throws on missing gateway_port", () => {
    const claw = { ...validClaw, gateway_port: undefined };
    expect(() => validateClaw("main", claw, () => {})).toThrow("missing required field: gateway_port");
  });

  it("throws on missing dashboard_port", () => {
    const claw = { ...validClaw, dashboard_port: undefined };
    expect(() => validateClaw("main", claw, () => {})).toThrow("missing required field: dashboard_port");
  });

  it("throws on empty string domain", () => {
    const claw = { ...validClaw, domain: "" };
    expect(() => validateClaw("main", claw, () => {})).toThrow("missing required field: domain");
  });

  it("warns when telegram.bot_token is missing", () => {
    const onWarn = vi.fn();
    const claw = { ...validClaw, telegram: {} };
    validateClaw("main", claw, onWarn);
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("telegram.bot_token")
    );
  });

  it("warns when telegram section is missing entirely", () => {
    const onWarn = vi.fn();
    const claw = { domain: "ex.com", gateway_port: 1, dashboard_port: 2 };
    validateClaw("main", claw, onWarn);
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("telegram.bot_token")
    );
  });

  it("does not warn when telegram.bot_token is present", () => {
    const onWarn = vi.fn();
    validateClaw("main", validClaw, onWarn);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("includes claw name in error messages", () => {
    const claw = { ...validClaw, domain: undefined };
    expect(() => validateClaw("test-claw", claw, () => {})).toThrow("test-claw");
  });
});
