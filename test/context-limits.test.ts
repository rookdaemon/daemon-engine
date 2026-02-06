import { describe, it, expect } from "vitest";
import {
  MODEL_LIMITS,
  DEFAULT_COMPACTION_THRESHOLD,
  getContextLimit,
  getCompactionThreshold,
  shouldCompact,
  isNearLimit,
} from "../src/context-limits.js";

describe("MODEL_LIMITS", () => {
  it("defines limits for known models", () => {
    expect(MODEL_LIMITS["claude-3-5-sonnet-20241022"]).toBe(200000);
    expect(MODEL_LIMITS["claude-3-opus-20240229"]).toBe(200000);
    expect(MODEL_LIMITS["claude-3-haiku-20240307"]).toBe(200000);
  });

  it("defines aliases for common model names", () => {
    expect(MODEL_LIMITS.sonnet).toBe(200000);
    expect(MODEL_LIMITS.opus).toBe(200000);
    expect(MODEL_LIMITS.haiku).toBe(200000);
  });

  it("has default fallback", () => {
    expect(MODEL_LIMITS.default).toBe(200000);
  });
});

describe("DEFAULT_COMPACTION_THRESHOLD", () => {
  it("is set to 0.75", () => {
    expect(DEFAULT_COMPACTION_THRESHOLD).toBe(0.75);
  });
});

describe("getContextLimit", () => {
  it("returns correct limit for known models", () => {
    expect(getContextLimit("sonnet")).toBe(200000);
    expect(getContextLimit("opus")).toBe(200000);
    expect(getContextLimit("haiku")).toBe(200000);
  });

  it("returns correct limit for full model identifiers", () => {
    expect(getContextLimit("claude-3-5-sonnet-20241022")).toBe(200000);
    expect(getContextLimit("claude-3-opus-20240229")).toBe(200000);
  });

  it("returns default for unknown models", () => {
    expect(getContextLimit("unknown-model")).toBe(200000);
    expect(getContextLimit("gpt-4")).toBe(200000);
  });
});

describe("getCompactionThreshold", () => {
  it("returns 75% of context limit by default", () => {
    const threshold = getCompactionThreshold("sonnet");
    expect(threshold).toBe(150000); // 200000 * 0.75
  });

  it("supports custom threshold fractions", () => {
    const threshold50 = getCompactionThreshold("sonnet", 0.5);
    expect(threshold50).toBe(100000); // 200000 * 0.5

    const threshold90 = getCompactionThreshold("sonnet", 0.9);
    expect(threshold90).toBe(180000); // 200000 * 0.9
  });

  it("floors the result to avoid partial tokens", () => {
    const threshold = getCompactionThreshold("sonnet", 0.333);
    expect(threshold).toBe(66600); // floor(200000 * 0.333)
  });

  it("works with unknown models using default limit", () => {
    const threshold = getCompactionThreshold("unknown-model");
    expect(threshold).toBe(150000);
  });
});

describe("shouldCompact", () => {
  it("returns true when at or above threshold", () => {
    expect(shouldCompact(150000, "sonnet")).toBe(true);
    expect(shouldCompact(150001, "sonnet")).toBe(true);
    expect(shouldCompact(200000, "sonnet")).toBe(true);
  });

  it("returns false when below threshold", () => {
    expect(shouldCompact(149999, "sonnet")).toBe(false);
    expect(shouldCompact(100000, "sonnet")).toBe(false);
    expect(shouldCompact(0, "sonnet")).toBe(false);
  });

  it("supports custom threshold", () => {
    // 90% threshold = 180000
    expect(shouldCompact(180000, "sonnet", 0.9)).toBe(true);
    expect(shouldCompact(179999, "sonnet", 0.9)).toBe(false);
  });

  it("works with different models", () => {
    expect(shouldCompact(150000, "opus")).toBe(true);
    expect(shouldCompact(150000, "haiku")).toBe(true);
    expect(shouldCompact(150000, "unknown-model")).toBe(true);
  });
});

describe("isNearLimit", () => {
  it("returns true when at or above 95% of limit", () => {
    // 95% of 200000 = 190000
    expect(isNearLimit(190000, "sonnet")).toBe(true);
    expect(isNearLimit(190001, "sonnet")).toBe(true);
    expect(isNearLimit(200000, "sonnet")).toBe(true);
  });

  it("returns false when below 95% of limit", () => {
    expect(isNearLimit(189999, "sonnet")).toBe(false);
    expect(isNearLimit(150000, "sonnet")).toBe(false);
    expect(isNearLimit(0, "sonnet")).toBe(false);
  });

  it("works with different models", () => {
    expect(isNearLimit(190000, "opus")).toBe(true);
    expect(isNearLimit(189999, "opus")).toBe(false);
  });

  it("works with unknown models using default limit", () => {
    expect(isNearLimit(190000, "unknown-model")).toBe(true);
    expect(isNearLimit(189999, "unknown-model")).toBe(false);
  });
});
