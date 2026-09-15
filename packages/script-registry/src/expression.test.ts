import { describe, expect, it } from "vitest";
import { evaluateExpression } from "./expression.js";

describe("restricted expression evaluator", () => {
  it("computes arithmetic and string concatenation over sibling fields", () => {
    expect(evaluateExpression("upper({name})", { name: "cedar" })).toBe("CEDAR");
    expect(evaluateExpression("round(number({price}) * 1.1, 2)", { price: "18.00" })).toBe("19.8");
    expect(evaluateExpression('concat({a}, "-", {b})', { a: "x", b: "y" })).toBe("x-y");
    expect(evaluateExpression("trim({name})", { name: "  padded  " })).toBe("padded");
    expect(evaluateExpression("length({name})", { name: "abc" })).toBe("3");
    expect(evaluateExpression('replace({sku}, "A", "B")', { sku: "A1" })).toBe("B1");
    expect(evaluateExpression("substring({sku}, 0, 1)", { sku: "A1" })).toBe("A");
  });

  it("supports comparison and logic operators with precedence", () => {
    expect(
      evaluateExpression("number({price}) > 10 && number({stock}) < 5", {
        price: "18",
        stock: "3",
      }),
    ).toBe("true");
    expect(evaluateExpression('!({price} == "")', { price: "18" })).toBe("true");
    expect(evaluateExpression("1 + 2 * 3", {})).toBe("7");
    expect(evaluateExpression("(1 + 2) * 3", {})).toBe("9");
    expect(evaluateExpression("-number({n})", { n: "4" })).toBe("-4");
  });

  it("rejects unknown functions, property access and malformed sources", () => {
    expect(() => evaluateExpression("eval({name})", { name: "x" })).toThrow();
    expect(() => evaluateExpression("{name}.length", { name: "x" })).toThrow();
    expect(() => evaluateExpression("constructor", {})).toThrow();
    expect(() => evaluateExpression("upper({name}", { name: "x" })).toThrow();
    expect(() => evaluateExpression("upper(1,2,3,4,5,6,7,8,9)", {})).toThrow();
    expect(() => evaluateExpression("{missing}", {})).toThrow();
    expect(() => evaluateExpression(`${"1 + ".repeat(120)}1`, {})).toThrow();
  });
});
