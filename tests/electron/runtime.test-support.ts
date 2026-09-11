import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export function readRuntime(root: string, sql: string, ...values: SQLInputValue[]) {
  const db = new DatabaseSync(join(root, "runtime", "runtime.sqlite"), { readOnly: true });
  try {
    return db.prepare(sql).all(...values);
  } finally {
    db.close();
  }
}
