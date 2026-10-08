#!/usr/bin/env node
// Helper of release/build.mjs for the bundled diagram check engine in <dir> (diagram_engine.mjs and assets/).
//
//   node release/diagram/prune.mjs trace <dir>   run the samples through the engine and print, as a JSON list of
//                                                paths relative to <dir>, the files Node loaded from <dir>
//   node release/diagram/prune.mjs check <dir>   run the samples and exit with status 1 unless every one gives
//                                                the diagram type, the syntax error and the line it should
//
// mermaid's bundle holds every kind of diagram it can draw and loads each on first use. The product checks five
// kinds, written with four of mermaid's (release/diagram/samples.mjs), so build.mjs keeps the files `trace`
// names, removes the rest, and runs `check` on what is left; a build that removed too much fails there.
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SAMPLES } from "./samples.mjs";

const [mode, given] = process.argv.slice(2);
if (!["trace", "check"].includes(mode) || !given) {
  console.error("usage: prune.mjs trace|check <dir>");
  process.exit(2);
}
const dir = path.resolve(given);
const prefix = pathToFileURL(dir + path.sep).href;

const loaded = new Set();
if (mode === "trace") {
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith(prefix)) loaded.add(path.relative(dir, fileURLToPath(url)).split(path.sep).join("/"));
      return nextLoad(url, context);
    },
  });
}

const { inspect } = await import(pathToFileURL(path.join(dir, "diagram_engine.mjs")).href);
const wrong = [];
for (const sample of SAMPLES) {
  const result = await inspect(sample.text);
  const got = { type: result.type, error: result.error !== null, line: result.error?.line ?? undefined };
  const want = { type: sample.type, error: sample.error, line: sample.line };
  if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${sample.name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}${result.error ? ` (${result.error.message.split("\n")[0]})` : ""}`);
}
if (wrong.length) {
  for (const line of wrong) console.error(`diagram check engine: ${line}`);
  process.exit(1);
}
if (mode === "trace") console.log(JSON.stringify([...loaded].sort()));
