/**
 * 静态核对：安装包里的 PDF 解析库。
 *
 * 安装包没有 node_modules，release/build.mjs 把 pdfjs-dist 里后端用到的那几样文件原样拷进 backend/vendor/pdfjs-dist/，
 * 后端加载时先找那里（pdf_projection.ts 的 pdfjsFiles）。这里只读文件，核对：构建脚本拷的清单与后端用的清单是同一份；
 * 后端钉的是一个精确版本，与代码里核对的版本相同；上传 PDF 时另起运行要跑的命令行入口在构建脚本收集后端文件的起点里；
 * 仓库里（没有随包目录）找到的是 node_modules 里的那一份。真的用负载里的文件读一份 PDF，由构建时的 release/pdfjs/check.mjs 做。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import { PDFJS_FILES, PDFJS_VENDOR_DIR, PDFJS_VERSION, pdfjsFiles } from "../src/pdf_projection.ts";
import { pdfCliPath } from "../src/pdf_upload.ts";
import { ROOT } from "./helpers.ts";

const build = readFileSync(join(ROOT, "release", "build.mjs"), "utf-8");

test("构建脚本拷进安装包的 pdfjs-dist 文件清单，与后端用到的清单是同一份；放的目录是后端先找的那一个", () => {
  const listed = /const PDFJS_FILES = (\[[^\]]*\]);/.exec(build);
  assert.ok(listed, "release/build.mjs 里应当有 PDFJS_FILES");
  assert.deepEqual(JSON.parse(listed[1]), [...PDFJS_FILES]);
  assert.equal(PDFJS_VENDOR_DIR, "backend/vendor/pdfjs-dist");
  assert.ok(build.includes('path.join(payload, "backend", "vendor", "pdfjs-dist")'));
  // 画页面用的原生模块不在清单里，不会被带进安装包。
  assert.ok(!PDFJS_FILES.some((one) => one.includes("canvas")));
});

test("后端钉的 pdfjs-dist 是一个精确版本，与代码里核对的版本相同", () => {
  const pinned = JSON.parse(readFileSync(join(ROOT, "backend", "package.json"), "utf-8")).dependencies["pdfjs-dist"];
  assert.match(pinned, /^\d+\.\d+\.\d+$/);
  assert.equal(pinned, PDFJS_VERSION);
});

test("上传 PDF 时另起运行要跑的命令行入口：文件在，并且在构建脚本收集后端文件的起点里", () => {
  assert.ok(existsSync(pdfCliPath()), pdfCliPath());
  assert.ok(pdfCliPath().endsWith(join("backend", "src", "pdf_projection_cli.mts")));
  assert.match(build, /const PDF_CLI = "backend\/src\/pdf_projection_cli\.mts";/);
  assert.match(build, /"backend\/src\/diagram_worker\.ts", PDF_CLI\]/);
});

test("仓库里没有随包目录，找到的是 node_modules 里的那一份", () => {
  assert.equal(existsSync(join(ROOT, ...PDFJS_VENDOR_DIR.split("/"))), false, "随包目录只在安装包里有，不进仓库");
  const { main, worker } = pdfjsFiles();
  assert.ok(main.includes(`${sep}node_modules${sep}pdfjs-dist${sep}`) && main.endsWith("pdf.min.mjs"), main);
  assert.ok(worker.endsWith("pdf.worker.min.mjs") && existsSync(worker), worker);
});
