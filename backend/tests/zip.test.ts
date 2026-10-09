/**
 * zip 的最小读写（src/zip.ts）：空包、压缩与不压缩、几千个条目、中文条目名；读的一方对不是 zip 的文件、损坏的目录、
 * 与记录不符的内容报错；写的一方到条目个数的上限时拒绝；与系统的 unzip、zip 两个命令互相读得了（机器上没有这两个命令时跳过）。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ZIP_MAX_ENTRIES, ZipError, ZipReader, ZipTooLarge, ZipWriter, validEntryName } from "../src/zip.ts";
import { tempDir } from "./helpers.ts";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name = "pack.zip") => {
  const dir = join(tmp, `case-${++n}`);
  mkdirSync(dir);
  return join(dir, name);
};
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const has = (command: string) => spawnSync(command, ["-v"], { stdio: "ignore" }).status === 0;

/** 把读的一方抛的错取出来（同步的 open 与异步的 extract 都经这里）。 */
async function failure(body: () => unknown): Promise<Error> {
  try {
    await body();
  } catch (error) {
    return error as Error;
  }
  throw new Error("本来应当报错");
}

test("空包：写出来的文件读得回来，里面没有条目", () => {
  const path = fresh();
  const writer = ZipWriter.create(path);
  assert.equal(writer.finish(), 22);
  const reader = ZipReader.open(path);
  assert.deepEqual(reader.entries, []);
  reader.close();
  // 已经有的文件不覆盖。
  assert.throws(() => ZipWriter.create(path), /EEXIST/);
});

test("压缩与不压缩各一个条目、一个空文件：字节数与摘要对得上，解出来的内容与写进去的相同", async () => {
  const path = fresh();
  const text = Buffer.from("退款规则：七天内无理由退货。\n".repeat(400), "utf-8");
  const noise = randomBytes(70_000);
  const source = join(tmp, "source.bin");
  writeFileSync(source, noise);
  const writer = ZipWriter.create(path);
  const a = await writer.addBuffer("tasks/甲/说明.md", text, { mtime: new Date(2026, 9, 8, 21, 14, 58) });
  const b = await writer.addFile("tasks/甲/data.bin", source, { store: true });
  const c = await writer.addBuffer("tasks/甲/empty.txt", Buffer.alloc(0), { store: true });
  const total = writer.finish();
  assert.equal(total, statSync(path).size);
  assert.deepEqual([a, b, c], [{ bytes: text.length, sha256: sha256(text) }, { bytes: noise.length, sha256: sha256(noise) }, { bytes: 0, sha256: sha256(Buffer.alloc(0)) }]);

  const reader = ZipReader.open(path);
  assert.deepEqual(reader.entries.map((e) => [e.name, e.size, e.method]), [["tasks/甲/说明.md", text.length, 8], ["tasks/甲/data.bin", noise.length, 0], ["tasks/甲/empty.txt", 0, 0]]);
  assert.ok(reader.entries[0].packed < text.length / 10, "重复的文字压得下去");
  assert.equal(reader.entries[1].packed, noise.length, "不压缩的条目原样存着");
  assert.deepEqual(reader.read(reader.entry("tasks/甲/说明.md")!), text);
  const out = join(tmp, `out-${n}`);
  for (const [entry, data] of [[reader.entries[0], text], [reader.entries[1], noise], [reader.entries[2], Buffer.alloc(0)]] as const) {
    const target = join(out, entry.name);
    assert.deepEqual(await reader.extract(entry, target), { bytes: data.length, sha256: sha256(data) });
    assert.deepEqual(readFileSync(target), data);
  }
  // 目标文件已经在：不覆盖。
  assert.match((await failure(() => reader.extract(reader.entries[0], join(out, reader.entries[0].name)))).message, /EEXIST/);
  // 太大的条目不整个读进内存。
  assert.ok((await failure(() => reader.read(reader.entries[1], 1000))) instanceof ZipError);
  reader.close();
});

test("三千个条目：个数、名字与内容都对", async () => {
  const path = fresh();
  const writer = ZipWriter.create(path);
  for (let i = 0; i < 3000; i++) await writer.addBuffer(`runs/TASK-1/pi-events/${String(i).padStart(4, "0")}.jsonl`, Buffer.from(`{"n":${i}}\n`), { store: i % 2 === 0 });
  assert.equal(writer.entryCount, 3000);
  writer.finish();
  const reader = ZipReader.open(path);
  assert.equal(reader.entries.length, 3000);
  assert.deepEqual([0, 1499, 2999].map((i) => [reader.entries[i].name, reader.read(reader.entries[i]).toString()]),
    [["runs/TASK-1/pi-events/0000.jsonl", '{"n":0}\n'], ["runs/TASK-1/pi-events/1499.jsonl", '{"n":1499}\n'], ["runs/TASK-1/pi-events/2999.jsonl", '{"n":2999}\n']]);
  reader.close();
});

test("条目名只用正斜杠分段，不收空段、点段与反斜杠", async () => {
  assert.deepEqual(["a/b.txt", "材料 一.md", "a//b", "/a", "a/", "a/../b", "./a", "a\\b", ""].map(validEntryName), [true, true, false, false, false, false, false, false, false]);
  const writer = ZipWriter.create(fresh());
  assert.match((await failure(() => writer.addBuffer("../outside", Buffer.from("x")))).message, /条目名不对/);
  writer.close();
});

test("到条目个数的上限时拒绝再加", async () => {
  const writer = ZipWriter.create(fresh());
  const empty = Buffer.alloc(0);
  for (let i = 0; i < ZIP_MAX_ENTRIES; i++) await writer.addBuffer(`f/${i}`, empty, { store: true });
  const error = await failure(() => writer.addBuffer("f/one-more", empty, { store: true }));
  assert.ok(error instanceof ZipTooLarge);
  assert.match(error.message, /65534 个/);
  writer.finish();
});

test("读的一方：不是 zip 的文件、被截短的文件、损坏的目录、与记录不符的内容都报错", async () => {
  const path = fresh();
  const body = Buffer.from("一二三四五六七八九十".repeat(50), "utf-8");
  const writer = ZipWriter.create(path);
  await writer.addBuffer("stored.txt", body, { store: true });
  await writer.addBuffer("packed.txt", body);
  writer.finish();
  const good = readFileSync(path);
  const broken = (name: string, change: (data: Buffer) => Buffer) => {
    const file = fresh(name);
    writeFileSync(file, change(Buffer.from(good)));
    return file;
  };

  const text = broken("text.zip", () => Buffer.from("这只是一段文字，不是 zip。".repeat(10)));
  assert.match((await failure(() => ZipReader.open(text))).message, /不是一个 zip 文件/);
  const cut = broken("cut.zip", (data) => data.subarray(0, data.length - 40));
  assert.ok((await failure(() => ZipReader.open(cut))) instanceof ZipError);

  // 目录里第一条记录的标记改掉。
  const directoryAt = good.readUInt32LE(good.length - 22 + 16);
  const badDirectory = broken("directory.zip", (data) => (data.writeUInt32LE(0, directoryAt), data));
  assert.match((await failure(() => ZipReader.open(badDirectory))).message, /目录损坏/);

  // 不压缩的那个条目的内容改一个字节：长度不变，校验值不符。
  const firstDataAt = 30 + "stored.txt".length;
  const badContent = broken("content.zip", (data) => (data[firstDataAt + 5] ^= 0xff, data));
  const reader = ZipReader.open(badContent);
  assert.match((await failure(() => reader.extract(reader.entries[0], join(tmp, "bad-content.txt")))).message, /校验值不符/);
  assert.match((await failure(() => reader.read(reader.entries[0]))).message, /校验值不符/);
  // 另一个条目没有动，照常解得出来。
  assert.deepEqual(reader.read(reader.entries[1]), body);
  reader.close();

  // 压缩的那个条目的内容改坏：解不出来，或者解出来的校验值不符，都是 ZipError。
  const secondAt = good.readUInt32LE(directoryAt + 46 + "stored.txt".length + 42);
  const badPacked = broken("packed.zip", (data) => (data.fill(0xff, secondAt + 30 + "packed.txt".length + 2, secondAt + 30 + "packed.txt".length + 8), data));
  const second = ZipReader.open(badPacked);
  assert.ok((await failure(() => second.extract(second.entries[1], join(tmp, "bad-packed.txt")))) instanceof ZipError);
  assert.ok((await failure(() => second.read(second.entries[1]))) instanceof ZipError);
  second.close();

  // 目录里记的长度比实际解出来的短：不往下解。
  const shortSize = broken("size.zip", (data) => (data.writeUInt32LE(10, directoryAt + 24), data));
  const third = ZipReader.open(shortSize);
  assert.match((await failure(() => third.extract(third.entries[0], join(tmp, "short.txt")))).message, /长度不符/);
  third.close();
});

test("系统的 unzip 核对我们写的包", { skip: has("unzip") ? false : "这台机器上没有 unzip 命令" }, async () => {
  const path = fresh();
  const writer = ZipWriter.create(path);
  await writer.addBuffer("tasks/TASK-1/inputs/售后退款 业务说明.md", Buffer.from("退款规则\n".repeat(300), "utf-8"));
  await writer.addBuffer("tasks/TASK-1/inputs/图.png", randomBytes(5000), { store: true });
  await writer.addBuffer("manifest.json", Buffer.from("{}\n"));
  writer.finish();
  const check = spawnSync("unzip", ["-t", path], { encoding: "utf-8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /No errors detected/);
  assert.match(check.stdout, /售后退款 业务说明\.md\s+OK/, "中文条目名照原样显示");
  // 解出来的内容相同。
  const out = join(tmp, `unzipped-${n}`);
  assert.equal(spawnSync("unzip", ["-q", path, "-d", out]).status, 0);
  assert.equal(readFileSync(join(out, "tasks/TASK-1/inputs/售后退款 业务说明.md"), "utf-8"), "退款规则\n".repeat(300));
});

test("系统的 zip 打的包由我们读", { skip: has("zip") ? false : "这台机器上没有 zip 命令" }, async () => {
  const dir = join(tmp, `zipped-${++n}`);
  mkdirSync(join(dir, "src", "子目录"), { recursive: true });
  const files: Record<string, Buffer> = { "src/甲.md": Buffer.from("第一份\n".repeat(200), "utf-8"), "src/子目录/乙.bin": randomBytes(3000), "src/空.txt": Buffer.alloc(0) };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
  assert.equal(spawnSync("zip", ["-q", "-r", "made.zip", "src"], { cwd: dir }).status, 0);
  // 再往同一个包里加一个不压缩的条目。
  writeFileSync(join(dir, "plain.txt"), "不压缩\n");
  assert.equal(spawnSync("zip", ["-q", "-0", "made.zip", "plain.txt"], { cwd: dir }).status, 0);
  const reader = ZipReader.open(join(dir, "made.zip"));
  // 目录条目不列出来。
  assert.deepEqual(reader.entries.map((e) => e.name).sort(), [...Object.keys(files), "plain.txt"].sort());
  for (const [name, data] of Object.entries(files)) {
    const target = join(dir, "out", name);
    assert.equal((await reader.extract(reader.entry(name)!, target)).sha256, sha256(data));
    assert.ok(existsSync(target));
  }
  assert.equal(reader.entry("plain.txt")!.method, 0);
  assert.equal(reader.read(reader.entry("plain.txt")!).toString(), "不压缩\n");
  reader.close();
});
