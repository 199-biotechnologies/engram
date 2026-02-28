import { describe, it, expect } from "vitest";
import { calculateRetention, calculateSalience, adjustScore } from "../../src/retrieval/hybrid.js";
import type { Memory } from "../../src/storage/database.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "test-id",
    content: "Test memory",
    source: "test",
    timestamp: new Date(),
    event_time: null,
    importance: 0.5,
    access_count: 0,
    last_accessed: null,
    stability: 1.0,
    emotional_weight: 0.5,
    disabled: false,
    ...overrides,
  };
}

// ============ Retention ============

describe("calculateRetention", () => {
  it("returns ~1.0 for recently accessed memory", () => {
    const now = new Date();
    const memory = makeMemory({ last_accessed: now });
    const retention = calculateRetention(memory, now);
    expect(retention).toBeCloseTo(1.0, 1);
  });

  it("decays over time", () => {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const memory = makeMemory({ last_accessed: sevenDaysAgo, stability: 1.0 });

    const retention = calculateRetention(memory, now);
    // With stability=1.0 and halfLife=7 days, after 7 days retention should be ~0.5
    expect(retention).toBeCloseTo(0.5, 1);
    expect(retention).toBeLessThan(1.0);
  });

  it("higher stability = slower decay", () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const lowStability = makeMemory({ last_accessed: thirtyDaysAgo, stability: 1.0 });
    const highStability = makeMemory({ last_accessed: thirtyDaysAgo, stability: 5.0 });

    const retLow = calculateRetention(lowStability, now);
    const retHigh = calculateRetention(highStability, now);

    expect(retHigh).toBeGreaterThan(retLow);
  });

  it("is clamped between 0 and 1", () => {
    const now = new Date();
    const longAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const memory = makeMemory({ last_accessed: longAgo, stability: 0.1 });

    const retention = calculateRetention(memory, now);
    expect(retention).toBeGreaterThanOrEqual(0);
    expect(retention).toBeLessThanOrEqual(1);
  });

  it("uses timestamp when last_accessed is null", () => {
    const now = new Date();
    const memory = makeMemory({
      timestamp: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      last_accessed: null,
    });

    const retention = calculateRetention(memory, now);
    expect(retention).toBeLessThan(1.0);
    expect(retention).toBeGreaterThan(0);
  });
});

// ============ Salience ============

describe("calculateSalience", () => {
  it("returns higher value for important memories", () => {
    const important = makeMemory({ importance: 0.9, emotional_weight: 0.5 });
    const trivial = makeMemory({ importance: 0.1, emotional_weight: 0.5 });

    expect(calculateSalience(important)).toBeGreaterThan(calculateSalience(trivial));
  });

  it("includes emotional weight", () => {
    const emotional = makeMemory({ importance: 0.5, emotional_weight: 0.9 });
    const neutral = makeMemory({ importance: 0.5, emotional_weight: 0.1 });

    expect(calculateSalience(emotional)).toBeGreaterThan(calculateSalience(neutral));
  });

  it("gives access bonus for frequently accessed memories", () => {
    const accessed = makeMemory({ access_count: 20 });
    const fresh = makeMemory({ access_count: 0 });

    expect(calculateSalience(accessed)).toBeGreaterThan(calculateSalience(fresh));
  });

  it("returns value between 0 and 1", () => {
    const maxMemory = makeMemory({ importance: 1.0, emotional_weight: 1.0, access_count: 100 });
    const minMemory = makeMemory({ importance: 0, emotional_weight: 0, access_count: 0 });

    expect(calculateSalience(maxMemory)).toBeLessThanOrEqual(1);
    expect(calculateSalience(minMemory)).toBeGreaterThanOrEqual(0);
  });
});

// ============ adjustScore ============

describe("adjustScore", () => {
  it("combines base score with retention and salience", () => {
    const now = new Date();
    const memory = makeMemory({
      last_accessed: now,
      importance: 0.8,
      emotional_weight: 0.7,
    });

    const { adjusted, retention } = adjustScore(memory, 1.0, now);
    expect(adjusted).toBeGreaterThan(0);
    expect(adjusted).toBeLessThanOrEqual(1.0);
    expect(retention).toBeCloseTo(1.0, 1);
  });

  it("returns lower adjusted score for old, unimportant memories", () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const fresh = makeMemory({
      last_accessed: now,
      importance: 0.9,
    });
    const old = makeMemory({
      last_accessed: thirtyDaysAgo,
      importance: 0.1,
      stability: 0.5,
    });

    const freshResult = adjustScore(fresh, 1.0, now);
    const oldResult = adjustScore(old, 1.0, now);

    expect(freshResult.adjusted).toBeGreaterThan(oldResult.adjusted);
  });

  it("preserves relative ordering at same age", () => {
    const now = new Date();
    const memory = makeMemory({ last_accessed: now });

    const highBase = adjustScore(memory, 0.9, now);
    const lowBase = adjustScore(memory, 0.3, now);

    expect(highBase.adjusted).toBeGreaterThan(lowBase.adjusted);
  });
});
