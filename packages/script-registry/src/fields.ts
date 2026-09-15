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

/** Reserved provenance field names contributed by `source`, in stable output order. */
export function sourceFieldNames(workflow: CollectionWorkflow): string[] {
  const source = workflow.source;
  if (!source) return [];
  const names: string[] = [];
  if (source.url) names.push("sourceUrl");
  if (source.page) names.push("sourcePage");
  if (source.origin) names.push("sourceOrigin");
  return names;
}

/** Ordered output field names: list fields, then detail traversal fields, then provenance. */
export function orderedFieldNames(workflow: CollectionWorkflow): string[] {
  const names = fieldNames(workflow.extract);
  if (workflow.detail) names.push(...traversalNames(workflow.detail));
  names.push(...sourceFieldNames(workflow));
  return names;
}

/** All output field names of a workflow: list fields, then detail traversal fields, then provenance. */
export function outputFieldNames(workflow: CollectionWorkflow): Set<string> {
  return new Set(orderedFieldNames(workflow));
}

/** Configured output renames keyed by source name; later duplicates win (validation rejects them). */
export function mappingTarget(workflow: CollectionWorkflow): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of workflow.mapping ?? []) map.set(entry.from, entry.to);
  return map;
}

/** Delivered output order: source output names with `mapping` renames applied in place. */
export function mappedOutputNames(workflow: CollectionWorkflow): string[] {
  const map = mappingTarget(workflow);
  return orderedFieldNames(workflow).map((name) => map.get(name) ?? name);
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
