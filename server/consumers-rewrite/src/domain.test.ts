import { describe, expect, it } from "vitest";

import { Offset } from "./domain.js";

describe("Offset comparisons", () => {
  // Zero-padded offsets like the storage produces
  const o0 = Offset.make("0000000000000000");
  const o1 = Offset.make("0000000000000001");
  const o2 = Offset.make("0000000000000002");
  const o10 = Offset.make("0000000000000010");
  const o100 = Offset.make("0000000000000100");

  describe("gt (greater than)", () => {
    it("returns true when a > b", () => {
      expect(Offset.gt(o1, o0)).toBe(true);
      expect(Offset.gt(o2, o1)).toBe(true);
      expect(Offset.gt(o10, o2)).toBe(true);
      expect(Offset.gt(o100, o10)).toBe(true);
    });

    it("returns false when a <= b", () => {
      expect(Offset.gt(o0, o1)).toBe(false);
      expect(Offset.gt(o1, o1)).toBe(false);
      expect(Offset.gt(o2, o10)).toBe(false);
    });
  });

  describe("gte (greater than or equal)", () => {
    it("returns true when a >= b", () => {
      expect(Offset.gte(o1, o0)).toBe(true);
      expect(Offset.gte(o1, o1)).toBe(true);
      expect(Offset.gte(o10, o2)).toBe(true);
    });

    it("returns false when a < b", () => {
      expect(Offset.gte(o0, o1)).toBe(false);
      expect(Offset.gte(o2, o10)).toBe(false);
    });
  });

  describe("lt (less than)", () => {
    it("returns true when a < b", () => {
      expect(Offset.lt(o0, o1)).toBe(true);
      expect(Offset.lt(o2, o10)).toBe(true);
    });

    it("returns false when a >= b", () => {
      expect(Offset.lt(o1, o0)).toBe(false);
      expect(Offset.lt(o1, o1)).toBe(false);
    });
  });

  describe("lte (less than or equal)", () => {
    it("returns true when a <= b", () => {
      expect(Offset.lte(o0, o1)).toBe(true);
      expect(Offset.lte(o1, o1)).toBe(true);
    });

    it("returns false when a > b", () => {
      expect(Offset.lte(o1, o0)).toBe(false);
      expect(Offset.lte(o10, o2)).toBe(false);
    });
  });

  describe("string comparison edge cases", () => {
    it("handles the initial offset -1", () => {
      const initial = Offset.make("-1");
      expect(Offset.gt(o0, initial)).toBe(true);
      expect(Offset.lt(initial, o0)).toBe(true);
    });

    it("compares correctly without leading zeros (should still work)", () => {
      // These shouldn't happen in practice, but let's verify behavior
      const a = Offset.make("9");
      const b = Offset.make("10");
      // String "9" > "10" because "9" > "1" lexically - this is why we zero-pad!
      expect(Offset.gt(a, b)).toBe(true); // This is "wrong" numerically but correct for strings
    });
  });
});
