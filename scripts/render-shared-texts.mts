#!/usr/bin/env node
// Renders the shared templates (agent/prompts/runtime/shared.md) into agent/src/lib/shared_texts.gen.ts.
//
// Those sentences are used by agent library files that the web page also imports (agent/src/lib/stage.ts, for one).
// The page cannot read files, so it takes the templates from the generated module; the agent reads the same file
// through agent/src/lib/texts.ts. The guard test (agent/tests/texts_guard.test.ts) checks that the two agree.
//
// Usage:
//   node scripts/render-shared-texts.mts           rewrite agent/src/lib/shared_texts.gen.ts
//   node scripts/render-shared-texts.mts --check   exit 1 when the generated module is out of date

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTemplates } from "../agent/src/lib/texts_core.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SHARED_FILE = "runtime/shared.md";
export const GENERATED = "agent/src/lib/shared_texts.gen.ts";

/** The generated module for the given text of agent/prompts/runtime/shared.md. */
export function renderShared(source: string): string {
  const rows = parseTemplates(SHARED_FILE, source).map((one) =>
    `  { key: ${JSON.stringify(one.key)}, file: ${JSON.stringify(one.file)}, purpose: ${JSON.stringify(one.purpose)},\n` +
    `    body: ${JSON.stringify(one.body)}, placeholders: ${JSON.stringify(one.placeholders)} },`);
  return [
    "// 由 scripts/render-shared-texts.mts 从 agent/prompts/runtime/shared.md 生成，不要手改；改了那份文件之后重新运行它。",
    'import type { Template } from "./texts_core.ts";',
    "",
    "export const SHARED_TEMPLATES: readonly Template[] = [",
    ...rows,
    "];",
    "",
  ].join("\n");
}

function main(): void {
  const rendered = renderShared(readFileSync(join(ROOT, "agent", "prompts", SHARED_FILE), "utf-8"));
  const path = join(ROOT, GENERATED);
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf-8") !== rendered) {
      console.error(`${GENERATED} is out of date (run node scripts/render-shared-texts.mts)`);
      process.exit(1);
    }
    return;
  }
  writeFileSync(path, rendered, "utf-8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
