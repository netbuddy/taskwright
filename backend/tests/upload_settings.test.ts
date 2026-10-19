/**
 * 上传上限可以在设置页改：任务材料与知识库文档单个文件各一个上限（MB），没有设过时是 10 MB 与 20 MB，最多 50 MB，存在设置文件顶层的
 * uploads 里，下一次上传就按新的算，服务信息随之给新的上限。收文件的请求体边收边写临时文件，收到的超过上限就停下拒绝；
 * 页面上一次选几份文件时，几个请求同时到，各自存下。
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { makeServer, serviceInfo } from "../src/http.ts";
import { ENV_SETTINGS_FILE, readUploadLimits } from "../src/product_settings.ts";
import { Service } from "../src/service.ts";
import { captureConsole, tempDir } from "./helpers.ts";

// 本文件在测试进程里运行会写日志的后端代码，日志收进内存，不写标准输出（原因见 helpers.ts 的 captureConsole）。
captureConsole();

const tmp = tempDir();
const settings = join(tmp, "settings.json");
const was = process.env[ENV_SETTINGS_FILE];
process.env[ENV_SETTINGS_FILE] = settings;
after(() => {
  if (was === undefined) delete process.env[ENV_SETTINGS_FILE];
  else process.env[ENV_SETTINGS_FILE] = was;
  rmSync(tmp, { recursive: true, force: true });
});
let n = 0;
function fresh(): Service {
  rmSync(settings, { force: true });
  const root = join(tmp, `case-${++n}`);
  return new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1, knowledgeDir: join(root, "knowledge") });
}

const MB = 1024 * 1024;

async function listening(service: Service) {
  const server = makeServer(service).listen(0, "127.0.0.1");
  await new Promise((ok) => server.once("listening", ok));
  return { server, port: (server.address() as AddressInfo).port };
}

/** 发一个请求。chunked 为真时不写长度，请求体分成 1 MB 一块发；回答之后连接是否被关掉记在 closed 里。 */
function send(port: number, method: string, path: string, body: Buffer | null, headers: Record<string, string> = {}, chunked = false) {
  return new Promise<{ status: number; json: any; closed: boolean }>((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...headers, ...(body && !chunked ? { "Content-Length": String(body.length) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf-8")), closed: res.headers.connection === "close" }));
    });
    // 服务拒绝之后关掉连接时，还在写的请求体会报错：那是预期的，回答已经收到了。
    req.on("error", (error) => { if (!req.writableEnded) return; fail(error); });
    if (body && chunked) {
      for (let at = 0; at < body.length; at += MB) req.write(body.subarray(at, at + MB));
      req.end();
    } else req.end(body ?? undefined);
  });
}

const json = (value: unknown) => ({ body: Buffer.from(JSON.stringify(value)), headers: { "Content-Type": "application/json" } });

function multipart(name: string, data: Buffer, fields: Record<string, string> = {}) {
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--B\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  const body = Buffer.concat([...parts, Buffer.from(`--B\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n`), data, Buffer.from("\r\n--B--\r\n")]);
  return { body, headers: { "Content-Type": "multipart/form-data; boundary=B" } };
}

test("没有设过时材料 10 MB、知识库文档 20 MB；设置文件里某个值不是 1 到 50 的整数时，那一个用缺省值", async () => {
  const service = fresh();
  try {
    assert.deepEqual(readUploadLimits(), { material_mb: 10, knowledge_mb: 20 });
    const info = serviceInfo(service);
    assert.deepEqual([info.upload.max_bytes, info.upload.too_large_text], [10 * MB, "单个文件不能超过 10 MB。"]);
    assert.deepEqual([info.knowledge_upload!.max_bytes, info.knowledge_upload!.too_large_text], [20 * MB, "单个文件不能超过 20 MB。"]);
    for (const [material, knowledge, expected] of [[51, 3, { material_mb: 10, knowledge_mb: 3 }], [0, 2.5, { material_mb: 10, knowledge_mb: 20 }], ["7", 50, { material_mb: 10, knowledge_mb: 50 }]] as const) {
      writeFileSync(settings, JSON.stringify({ version: 2, uploads: { material_mb: material, knowledge_mb: knowledge } }));
      assert.deepEqual(readUploadLimits(), expected, JSON.stringify([material, knowledge]));
    }
  } finally {
    await service.close();
  }
});

test("经 HTTP：GET 给现在的上限、最大能设多少与缺省值；POST 只收 1 到 50 的整数，存进设置文件顶层的 uploads，别的键原样留着，服务信息随即给新的上限", async () => {
  const service = fresh();
  const { server, port } = await listening(service);
  try {
    writeFileSync(settings, JSON.stringify({ version: 2, debug: { prompt_dir: "/p" } }));
    const view = await send(port, "GET", "/api/v1/settings/uploads", null);
    assert.deepEqual(view.json, { ok: true, material_mb: 10, knowledge_mb: 20, cap_mb: 50, defaults: { material_mb: 10, knowledge_mb: 20 } });
    for (const bad of [{ material_mb: 0, knowledge_mb: 20 }, { material_mb: 51, knowledge_mb: 20 }, { material_mb: 10, knowledge_mb: 2.5 }, { material_mb: 10, knowledge_mb: "3" }, { material_mb: 10 }]) {
      const r = await send(port, "POST", "/api/v1/settings/uploads", json(bad).body, json(bad).headers);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.json.error.code, "bad_request");
      assert.match(r.json.error.message, /要写 1 到 50 的整数。$/);
    }
    assert.equal(JSON.parse(readFileSync(settings, "utf-8")).uploads, undefined, "被拒绝的都没有写文件");
    const set = await send(port, "POST", "/api/v1/settings/uploads", json({ material_mb: 3, knowledge_mb: 50 }).body, json({}).headers);
    assert.deepEqual(set.json, { ok: true, material_mb: 3, knowledge_mb: 50, cap_mb: 50, defaults: { material_mb: 10, knowledge_mb: 20 } });
    const file = JSON.parse(readFileSync(settings, "utf-8"));
    assert.deepEqual([file.uploads, file.debug], [{ material_mb: 3, knowledge_mb: 50 }, { prompt_dir: "/p" }]);
    const info = (await send(port, "GET", "/api/v1/service", null)).json;
    assert.deepEqual([info.upload.max_bytes, info.upload.too_large_text], [3 * MB, "单个文件不能超过 3 MB。"]);
    assert.deepEqual([info.knowledge_upload.max_bytes, info.knowledge_upload.too_large_text], [50 * MB, "单个文件不能超过 50 MB。"]);
  } finally {
    server.closeAllConnections();
    server.close();
    await service.close();
  }
});

test("改小上限之后，超过的材料与知识库文档以新上限的那句话拒绝；不写长度、分块发来的请求体收到超过上限就停下拒绝并关掉连接，正好到上限的照常存下", async () => {
  const service = fresh();
  const { server, port } = await listening(service);
  try {
    await send(port, "POST", "/api/v1/settings/uploads", json({ material_mb: 1, knowledge_mb: 2 }).body, json({}).headers);
    const { task_id: taskId } = service.create({ task_type: "requirements-engineering" });
    const t = service.task(taskId);
    assert.throws(() => service.upload(t, "大.md", Buffer.alloc(MB + 1, 0x41)), (e: unknown) => e instanceof ApiError && e.code === "too_large" && e.message === "单个文件不能超过 1 MB。");

    // 写了长度、而且超过上限加包装：一字不收就拒绝。
    const declared = await send(port, "POST", `/api/v1/tasks/${taskId}/materials`, Buffer.alloc(2 * MB), { "Content-Type": "multipart/form-data; boundary=B" });
    assert.deepEqual([declared.status, declared.json.error.code, declared.json.error.message, declared.closed], [413, "too_large", "单个文件不能超过 1 MB。", true]);
    // 不写长度：收到超过上限加包装时停下拒绝。
    const streamed = multipart("大.md", Buffer.alloc(3 * MB, 0x41));
    const big = await send(port, "POST", `/api/v1/tasks/${taskId}/materials`, streamed.body, streamed.headers, true);
    assert.deepEqual([big.status, big.json.error.message, big.closed], [413, "单个文件不能超过 1 MB。", true]);
    // 文件超过上限、但请求体没有超过上限加包装：由处理函数按同一个上限拒绝。
    const over = multipart("略大.md", Buffer.alloc(MB + 1, 0x41));
    const slightly = await send(port, "POST", `/api/v1/tasks/${taskId}/materials`, over.body, over.headers, true);
    assert.deepEqual([slightly.status, slightly.json.error.message], [413, "单个文件不能超过 1 MB。"]);
    // 正好到上限、不写长度分块发来：照常存下，存的就是发来的字节。
    const exact = multipart("正好.md", Buffer.alloc(MB, 0x42));
    const ok = await send(port, "POST", `/api/v1/tasks/${taskId}/materials`, exact.body, exact.headers, true);
    assert.deepEqual([ok.status, ok.json.path], [200, "inputs/正好.md"]);
    assert.equal(readFileSync(service.materialPath(t, "inputs/正好.md")).equals(Buffer.alloc(MB, 0x42)), true);

    const lib = (await send(port, "POST", "/api/v1/knowledge/libraries", json({ name: "规范" }).body, json({}).headers)).json.library.id;
    const doc = multipart("规范.md", Buffer.alloc(3 * MB, 0x41), { kind: "standard" });
    const refused = await send(port, "POST", `/api/v1/knowledge/libraries/${lib}/documents`, doc.body, doc.headers, true);
    assert.deepEqual([refused.status, refused.json.error.message, refused.closed], [413, "单个文件不能超过 2 MB。", true]);
    const missing = await send(port, "POST", "/api/v1/knowledge/libraries/lib-none/documents", doc.body, doc.headers);
    assert.deepEqual([missing.status, missing.json.error.code], [404, "not_found"]);
    const small = multipart("规范.md", Buffer.from("# 规范\n\n第一条。\n"), { kind: "standard" });
    assert.equal((await send(port, "POST", `/api/v1/knowledge/libraries/${lib}/documents`, small.body, small.headers)).status, 200);
  } finally {
    server.closeAllConnections();
    server.close();
    await service.close();
  }
});

test("一次选了三份材料：三个上传请求同时到，三份都存下", async () => {
  const service = fresh();
  const { server, port } = await listening(service);
  try {
    const { task_id: taskId } = service.create({ task_type: "requirements-engineering" });
    const replies = await Promise.all(["甲.md", "乙.md", "丙.md"].map((name) => {
      const one = multipart(name, Buffer.from(`${name} 的内容。`));
      return send(port, "POST", `/api/v1/tasks/${taskId}/materials`, one.body, one.headers);
    }));
    assert.deepEqual(replies.map((r) => [r.status, r.json.path]), [[200, "inputs/甲.md"], [200, "inputs/乙.md"], [200, "inputs/丙.md"]]);
    const t = service.task(taskId);
    assert.deepEqual(["甲.md", "乙.md", "丙.md"].map((name) => readFileSync(service.materialPath(t, `inputs/${name}`), "utf-8")), ["甲.md 的内容。", "乙.md 的内容。", "丙.md 的内容。"]);
  } finally {
    server.closeAllConnections();
    server.close();
    await service.close();
  }
});
