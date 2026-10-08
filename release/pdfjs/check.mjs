#!/usr/bin/env node
// Helper of release/build.mjs: checks the pdfjs-dist files staged in <payload>/backend/vendor/pdfjs-dist/ by reading
// a PDF with the payload's own script, the way the backend does when a PDF is uploaded. It runs outside the
// repository's node_modules (the working directory is the payload), so it passes only when the staged files are found.
//   node release/pdfjs/check.mjs <payload> <sample.pdf>     exits with status 1 when the PDF cannot be read
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [payload, sample] = process.argv.slice(2).map((each) => path.resolve(each));
if (!payload || !sample) {
  console.error("usage: check.mjs <payload> <sample.pdf>");
  process.exit(2);
}
const script = path.join(payload, "backend", "src", "pdf_projection_cli.mjs");
for (const needed of [script, path.join(payload, "backend", "vendor", "pdfjs-dist", "legacy", "build", "pdf.min.mjs")]) {
  if (!fs.existsSync(needed)) {
    console.error(`pdfjs-dist: ${path.relative(payload, needed)} is not in the payload`);
    process.exit(1);
  }
}
let answer;
try {
  const out = execFileSync(process.execPath, [script, "--pdf", sample, "--rel", "inputs/sample.pdf", "--print"], { cwd: payload, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  answer = JSON.parse(out.trim().split("\n").pop());
} catch (error) {
  console.error(`pdfjs-dist: the payload could not read the sample: ${error.stdout || error.message}`);
  process.exit(1);
}
// Chinese text read with the staged character maps: blocks on every page, and Han characters in the text.
if (!answer.ok || answer.units < 1 || !/\p{Script=Han}{4}/u.test(answer.markdown ?? "")) {
  console.error(`pdfjs-dist: the payload read the sample wrongly: ${JSON.stringify({ ok: answer.ok, pages: answer.pages, units: answer.units, error: answer.error })}`);
  process.exit(1);
}
console.log(`pdfjs-dist: the payload read ${answer.pages} pages, ${answer.units} blocks`);
