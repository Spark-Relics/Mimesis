import { AppError } from "@clawler/contracts";

/**
 * Restricted expression evaluator for computed extraction fields.
 *
 * No `eval`, no `new Function`, no property access, no loops. The grammar is a
 * small Pratt-parsed expression language over string/number/boolean literals,
 * other fields of the same record (`{name}`), whitelisted functions and a fixed
 * operator set. Input length and AST node count are capped so evaluation cost is
 * bounded before it starts.
 */

const MAX_SOURCE_LENGTH = 1000;
const MAX_NODES = 200;

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "field"; name: string }
  | { type: "ident"; name: string }
  | { type: "op"; value: string };

const OPERATORS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "&&",
  "||",
  "!",
  "(",
  ")",
  ",",
]);

const FUNCTIONS: Record<string, (args: ExpressionValue[]) => ExpressionValue> = {
  upper: (args) => toText(args[0]).toUpperCase(),
  lower: (args) => toText(args[0]).toLowerCase(),
  trim: (args) => toText(args[0]).trim(),
  length: (args) => toText(args[0]).length,
  replace: (args) => toText(args[0]).split(toText(args[1])).join(toText(args[2])),
  substring: (args) => {
    const raw = toText(args[0]);
    const from = Number(args[1]) || 0;
    if (args.length > 2) return raw.slice(from, Number(args[2]) || 0);
    return raw.slice(from);
  },
  concat: (args) => args.map((arg) => toText(arg)).join(""),
  number: (args) => {
    const parsed = Number(toText(args[0]).replace(/[^0-9.-]/g, ""));
    if (Number.isNaN(parsed)) return 0;
    return parsed;
  },
  round: (args) => {
    let digits = 0;
    if (args.length > 1) digits = Number(args[1]) || 0;
    const factor = 10 ** digits;
    return Math.round((Number(args[0]) || 0) * factor) / factor;
  },
};

type ExpressionValue = string | number | boolean;

type Node =
  | { kind: "literal"; value: ExpressionValue }
  | { kind: "field"; name: string }
  | { kind: "unary"; operator: string; operand: Node }
  | { kind: "binary"; operator: string; left: Node; right: Node }
  | { kind: "call"; name: string; args: Node[] };

function toText(value: ExpressionValue | undefined): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") {
    if (value) return "true";
    return "false";
  }
  return "";
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let position = 0;
  while (position < source.length) {
    const character = source[position];
    if (!character) throw new AppError("INVALID_INPUT");
    if (/\s/u.test(character)) {
      position++;
      continue;
    }
    if (character === "{") {
      const end = source.indexOf("}", position);
      if (end === -1) throw new AppError("INVALID_INPUT");
      const name = source.slice(position + 1, end);
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(name)) throw new AppError("INVALID_INPUT");
      tokens.push({ type: "field", name });
      position = end + 1;
      continue;
    }
    if (character === '"' || character === "'") {
      let value = "";
      position++;
      while (position < source.length && source[position] !== character) {
        const current = source[position];
        if (!current) throw new AppError("INVALID_INPUT");
        if (current === "\\") {
          position++;
          const escaped = source[position];
          if (!escaped) throw new AppError("INVALID_INPUT");
          value += escaped;
          position++;
          continue;
        }
        value += current;
        position++;
      }
      if (position >= source.length) throw new AppError("INVALID_INPUT");
      tokens.push({ type: "string", value });
      position++;
      continue;
    }
    if (/[0-9]/u.test(character)) {
      let digits = "";
      while (position < source.length) {
        const digit = source[position];
        if (!digit || !/[0-9.]/u.test(digit)) break;
        digits += digit;
        position++;
      }
      const value = Number(digits);
      if (Number.isNaN(value)) throw new AppError("INVALID_INPUT");
      tokens.push({ type: "number", value });
      continue;
    }
    if (/[a-zA-Z_]/u.test(character)) {
      let name = "";
      while (position < source.length) {
        const letter = source[position];
        if (!letter || !/[a-zA-Z0-9_]/u.test(letter)) break;
        name += letter;
        position++;
      }
      tokens.push({ type: "ident", name });
      continue;
    }
    const two = source.slice(position, position + 2);
    if (OPERATORS.has(two)) {
      tokens.push({ type: "op", value: two });
      position += 2;
      continue;
    }
    if (OPERATORS.has(character)) {
      tokens.push({ type: "op", value: character });
      position++;
      continue;
    }
    throw new AppError("INVALID_INPUT");
  }
  return tokens;
}

const BINARY_PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

function parseExpression(tokens: Token[]): Node {
  let cursor = 0;
  let nodes = 0;
  function peek(): Token | undefined {
    return tokens[cursor];
  }
  function consume(): Token {
    const token = tokens[cursor];
    if (!token) throw new AppError("INVALID_INPUT");
    cursor++;
    return token;
  }
  function isOperator(value: string): boolean {
    const token = peek();
    return token?.type === "op" && token.value === value;
  }
  function parsePrimary(): Node {
    nodes++;
    if (nodes > MAX_NODES) throw new AppError("INVALID_INPUT");
    const token = consume();
    if (token.type === "number") return { kind: "literal", value: token.value };
    if (token.type === "string") return { kind: "literal", value: token.value };
    if (token.type === "field") return { kind: "field", name: token.name };
    if (token.type === "ident") {
      if (!(token.name in FUNCTIONS)) throw new AppError("INVALID_INPUT");
      const opening = consume();
      if (opening.type !== "op" || opening.value !== "(") throw new AppError("INVALID_INPUT");
      const args: Node[] = [];
      if (isOperator(")")) {
        consume();
        return { kind: "call", name: token.name, args };
      }
      args.push(parseBinary(0));
      while (isOperator(",")) {
        consume();
        args.push(parseBinary(0));
      }
      const closing = consume();
      if (closing.type !== "op" || closing.value !== ")") throw new AppError("INVALID_INPUT");
      if (args.length > 8) throw new AppError("INVALID_INPUT");
      return { kind: "call", name: token.name, args };
    }
    if (token.type === "op" && token.value === "(") {
      const inner = parseBinary(0);
      const closing = consume();
      if (closing.type !== "op" || closing.value !== ")") throw new AppError("INVALID_INPUT");
      return inner;
    }
    if (token.type === "op" && token.value === "-") {
      return { kind: "unary", operator: "-", operand: parsePrimary() };
    }
    throw new AppError("INVALID_INPUT");
  }
  function parseUnary(): Node {
    nodes++;
    if (nodes > MAX_NODES) throw new AppError("INVALID_INPUT");
    const token = tokens[cursor];
    if (token?.type === "op" && token.value === "!") {
      consume();
      return { kind: "unary", operator: "!", operand: parseUnary() };
    }
    return parsePrimary();
  }
  function parseBinary(minimum: number): Node {
    let left = parseUnary();
    while (true) {
      const token = tokens[cursor];
      if (token?.type !== "op") break;
      const precedence = BINARY_PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minimum) break;
      consume();
      const right = parseBinary(precedence + 1);
      left = { kind: "binary", operator: token.value, left, right };
      nodes++;
      if (nodes > MAX_NODES) throw new AppError("INVALID_INPUT");
    }
    return left;
  }
  const root = parseBinary(0);
  if (cursor !== tokens.length) throw new AppError("INVALID_INPUT");
  return root;
}

function evaluate(node: Node, record: Record<string, string>): ExpressionValue {
  if (node.kind === "literal") return node.value;
  if (node.kind === "field") {
    const value = record[node.name];
    if (typeof value !== "string") throw new AppError("INVALID_INPUT");
    return value;
  }
  if (node.kind === "unary") {
    const operand = evaluate(node.operand, record);
    if (node.operator === "!") return !toBoolean(operand);
    return -toNumber(operand);
  }
  if (node.kind === "binary") {
    const operator = node.operator;
    if (operator === "&&")
      return toBoolean(evaluate(node.left, record)) && toBoolean(evaluate(node.right, record));
    if (operator === "||")
      return toBoolean(evaluate(node.left, record)) || toBoolean(evaluate(node.right, record));
    const left = evaluate(node.left, record);
    const right = evaluate(node.right, record);
    if (operator === "+") {
      if (typeof left === "string" || typeof right === "string") {
        return toText(left) + toText(right);
      }
      return toNumber(left) + toNumber(right);
    }
    if (operator === "-") return toNumber(left) - toNumber(right);
    if (operator === "*") return toNumber(left) * toNumber(right);
    if (operator === "/") return toNumber(left) / toNumber(right);
    if (operator === "%") return toNumber(left) % toNumber(right);
    if (operator === "==") return toText(left) === toText(right);
    if (operator === "!=") return toText(left) !== toText(right);
    if (operator === "<") return toNumber(left) < toNumber(right);
    if (operator === "<=") return toNumber(left) <= toNumber(right);
    if (operator === ">") return toNumber(left) > toNumber(right);
    if (operator === ">=") return toNumber(left) >= toNumber(right);
  }
  if (node.kind !== "call") throw new AppError("INVALID_INPUT");
  const fn = FUNCTIONS[node.name];
  if (!fn) throw new AppError("INVALID_INPUT");
  return fn(node.args.map((argument) => evaluate(argument, record)));
}

function toBoolean(value: ExpressionValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 0;
  return value !== 0;
}

function toNumber(value: ExpressionValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") {
    if (value) return 1;
    return 0;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return 0;
  return parsed;
}

const parsedCache = new Map<string, Node>();

/** Parses (with a small cache) and evaluates a restricted expression against one record. */
export function evaluateExpression(source: string, record: Record<string, string>): string {
  if (source.length > MAX_SOURCE_LENGTH) throw new AppError("INVALID_INPUT");
  let root = parsedCache.get(source);
  if (!root) {
    root = parseExpression(tokenize(source));
    if (parsedCache.size > 500) parsedCache.clear();
    parsedCache.set(source, root);
  }
  return toText(evaluate(root, record));
}
