import { describe, it, expect, vi } from "vitest";
import { parseDailyReportTime, TZ_ABBREVIATIONS } from "../../build/pre-deploy-lib.mjs";

describe("parseDailyReportTime", () => {
  it("parses '9:30 AM PST'", () => {
    const result = parseDailyReportTime("9:30 AM PST");
    expect(result.cronExpr).toBe("30 9 * * *");
    expect(result.ianaTz).toBe("America/Los_Angeles");
  });

  it("converts PM correctly", () => {
    const result = parseDailyReportTime("2:00 PM EST");
    expect(result.cronExpr).toBe("0 14 * * *");
    expect(result.ianaTz).toBe("America/New_York");
  });

  it("handles 12 AM (midnight)", () => {
    const result = parseDailyReportTime("12:00 AM UTC");
    expect(result.cronExpr).toBe("0 0 * * *");
  });

  it("handles 12 PM (noon)", () => {
    const result = parseDailyReportTime("12:00 PM UTC");
    expect(result.cronExpr).toBe("0 12 * * *");
  });

  it("returns fallback for null input", () => {
    const result = parseDailyReportTime(null);
    expect(result.cronExpr).toBe("30 9 * * *");
    expect(result.ianaTz).toBe("America/Los_Angeles");
  });

  it("returns fallback for unparseable input", () => {
    const onWarn = vi.fn();
    const result = parseDailyReportTime("garbage", onWarn);
    expect(result.cronExpr).toBe("30 9 * * *");
    expect(onWarn).toHaveBeenCalled();
  });

  it("warns on unknown timezone", () => {
    const onWarn = vi.fn();
    const result = parseDailyReportTime("9:30 AM XYZ", onWarn);
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("XYZ"));
    expect(result.ianaTz).toBe("America/Los_Angeles");
  });

  it("exports TZ_ABBREVIATIONS", () => {
    expect(TZ_ABBREVIATIONS.PST).toBe("America/Los_Angeles");
    expect(TZ_ABBREVIATIONS.EST).toBe("America/New_York");
    expect(TZ_ABBREVIATIONS.UTC).toBe("UTC");
  });
});
