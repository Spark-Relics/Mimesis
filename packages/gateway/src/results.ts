import { type DocumentSnapshot, documentSchema, type GatewaySubmission } from "@clawler/contracts";

export function cleanResult(
  input: DocumentSnapshot,
  options: GatewaySubmission["cleaning"],
): DocumentSnapshot {
  const result = documentSchema.parse(input);
  if (options.trim) {
    result.title = result.title.trim();
    result.headings = result.headings.map((heading) => heading.trim());
    result.links = result.links.map((link) => ({ text: link.text.trim(), href: link.href }));
  }
  if (options.deduplicate) {
    result.headings = [...new Set(result.headings)];
    const seen = new Set<string>();
    result.links = result.links.filter((link) => {
      const key = JSON.stringify([link.text, link.href]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return result;
}

export type ResultFormat = "json" | "csv" | "ndjson";
export const resultContentTypes: Record<ResultFormat, string> = {
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  ndjson: "application/x-ndjson; charset=utf-8",
};

function csvCell(value: string): string {
  // Website-controlled values must remain text when opened in a spreadsheet.
  let safe = value;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detect control-prefixed spreadsheet formulas from scraped text.
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(safe) || /^[\t\r\n]/u.test(safe)) safe = `'${safe}`;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** CSV/NDJSON use a stable row schema; JSON preserves the nested document. */
export function serializeResult(result: DocumentSnapshot, format: ResultFormat): string {
  if (format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  if (result.records) {
    if (format === "ndjson")
      return `${result.records.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const columns = [...new Set(result.records.flatMap((row) => Object.keys(row)))];
    return `${[columns.map(csvCell).join(","), ...result.records.map((row) => columns.map((key) => csvCell(row[key] ?? "")).join(","))].join("\r\n")}\r\n`;
  }
  const rows = [
    { kind: "document", text: result.title, url: result.url },
    ...result.headings.map((text) => ({ kind: "heading", text, url: result.url })),
    ...result.links.map((link) => ({ kind: "link", text: link.text, url: link.href })),
  ];
  if (format === "ndjson") return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  return `${["kind,text,url", ...rows.map((row) => [row.kind, row.text, row.url].map(csvCell).join(","))].join("\r\n")}\r\n`;
}
