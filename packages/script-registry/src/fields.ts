import type { CollectionWorkflow, DetailTraversal, Extraction } from "@clawler/contracts";

export function fieldNames(extract: Extraction): string[] {
  return extract.fields.map((field) => field.name);
}

export function traversalNames(node: DetailTraversal): string[] {
  let nested: string[] = [];
  if (node.children) nested = traversalNames(node.children);
  let rows: string[] = [];
  if (node.rows) rows = fieldNames(node.rows);
  return [...fieldNames(node.extract), ...rows, ...nested];
}

/** All output field names of a workflow: list fields, then detail traversal fields. */
export function outputFieldNames(workflow: CollectionWorkflow): Set<string> {
  const names = new Set(fieldNames(workflow.extract));
  if (workflow.detail) for (const name of traversalNames(workflow.detail)) names.add(name);
  return names;
}

/**
 * Deduplication key of one record. Configured field names win when the record
 * carries at least one of them; otherwise the whole record is the key, which
 * keeps cross-extraction keys meaningful (a list row shares no fields with a
 * nested detail row).
 */
export function dedupeKey(
  record: Record<string, string | number | boolean>,
  fields: string[],
): string {
  if (!fields.length) return JSON.stringify(record);
  const values = fields.map((name) => [name, record[name]] as const);
  if (!values.some(([, value]) => value !== undefined)) return JSON.stringify(record);
  return JSON.stringify(values);
}
