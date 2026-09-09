import { describe, expect, it } from "vitest";
import { enUS, type MessageKey, zhCN } from "./resources";

describe("locale contracts", () => {
  it("has matching keys and interpolation parameters in both languages", () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(zhCN).sort());
    for (const key of Object.keys(zhCN) as MessageKey[]) {
      expect(enUS[key].trim().length).toBeGreaterThan(0);
      const parameters = (text: string) =>
        [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
      expect(parameters(enUS[key]), key).toEqual(parameters(zhCN[key]));
    }
  });
});
