import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { completedRun, execution, submission } from "./fixtures.test-support";
import { GatewayQueue } from "./queue";
import { FileGatewayRepository } from "./repository";
import { cleanResult, serializeResult } from "./results";

it("archives runs and cleaned exports under their instance without changing raw data", async () => {
  const root = await mkdtemp(join(tmpdir(), "mimesis-gateway-"));
  const repository = new FileGatewayRepository(root);
  const raw = completedRun();
  const queue = await GatewayQueue.open(repository, {
    resolve: () => execution,
    execute: async () => raw,
  });
  const { job } = await queue.submit(submission);
  queue.start();
  await vi.waitFor(() => expect(queue.get(job.id).status).toBe("succeeded"));
  const folder = join(root, "instances", execution.instance.id, "jobs", job.id);
  const result = JSON.parse(await readFile(join(folder, "result.json"), "utf8"));
  expect(result.title).toBe("Catalog");
  expect(result.headings).toEqual(["One"]);
  expect(raw.result?.title).toBe(" Catalog ");
  expect(await readFile(join(folder, "result.csv"), "utf8")).toContain('"\'=SUM(1,2)"');
  const rows = (await readFile(join(folder, "result.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.map((row) => row.kind)).toEqual(["document", "heading", "link"]);
  expect(JSON.parse(await readFile(join(folder, "job.json"), "utf8")).run.id).toBe(raw.id);
  await queue.close();
  expect((await repository.load())?.jobs[0]?.status).toBe("succeeded");
  await writeFile(join(root, "gateway.json"), "broken");
  await expect(repository.load()).rejects.toThrow("STORAGE_FAILED");
  expect(await readFile(join(root, "gateway.json"), "utf8")).toBe("broken");
});

it("handles quoted multilingual CSV, deduplication and disabled cleaning", () => {
  const input = {
    title: ' 中文,"标题"\nnext',
    url: "https://example.com/",
    headings: [" A ", "A"],
    links: [
      { text: "same", href: "/a" },
      { text: "same", href: "/a" },
      { text: "same", href: "/b" },
    ],
  };
  expect(cleanResult(input, { trim: false, deduplicate: false })).toEqual(input);
  const result = cleanResult(input, { trim: true, deduplicate: true });
  expect(result.headings).toEqual(["A"]);
  expect(result.links).toHaveLength(2);
  expect(serializeResult(result, "csv")).toContain('"中文,""标题""\nnext"');
});
