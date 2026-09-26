/**
 * 路由与请求解析：路由分派（路径末尾的斜杠、百分号编码、没有的接口、这一版还没接上的接口）、错误形状与状态码、
 * 查询串与 multipart 的解析（中文文件名、RFC 2231 写法、引号里的转义）、超大上传不读请求体就拒绝、不支持的方法、时间的换算。
 * 对应服务端 Python 测试 test_service_units 的错误形状一条；其余是 TypeScript 版自己的路由与解析。
 */

import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as clock from "../src/clock.ts";
import { ApiError, STATUS } from "../src/errors.ts";
import { dispatch, headerParams, makeServer, parseMultipart, parseQuery, unquote } from "../src/http.ts";
import { Service } from "../src/service.ts";
import { tempDir } from "./helpers.ts";

let tmp: string;
let service: Service;
before(() => {
  tmp = tempDir();
  service = new Service(join(tmp, "tasks"), join(tmp, "runs"), {});
});
after(() => {
  service.close();
  rmSync(tmp, { recursive: true, force: true });
});

const go = (method: string, path: string, body = "", query: Record<string, string> = {}) => {
  const reply = dispatch(service, { method, path, query, headers: {}, body: Buffer.from(body) });
  return { status: reply.status, body: JSON.parse(reply.body.toString("utf-8")) };
};

test("错误形状与状态码", () => {
  const error = new ApiError("session_busy", "助手正在另一条会话里工作。", { active_session: "s1" });
  assert.equal(error.status, 409);
  assert.deepEqual(error.body(), { ok: false, error: { code: "session_busy", message: "助手正在另一条会话里工作。", data: { active_session: "s1" } } });
  assert.deepEqual(["bad_request", "rejected", "executor_starting", "too_large", "unsupported_type", "task_occupied", "not_implemented", "别的"].map((c) => new ApiError(c, "").status),
    [400, 422, 503, 413, 415, 409, 501, 500]);
  assert.equal(STATUS.old_format, 409);
});

test("路由分派：没有的接口、没有的任务、这一版还没接上的接口、方法不对", () => {
  assert.deepEqual(go("GET", "/api/v1/nothing").body.error.code, "not_found");
  assert.equal(go("GET", "/api/v1/nothing").body.error.message, "没有这个接口：GET /api/v1/nothing");
  assert.deepEqual([go("GET", "/api/v1/tasks/TASK-NONE").status, go("GET", "/api/v1/tasks/TASK-NONE").body.error.message], [404, "没有任务 TASK-NONE。"]);
  for (const [method, path] of [["GET", "/api/v1/tasks/T/snapshot"], ["GET", "/api/v1/tasks/T/events"], ["POST", "/api/v1/tasks/T/messages"],
    ["POST", "/api/v1/tasks/T/actions"], ["POST", "/api/v1/tasks/T/control"], ["POST", "/api/v1/tasks/T/sessions"], ["GET", "/api/v1/tasks/T/conversation"]]) {
    const got = go(method, path);
    assert.deepEqual([got.status, got.body.error.code], [501, "not_implemented"], `${method} ${path}`);
  }
  assert.equal(go("POST", "/api/v1/task-types").body.error.code, "not_found", "方法对不上也是 not_found");
  assert.deepEqual(go("GET", "/api/v1/task-types").body.task_types.map((t: any) => t.task_type), ["srs-authoring"]);
});

test("请求体：不是 JSON、不是对象都是 bad_request；空请求体按空对象", () => {
  assert.equal(go("POST", "/api/v1/tasks", "{").body.error.message, "请求体不是合法的 JSON。");
  assert.equal(go("POST", "/api/v1/tasks", "[1]").body.error.message, "请求体应当是一个 JSON 对象。");
  assert.equal(go("POST", "/api/v1/tasks", "").body.ok, true, "空请求体按空对象，建一个缺省类型的任务");
});

test("查询串与百分号编码的解码", () => {
  assert.deepEqual(parseQuery("path=inputs%2F%E9%9C%80.md&session=&x&a=1&a=2&b=c+d"), { path: "inputs/需.md", a: "2", b: "c d" });
  assert.equal(unquote("/api/v1/tasks/T%2FX"), "/api/v1/tasks/T/X");
  assert.equal(unquote("%E9%9C"), "\uFFFD", "不完整的 UTF-8 换成替换字符");
  assert.equal(unquote("100%"), "100%");
});

test("multipart：第一个带文件名的部分；中文文件名、RFC 2231 写法、引号里的转义；没有文件时 bad_request", () => {
  const body = (disposition: string, content = "hello\r\nworld") =>
    Buffer.from(`--B\r\n${disposition}\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n--B--\r\n`, "utf-8");
  const type = "multipart/form-data; boundary=B";
  assert.deepEqual(parseMultipart(type, body('Content-Disposition: form-data; name="file"; filename="需求说明.md"')), ["需求说明.md", Buffer.from("hello\r\nworld")]);
  assert.equal(parseMultipart(type, body("Content-Disposition: form-data; name=\"file\"; filename*=UTF-8''%E9%9C%80.md"))[0], "需.md");
  assert.equal(parseMultipart(type, body('Content-Disposition: form-data; name="file"; filename="C:\\\\x\\\\y.md"'))[0], "C:\\x\\y.md");
  assert.equal(parseMultipart(type, body("Content-Disposition: form-data; name=file; filename=plain.md"))[0], "plain.md");
  const two = Buffer.from('--B\r\nContent-Disposition: form-data; name="note"\r\n\r\n备注\r\n--B\r\nContent-Disposition: form-data; name="file"; filename="b.txt"\r\n\r\n乙\r\n--B--\r\n', "utf-8");
  assert.deepEqual(parseMultipart(type, two), ["b.txt", Buffer.from("乙")]);
  assert.deepEqual(headerParams('; boundary="a b"; x=1'), { boundary: "a b", x: "1" });
  for (const [contentType, data] of [["text/plain", Buffer.from("abc")], [type, Buffer.from("--B\r\nContent-Disposition: form-data; name=\"x\"\r\n\r\n1\r\n--B--\r\n")]] as const) {
    assert.throws(() => parseMultipart(contentType, data), (e: unknown) => e instanceof ApiError && e.message === "请求里没有文件。");
  }
});

test("经 HTTP：超大上传不读请求体就以 too_large 拒绝；没有的任务先报 not_found；不支持的方法 501；路径末尾的斜杠去掉", async () => {
  const server = makeServer(service).listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  const port = (server.address() as AddressInfo).port;
  const send = (method: string, path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode!, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", fail);
    req.end();
  });
  try {
    const { task_id: taskId } = service.create({});
    const big = await send("POST", `/api/v1/tasks/${taskId}/materials`, { "Content-Length": String(6 * 1024 * 1024), "Content-Type": "multipart/form-data; boundary=B" });
    assert.deepEqual([big.status, JSON.parse(big.body).error.code], [413, "too_large"]);
    const missing = await send("POST", "/api/v1/tasks/TASK-NONE/materials", { "Content-Length": String(6 * 1024 * 1024) });
    assert.deepEqual([missing.status, JSON.parse(missing.body).error.code], [404, "not_found"]);
    const put = await send("PUT", "/api/v1/tasks");
    assert.equal(put.status, 501);
    assert.match(put.body, /Unsupported method \('PUT'\)/);
    const slash = await send("GET", "/api/v1/task-types/");
    assert.equal(JSON.parse(slash.body).ok, true);
  } finally {
    server.close();
  }
});

test("时间换算：库里的本地时刻与会话的世界时都换成本机时区的 ISO 8601，精确到秒", () => {
  const local = clock.fromLocalText("2026-09-21T18:56:34.219")!;
  assert.match(local, /^2026-09-21T18:56:34[+-]\d{2}:\d{2}$/);
  const utc = clock.fromUtcIso("2026-09-22T01:56:44.120Z")!;
  assert.equal(new Date(utc).getTime(), Date.parse("2026-09-22T01:56:44Z"));
  assert.equal(clock.fromLocalText(null), null);
  assert.equal(clock.fromLocalText("不是时刻"), "不是时刻");
  assert.equal(clock.parseUtcIso("2026-09-22T01:00:12.000Z")! - clock.parseUtcIso("2026-09-22T01:00:00.000Z")!, 12);
  const second = 1758499999n * 1000000000n;
  assert.equal(clock.fromEpochNs(second + 999999499n), clock.fromEpochNs(second), "差不到半微秒时舍去，留在这一秒");
  assert.equal(clock.fromEpochNs(second + 999999600n), clock.fromEpochNs(second + 1000000000n), "取到微秒时进位到下一秒");
});
