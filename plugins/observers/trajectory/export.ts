import "dotenv/config";

import { createWriteStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { toSamples, trajectoryDir, type TrajectoryRecord } from "./trajectory";

// Usage: npx tsx plugins/observers/trajectory/export.ts [--dir <trajectories>] [--out <file.jsonl>]
const { values } = parseArgs({ options: { dir: { type: "string" }, out: { type: "string" } } });
const dir = values.dir ?? trajectoryDir(process.env);

// Nothing recorded yet is an empty export, not an error.
const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
const files = names.filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
const records: TrajectoryRecord[] = [];
let malformed = 0;
for (const name of files) {
  for (const line of (await readFile(join(dir, name), "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as TrajectoryRecord);
    } catch {
      malformed++;
    }
  }
}

const { samples, stats } = toSamples(records);
const out = values.out ? createWriteStream(values.out, { mode: 0o600 }) : process.stdout;
for (const sample of samples) out.write(`${JSON.stringify(sample)}\n`);
if (out !== process.stdout) out.end();
console.error(
  `${files.length} file(s), ${stats.turns} turn(s): ${stats.samples} sample(s); ` +
    `${stats.skipped} failed/canceled turn(s) dropped, ${stats.duplicates} duplicate(s), ${malformed} malformed line(s)`,
);
