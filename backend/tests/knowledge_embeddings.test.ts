/**
 * 知识库文档换算好的数字串的存放（src/knowledge_embeddings.ts）：文档旁边的两个派生文件怎样写、怎样读，什么样的算数，
 * 半成品怎样清；以及知识库这一侧（src/knowledge.ts）删除文档、删除知识库、重新上传同名文档与服务启动时对这两个文件做什么。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { CHUNK_RULES, type Chunk, chunkPlain, chunkRulesVersion } from "../src/knowledge_chunks.ts";
import {
  EMBEDDINGS_SUFFIX, EMBEDDINGS_VERSION, VECTORS_SUFFIX, isEmbedded, normalize, readEmbeddings, readHead, removeEmbeddings, sweepLeftovers, writeEmbeddings,
} from "../src/knowledge_embeddings.ts";
import { GENERAL } from "../src/knowledge.ts";
import { Service } from "../src/service.ts";
import { captureConsole, tempDir } from "./helpers.ts";

captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
/** 一份文档本体的路径（文件本身用不着在）；不给扩展名时是 Markdown。 */
const doc = (extension = ".md") => join(tmp, `文档-${++n}${extension}`);
const chunks: Chunk[] = chunkPlain("第一段。\n\n第二段长一些。").concat(chunkPlain("另一个片段。")).map((c, i) => ({ ...c, index: i + 1 }));
const vectors = () => [normalize([3, 4, 0])!, normalize([0, 0, 2])!];
const near = (a: ArrayLike<number>, b: number[]) => assert.deepEqual(Array.from(a, (x) => Math.round(x * 1e6) / 1e6), b);

test("缩放成长度 1：有不是数的项或者全是 0 时是 null", () => {
  near(normalize([3, 4])!, [0.6, 0.8]);
  near(normalize([0, -5, 0])!, [0, -1, 0]);
  assert.equal(normalize([0, 0, 0]), null);
  assert.equal(normalize([1, Number.NaN]), null);
  assert.equal(normalize([1, Number.POSITIVE_INFINITY]), null);
  assert.equal(normalize([]), null);
});

test("写了再读：概况、各片段与数字串都对得上；.bin 是每个数 4 个字节、低位字节在前；不留下临时文件", () => {
  const path = doc();
  const written = writeEmbeddings(path, "sha-甲", "svc/bge-m3", chunks, vectors());
  const head = { version: EMBEDDINGS_VERSION, chunk_rules: CHUNK_RULES.markdown, document_sha256: "sha-甲", model: "svc/bge-m3", dimensions: 3, chunks: 2, embedded_at: written.embedded_at };
  assert.deepEqual(written, head);
  assert.deepEqual(readHead(path), head);
  const bin = readFileSync(path + VECTORS_SUFFIX);
  assert.equal(bin.length, 2 * 3 * 4);
  near([bin.readFloatLE(0), bin.readFloatLE(4), bin.readFloatLE(8), bin.readFloatLE(20)], [0.6, 0.8, 0, 1]);
  const json = JSON.parse(readFileSync(path + EMBEDDINGS_SUFFIX, "utf-8"));
  assert.deepEqual([json.byte_order, json.normalized, json.chunks], ["little", true, chunks]);
  const all = readEmbeddings(path)!;
  assert.deepEqual([all.head, all.chunks], [head, chunks]);
  near(all.vectors, [0.6, 0.8, 0, 0, 0, 1]);
  assert.deepEqual(readdirSync(tmp).filter((name) => name.endsWith(".tmp")), []);
});

test("算不算换算好了：文档的 sha256、模型名都与成品里记的一致才算", () => {
  const path = doc();
  assert.equal(isEmbedded(path, "sha-甲", "svc/bge-m3"), false);
  writeEmbeddings(path, "sha-甲", "svc/bge-m3", chunks, vectors());
  assert.equal(isEmbedded(path, "sha-甲", "svc/bge-m3"), true);
  assert.equal(isEmbedded(path, "sha-乙", "svc/bge-m3"), false);
  assert.equal(isEmbedded(path, "sha-甲", "svc/另一个模型"), false);
  // 换一个模型重算：新成品盖掉旧的。
  writeEmbeddings(path, "sha-甲", "svc/另一个模型", chunks, [normalize([1, 0])!, normalize([0, 1])!]);
  assert.equal(isEmbedded(path, "sha-甲", "svc/bge-m3"), false);
  assert.equal(isEmbedded(path, "sha-甲", "svc/另一个模型"), true);
  assert.equal(readHead(path)!.dimensions, 2);
  // 切法或者格式的版本对不上的不算。
  const file = path + EMBEDDINGS_SUFFIX;
  const json = JSON.parse(readFileSync(file, "utf-8"));
  writeFileSync(file, JSON.stringify({ ...json, chunk_rules: CHUNK_RULES.markdown + 1 }));
  assert.equal(isEmbedded(path, "sha-甲", "svc/另一个模型"), false);
  writeFileSync(file, JSON.stringify({ ...json, version: EMBEDDINGS_VERSION + 1, note: "换一个长度" }));
  assert.equal(isEmbedded(path, "sha-甲", "svc/另一个模型"), false);
});

test("切法的版本每种文档各记各的：Word 文档的切法改过，按旧切法存下的 Word 成品不算换算好了；Markdown 与纯文本的切法没有变，它们的成品照旧算", () => {
  assert.deepEqual([chunkRulesVersion("规范.docx"), chunkRulesVersion("规范.DOCX"), chunkRulesVersion("规则.md"), chunkRulesVersion("说明.txt"), chunkRulesVersion("没有扩展名")], [2, 2, 1, 1, 1]);
  const paths = { word: doc(".docx"), markdown: doc(".md"), plain: doc(".txt") };
  for (const [kind, path] of Object.entries(paths)) {
    const head = writeEmbeddings(path, "sha-甲", "svc/bge-m3", chunks, vectors());
    assert.equal(head.chunk_rules, CHUNK_RULES[kind as keyof typeof CHUNK_RULES], kind);
    assert.equal(isEmbedded(path, "sha-甲", "svc/bge-m3"), true, kind);
    // 把成品改成上一版存下来的样子：切法版本是 1
    const file = path + EMBEDDINGS_SUFFIX;
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), chunk_rules: 1 }));
  }
  assert.deepEqual([isEmbedded(paths.word, "sha-甲", "svc/bge-m3"), isEmbedded(paths.markdown, "sha-甲", "svc/bge-m3"), isEmbedded(paths.plain, "sha-甲", "svc/bge-m3")], [false, true, true]);
  // 成品还在，读得出来，只是不算数；重新换算之后写的是现在的版本，又算数了
  assert.equal(readHead(paths.word)!.chunk_rules, 1);
  writeEmbeddings(paths.word, "sha-甲", "svc/bge-m3", chunks, vectors());
  assert.deepEqual([readHead(paths.word)!.chunk_rules, isEmbedded(paths.word, "sha-甲", "svc/bge-m3")], [2, true]);
});

test("没有片段的文档照样写：.bin 是空文件，片段数与数字串的长度都是 0，算换算好了", () => {
  const path = doc();
  writeEmbeddings(path, "sha-空", "svc/bge-m3", [], []);
  assert.equal(statSync(path + VECTORS_SUFFIX).size, 0);
  assert.deepEqual([readHead(path)!.chunks, readHead(path)!.dimensions], [0, 0]);
  assert.equal(isEmbedded(path, "sha-空", "svc/bge-m3"), true);
  assert.deepEqual(Array.from(readEmbeddings(path)!.vectors), []);
});

test("对不上的不算数：只有 .bin、.bin 的长度不对、.json 读不出来都当作没有；片段与数字串的个数不一致时不写", () => {
  const path = doc();
  writeEmbeddings(path, "sha-甲", "svc/bge-m3", chunks, vectors());
  const bin = readFileSync(path + VECTORS_SUFFIX);
  writeFileSync(path + VECTORS_SUFFIX, bin.subarray(0, 20));
  assert.equal(readHead(path), null);
  assert.equal(readEmbeddings(path), null);
  writeFileSync(path + VECTORS_SUFFIX, bin);
  assert.notEqual(readHead(path), null);
  writeFileSync(path + EMBEDDINGS_SUFFIX, "{ 写到一半");
  assert.equal(readHead(path), null);
  rmSync(path + EMBEDDINGS_SUFFIX);
  assert.equal(readHead(path), null);
  const other = doc();
  assert.throws(() => writeEmbeddings(other, "sha", "svc/bge-m3", chunks, [vectors()[0]]), TypeError);
  assert.throws(() => writeEmbeddings(other, "sha", "svc/bge-m3", chunks, [normalize([1, 0])!, normalize([1, 0, 0])!]), TypeError);
  assert.equal(existsSync(other + EMBEDDINGS_SUFFIX), false);
});

test("重写时旧成品先作废：数字串写完、概况还没写时停下，留下的不算数", () => {
  const path = doc();
  writeEmbeddings(path, "sha-甲", "svc/模型一", chunks, vectors());
  // 模拟换成模型二重算到一半：旧的 .json 已删，新的 .bin 已改名，新的 .json 还没有。
  rmSync(path + EMBEDDINGS_SUFFIX);
  writeFileSync(path + VECTORS_SUFFIX, Buffer.alloc(2 * 3 * 4, 1));
  assert.equal(isEmbedded(path, "sha-甲", "svc/模型一"), false);
  assert.equal(isEmbedded(path, "sha-甲", "svc/模型二"), false);
});

test("清半成品：临时文件与没有 .json 的 .bin 删掉，完整的成品、文档本体与别的派生文件不动；目录不在时什么也不做", () => {
  const dir = join(tmp, "files");
  const service = new Service(join(tmp, "sweep", "tasks"), join(tmp, "sweep", "runs"), {}, { port: 1, knowledgeDir: dir });
  const files = service.knowledge!.filesDir(GENERAL);
  const whole = join(files, "完整.md");
  writeFileSync(whole, "正文");
  writeEmbeddings(whole, "sha", "svc/bge-m3", chunks, vectors());
  writeFileSync(join(files, "半份.md"), "正文");
  writeFileSync(join(files, "半份.md.embeddings.bin"), Buffer.alloc(8));
  writeFileSync(join(files, "半份.md.embeddings.bin.4242.tmp"), Buffer.alloc(8));
  writeFileSync(join(files, "另一份.md.embeddings.json.4242.tmp"), "{");
  writeFileSync(join(files, "说明.docx.segments.json"), "{}");
  assert.equal(sweepLeftovers(files), 3);
  assert.deepEqual(readdirSync(files).sort(), ["半份.md", "完整.md", "完整.md.embeddings.bin", "完整.md.embeddings.json", "说明.docx.segments.json"].sort());
  assert.equal(sweepLeftovers(files), 0);
  assert.equal(sweepLeftovers(join(tmp, "没有这个目录")), 0);
});

test("知识库这一侧：服务启动时清各库的半成品；删除文档连同它的数字串一起删；重新上传同名文档时不沿用旧的；删除知识库整个目录都没了", async () => {
  const root = join(tmp, "store");
  const first = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1, knowledgeDir: join(root, "knowledge") });
  const store = first.knowledge!;
  const lib = store.create("城北区图书馆的资料");
  const row = store.upload(lib.id, "规则.md", Buffer.from("# 退款\n七天之内可以退款。"), "standard");
  const path = store.filePath(lib.id, "规则.md");
  writeEmbeddings(path, row.sha256, "svc/bge-m3", chunks, vectors());
  writeFileSync(join(store.filesDir(lib.id), "规则.md.embeddings.bin.4242.tmp"), Buffer.alloc(8));
  writeFileSync(join(store.filesDir(GENERAL), "别的.md.embeddings.bin"), Buffer.alloc(8));
  await first.close();

  // 再起一次服务：两个库里的半成品都清了，完整的成品还在。
  const second = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1, knowledgeDir: join(root, "knowledge") });
  assert.deepEqual(readdirSync(store.filesDir(lib.id)).sort(), ["规则.md", "规则.md.embeddings.bin", "规则.md.embeddings.json"]);
  assert.deepEqual(readdirSync(store.filesDir(GENERAL)), []);
  assert.equal(isEmbedded(path, row.sha256, "svc/bge-m3"), true);

  second.knowledge!.removeDocument(lib.id, "规则.md");
  assert.deepEqual(readdirSync(store.filesDir(lib.id)), []);
  assert.equal(readHead(path), null);

  // 同名的文档留下了数字串（例如删除时没删成）：再上传这个名字的文档时清掉，不当成新文档的。
  writeEmbeddings(path, "sha-旧", "svc/bge-m3", chunks, vectors());
  const again = second.knowledge!.upload(lib.id, "规则.md", Buffer.from("改过的内容。"), "standard");
  assert.deepEqual(readdirSync(store.filesDir(lib.id)), ["规则.md"]);
  writeEmbeddings(path, again.sha256, "svc/bge-m3", chunks, vectors());
  second.knowledge!.remove(lib.id);
  assert.equal(existsSync(join(store.root, lib.id)), false);
  removeEmbeddings(path);   // 文件已经不在时不出错
  await second.close();
});
