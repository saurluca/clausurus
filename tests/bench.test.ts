import { describe, expect, test } from "bun:test";
import { sampleIndices } from "../bench/sample.js";
import { aggregate, scoreExample } from "../bench/score.js";

describe("sampleIndices", () => {
  test("same seed picks the same indexes", () => {
    expect(sampleIndices(1000, 10, 1)).toEqual(sampleIndices(1000, 10, 1));
  });

  test("a different seed picks a different sample", () => {
    expect(sampleIndices(1000, 10, 1)).not.toEqual(sampleIndices(1000, 10, 2));
  });

  test("indexes are unique and inside the split", () => {
    const idx = sampleIndices(50, 10, 7);
    expect(idx).toHaveLength(10);
    expect(new Set(idx).size).toBe(10);
    expect(idx.every((i) => i >= 0 && i < 50)).toBe(true);
  });
});

describe("score", () => {
  test("exact hit", () => {
    const s = scoreExample([{ start: 0, end: 5, label: "EMAIL" }], [{ start: 0, end: 5 }]);
    const agg = aggregate([s]);
    expect(agg.f1).toBe(1);
    expect(agg.coverage).toBe(1);
    expect(s.misses).toEqual([]);
  });

  test("partial overlap covers only the shared characters", () => {
    const s = scoreExample([{ start: 0, end: 10, label: "TEL" }], [{ start: 0, end: 4 }]);
    const agg = aggregate([s]);
    expect(agg.f1).toBe(1);
    expect(agg.coverage).toBe(0.4);
  });

  test("miss", () => {
    const s = scoreExample([{ start: 0, end: 4, label: "TIME" }], []);
    const agg = aggregate([s]);
    expect(agg.f1).toBe(0);
    expect(agg.coverage).toBe(0);
    expect(s.misses).toEqual(["TIME"]);
  });

  test("extra detection lowers precision", () => {
    const s = scoreExample([{ start: 0, end: 3, label: "EMAIL" }], [
      { start: 0, end: 3 },
      { start: 10, end: 12 },
    ]);
    const agg = aggregate([s]);
    expect(agg.coverage).toBe(1);
    expect(agg.f1).toBeCloseTo(2 / 3, 5);
  });
});
