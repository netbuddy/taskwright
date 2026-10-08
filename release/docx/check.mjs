#!/usr/bin/env node
// Helper of release/build.mjs: checks the bundled docx file in <dir> by writing a small Word document with it, a
// heading and a two-column table with Chinese text, and reading the result back as a zip archive.
//   node release/docx/check.mjs <dir>     exits with status 1 when the document cannot be written
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: check.mjs <dir>");
  process.exit(2);
}
const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import(pathToFileURL(path.join(path.resolve(dir), "docx_lib.mjs")).href);
const cell = (text) => new TableCell({ width: { size: 50, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun(text)] })] });
const document = new Document({ sections: [{ children: [
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("功能用例")] }),
  new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [cell("用例名称"), cell("登录")] })] }),
] }] });
const data = await Packer.toBuffer(document);
// A .docx is a zip archive: it starts with the local file header signature and must hold word/document.xml.
if (data.subarray(0, 4).toString("latin1") !== "PK\u0003\u0004" || !data.includes("word/document.xml")) {
  console.error("docx bundle: the file it wrote is not a Word document");
  process.exit(1);
}
