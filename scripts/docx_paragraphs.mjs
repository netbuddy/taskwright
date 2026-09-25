#!/usr/bin/env node
// Lists the paragraphs of a .docx in the order they appear in word/document.xml, numbered from 1.
//
// Counting rule (the same rule the browser side uses after rendering, so the two numbers match):
//   - count every w:p inside w:body, including paragraphs in table cells and in nested tables;
//   - an empty paragraph in a vertically merged continuation cell still counts;
//   - do not count paragraphs inside a text box (w:txbxContent, both the wps copy and the VML fallback);
//     footnotes, endnotes, comments, headers and footers live in other parts and are not read at all.
// A paragraph's text is its own w:t text (inserted text included, deleted text in w:delText left out, field codes in
// w:instrText left out, text of a text box anchored in it left out); w:tab becomes a tab and w:br a line break.
//
// Usage: node scripts/docx_paragraphs.mjs <file.docx> [--json]
// Only Node's built-in modules are used; the .docx is read with a small zip reader below.

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/** One file out of a zip archive (stored or deflated entries, which is all .docx uses). */
export function readZipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (entry === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m);

/**
 * The paragraphs of document.xml: [{ n, text, table }] where table describes where a table paragraph sits,
 * for example { path: [{ table: 3, row: 4, col: 3 }, { row: 1, col: 1 }] } (the first entry is a top-level table,
 * later entries are nested tables; col is the grid column, counting a horizontally merged cell's span).
 */
export function paragraphsOf(xml) {
  const out = [];
  const stack = [];          // open element names
  const paras = [];          // open paragraphs: { counted, text }
  const tables = [];         // open tables: { index, row, col, span }
  let topTables = 0;
  let inText = false;        // inside w:t
  let skip = 0;              // depth inside w:txbxContent
  let inBody = false;
  const re = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|([^<]+)|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, close, name, attrs, selfClose, text] = m;
    if (text !== undefined) {
      if (inText && paras.length) paras[paras.length - 1].text += decode(text);
      continue;
    }
    if (!name) continue;
    if (close) {
      stack.pop();
      closeTag(name);
      continue;
    }
    openTag(name, attrs);
    if (selfClose) closeTag(name);
    else stack.push(name);
  }
  return out;

  function openTag(name, attrs) {
    switch (name) {
      case "w:body": inBody = true; break;
      case "w:txbxContent": skip++; break;
      case "w:tbl":
        if (!skip) tables.push({ index: tables.length ? null : ++topTables, row: 0, col: 0 });
        break;
      case "w:tr": if (!skip && tables.length) { const t = tables.at(-1); t.row++; t.col = 0; t.next = 1; } break;
      case "w:tc": if (!skip && tables.length) { const t = tables.at(-1); t.col = t.next; t.next += 1; } break;
      case "w:gridSpan":
        if (!skip && tables.length) { const t = tables.at(-1); t.next = t.col + Number(/w:val="(\d+)"/.exec(attrs)?.[1] ?? 1); }
        break;
      case "w:p":
        paras.push({ counted: inBody && !skip, text: "", table: tables.map((t) => (t.index ? { table: t.index, row: t.row, col: t.col } : { row: t.row, col: t.col })) });
        break;
      case "w:t": inText = true; break;
      // w:tab also appears in w:pPr/w:tabs as a tab stop; only a w:tab or w:br directly in a run is a character.
      case "w:tab": if (paras.length && stack.at(-1) === "w:r") paras.at(-1).text += "\t"; break;
      case "w:br": case "w:cr":
        if (paras.length && stack.at(-1) === "w:r" && !/w:type="(page|column)"/.test(attrs)) paras.at(-1).text += "\n";
        break;
    }
  }

  function closeTag(name) {
    switch (name) {
      case "w:body": inBody = false; break;
      case "w:txbxContent": skip--; break;
      case "w:tbl": if (!skip) tables.pop(); break;
      case "w:t": inText = false; break;
      case "w:p": {
        const p = paras.pop();
        if (p.counted) out.push({ n: out.length + 1, text: p.text, ...(p.table.length ? { table: p.table } : {}) });
        break;
      }
    }
  }
}

/** 「表 3 行 4 列 3 · 嵌套表 行 1 列 1」 */
export function tableLabel(table) {
  return table.map((t) => (t.table ? `表 ${t.table} 行 ${t.row} 列 ${t.col}` : `嵌套表 行 ${t.row} 列 ${t.col}`)).join(" · ");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, flag] = process.argv.slice(2);
  if (!file) { console.error("usage: node scripts/docx_paragraphs.mjs <file.docx> [--json]"); process.exit(2); }
  const xml = readZipEntry(readFileSync(file), "word/document.xml");
  if (!xml) { console.error(`${file}: no word/document.xml`); process.exit(1); }
  const list = paragraphsOf(xml.toString("utf8"));
  if (flag === "--json") console.log(JSON.stringify(list, null, 1));
  else for (const p of list) console.log(`[第 ${p.n} 段${p.table ? " · " + tableLabel(p.table) : ""}] ${p.text.replace(/\n/g, "↵")}`);
}
