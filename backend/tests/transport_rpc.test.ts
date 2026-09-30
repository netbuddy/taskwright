/**
 * 收发数据这一层的子进程实现：按行读的断法（只按换行符断开），以及一个真子进程写出含 U+2028、U+2029 的 JSON 行时读到的是完整的一行。
 */

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { RpcTransport, readLines } from "../src/transport_rpc.ts";

/** 把几块数据依次写进一路输出，收下切出来的行。 */
function linesOf(chunks: (string | Buffer)[]): Promise<string[]> {
  const stream = new PassThrough();
  const got: string[] = [];
  return new Promise((done) => {
    readLines(stream, (line) => got.push(line), () => done(got));
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
}

test("只在换行符处断行：U+2028、U+2029 与行中间单独的回车留在行里，行尾的回车去掉，最后一段没有换行符也算一行", async () => {
  assert.deepEqual(await linesOf(["{\"a\":\"x y\"}\n", "b c\r\n", "d\re\n\nf"]),
    ["{\"a\":\"x y\"}", "b c", "d\re", "", "f"]);
});

test("一行分几块到达、一个字符的 UTF-8 字节跨两块时，拼回原来的一行", async () => {
  const bytes = Buffer.from("{\"text\":\"材料 第二段\"}\n", "utf-8");
  const cut = bytes.indexOf(Buffer.from("料", "utf-8")) + 1;   // 切在「料」的三个字节中间
  assert.deepEqual(await linesOf([bytes.subarray(0, cut), bytes.subarray(cut)]), ["{\"text\":\"材料 第二段\"}"]);
});

test("子进程写出含 U+2028、U+2029 的 JSON 行：读到完整的一行，解析得出原来的字符串；错误输出同样按换行符断行", async () => {
  const text = "第一段 第二段 第三段";
  const script = `process.stdout.write(JSON.stringify({ type: "message_end", text: ${JSON.stringify(text)} }) + "\\n");` +
    `process.stderr.write("进度 10%\\r进度 20%\\n");`;
  const transport = new RpcTransport();
  await transport.start({ command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: { ...process.env } as Record<string, string> });
  const lines: string[] = [];
  const errors: string[] = [];
  await new Promise<void>((ended) => transport.subscribe({ line: (l) => lines.push(l), stderrLine: (l) => errors.push(l), ended }));
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(JSON.parse(lines[0]).text, text);
  assert.deepEqual(errors, ["进度 10%\r进度 20%"]);
  assert.equal(transport.exitCode(), 0);
  assert.equal(transport.running(), false);
});
