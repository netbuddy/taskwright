/**
 * 上传材料不允许重复与重名：同一个任务之内，内容（原始字节的 SHA-256）与已有的某份材料相同就拒绝，并指出是哪一份；
 * 文件名相同而内容不同也拒绝，要求换名；不再自动存成「原名-2」。只与用户放进来的材料比，投影、分段清单这些派生文件不算。
 * 先比内容再比文件名；被拒绝时什么都不留下、不发「新加了材料」的事件；不同任务互不影响；两个请求同时上传同一份文件时只存下一份。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { makeServer } from "../src/http.ts";
import { Service, duplicateContentText, nameTakenText, sameMaterialName } from "../src/service.ts";
import { ROOT, captureConsole, tempDir } from "./helpers.ts";

// 本文件在测试进程里运行会写日志的后端代码，日志收进内存，不写标准输出（原因见 helpers.ts 的 captureConsole）。
captureConsole();

const SAMPLE = join(ROOT, "examples", "library-lending", "requirements-styled.docx");
const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(tmp, `case-${++n}`);

function rejected(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("没有被拒绝");
}

async function withTask(body: (service: Service, t: ReturnType<Service["task"]>) => Promise<void> | void) {
  const root = fresh();
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1 });
  try {
    const t = service.task(service.create({ task_type: "srs-authoring", task_name: "去重" }).task_id);
    await body(service, t);
  } finally {
    await service.close();
  }
}

const files = (t: { dir: string }) => readdirSync(join(t.dir, "inputs")).sort();

test("内容相同、文件名相同：拒绝，说明与附带信息指出已有的那一份", () => withTask((service, t) => {
  service.upload(t, "需求.md", Buffer.from("买家可以申请退货。"));
  const e = rejected(() => service.upload(t, "需求.md", Buffer.from("买家可以申请退货。")));
  assert.deepEqual([e.code, e.status, e.message, e.data], ["duplicate_content", 409, "这份文件与已有的材料《需求.md》内容完全相同，没有重复保存。", { path: "inputs/需求.md" }]);
  assert.deepEqual(files(t), ["需求.md"]);
}));

test("内容相同、文件名不同：拒绝，指出内容相同的那一份", () => withTask((service, t) => {
  service.upload(t, "需求.md", Buffer.from("买家可以申请退货。"));
  const e = rejected(() => service.upload(t, "需求（副本）.txt", Buffer.from("买家可以申请退货。")));
  assert.deepEqual([e.code, e.message, e.data], ["duplicate_content", duplicateContentText("需求.md"), { path: "inputs/需求.md" }]);
  assert.deepEqual(files(t), ["需求.md"]);
}));

test("文件名相同、内容不同：拒绝，要求换名；不再存成「原名-2」", () => withTask((service, t) => {
  service.upload(t, "需求.md", Buffer.from("甲"));
  const e = rejected(() => service.upload(t, "需求.md", Buffer.from("乙")));
  assert.deepEqual([e.code, e.status, e.message, e.data], ["name_taken", 409, "这个任务里已经有一份叫《需求.md》的材料，内容与这份不同。请给文件换一个名字再上传。", { path: "inputs/需求.md" }]);
  assert.equal(readFileSync(join(t.dir, "inputs", "需求.md"), "utf-8"), "甲", "已有的材料没有被覆盖");
  assert.deepEqual(files(t), ["需求.md"]);
}));

test("文件名不同、内容不同：照常保存", () => withTask((service, t) => {
  service.upload(t, "甲.md", Buffer.from("甲"));
  assert.deepEqual(service.upload(t, "乙.md", Buffer.from("乙")), { ok: true, path: "inputs/乙.md" });
  assert.deepEqual(files(t), ["乙.md", "甲.md"]);
}));

test("与派生文件（Word 材料的投影）内容恰好相同：不拒绝", () => withTask((service, t) => {
  service.upload(t, "需求.docx", readFileSync(SAMPLE));
  const projection = readFileSync(join(t.dir, "inputs", "需求.docx.md"));
  assert.equal(service.upload(t, "投影的副本.md", projection).path, "inputs/投影的副本.md");
}));

test("Word 材料被拒绝时不留下投影、图片目录与分段清单", () => withTask((service, t) => {
  service.upload(t, "需求.docx", readFileSync(SAMPLE));
  const before = files(t);
  assert.equal(rejected(() => service.upload(t, "别名.docx", readFileSync(SAMPLE))).code, "duplicate_content");
  assert.deepEqual(files(t), before);
  assert.equal(existsSync(join(t.dir, "inputs", "别名.docx.media")), false);
}));

test("被拒绝时不发「新加了材料」的事件；保存成功时发一条", () => withTask((service, t) => {
  const [sub] = t.hub.subscribe(null, null);
  const added = async () => {
    let count = 0;
    for (let item = await sub.get(10); item; item = await sub.get(10)) if (item[0] === "material_added") count += 1;
    return count;
  };
  return (async () => {
    service.upload(t, "需求.md", Buffer.from("甲"));
    assert.equal(await added(), 1);
    rejected(() => service.upload(t, "需求.md", Buffer.from("甲")));
    rejected(() => service.upload(t, "需求.md", Buffer.from("乙")));
    assert.equal(await added(), 0);
  })();
}));

test("不同任务各自上传同一份文件，互不影响", async () => {
  const root = fresh();
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1 });
  try {
    const a = service.task(service.create({ task_type: "srs-authoring", task_name: "甲任务" }).task_id);
    const b = service.task(service.create({ task_type: "srs-authoring", task_name: "乙任务" }).task_id);
    assert.equal(service.upload(a, "需求.md", Buffer.from("同一份")).path, "inputs/需求.md");
    assert.equal(service.upload(b, "需求.md", Buffer.from("同一份")).path, "inputs/需求.md");
  } finally {
    await service.close();
  }
});

test("最后一道防线：文件系统上已经有这个名字（材料清单不列的目录也算），用排他创建写入，按同名拒绝，不覆盖", () => withTask((service, t) => {
  mkdirSync(join(t.dir, "inputs", "占位.md"));
  const e = rejected(() => service.upload(t, "占位.md", Buffer.from("x")));
  assert.deepEqual([e.code, e.message, e.data], ["name_taken", nameTakenText("占位.md"), { path: "inputs/占位.md" }]);
  assert.ok(statSync(join(t.dir, "inputs", "占位.md")).isDirectory());
}));

test("同名的判断：只差大小写、同一个字的两种编码、首尾空白都算同名；只差全角半角不算", () => {
  assert.equal(sameMaterialName("需求.md", "需求.md"), true);
  // 大小写：与区域设置无关；希腊字母词尾的 ς 与大写 Σ、德文 ß 与 SS 也对得上。
  assert.equal(sameMaterialName("Spec.docx", "spec.docx"), true);
  assert.equal(sameMaterialName("REPORT.MD", "report.md"), true);
  assert.equal(sameMaterialName("ΟΔΟΣ.md", "οδος.md"), true);
  assert.equal(sameMaterialName("Straße.md", "STRASSE.md"), true);
  // 同一个字的两种编码：e 加组合用的尖音符（macOS 存文件名的写法）与预组合的 é。
  assert.equal(sameMaterialName("Cafe\u0301.md", "Caf\u00e9.md"), true);
  assert.equal(sameMaterialName("CAFE\u0301.md", "caf\u00e9.md"), true, "编码与大小写同时不同");
  // 首尾空白：半角空格、制表符、全角空格都去掉；中间的空白照常比较。
  assert.equal(sameMaterialName("  需求.md\t", "需求.md"), true);
  assert.equal(sameMaterialName("\u3000需求.md", "需求.md"), true);
  assert.equal(sameMaterialName("需 求.md", "需求.md"), false);
  // 全角半角：括号、字母、数字只差全角半角都不算同名。
  assert.equal(sameMaterialName("需求(一).md", "需求（一）.md"), false);
  assert.equal(sameMaterialName("ＡＢ.md", "ab.md"), false);
  assert.equal(sameMaterialName("第1版.md", "第１版.md"), false);
  // 真正不同的名字。
  assert.equal(sameMaterialName("需求.md", "需求.txt"), false);
  assert.equal(sameMaterialName("甲.md", "乙.md"), false);
});

test("只差大小写、内容不同：按同名拒绝，指出已有的那一份，已有的材料不变", () => withTask((service, t) => {
  service.upload(t, "Spec.md", Buffer.from("甲"));
  const e = rejected(() => service.upload(t, "spec.md", Buffer.from("乙")));
  assert.deepEqual([e.code, e.message, e.data], ["name_taken", nameTakenText("Spec.md"), { path: "inputs/Spec.md" }]);
  assert.equal(readFileSync(join(t.dir, "inputs", "Spec.md"), "utf-8"), "甲");
  assert.deepEqual(files(t), ["Spec.md"]);
}));

test("同一个字的两种编码、内容不同：按同名拒绝", () => withTask((service, t) => {
  service.upload(t, "Caf\u00e9.md", Buffer.from("甲"));
  const e = rejected(() => service.upload(t, "Cafe\u0301.md", Buffer.from("乙")));
  assert.deepEqual([e.code, e.data], ["name_taken", { path: "inputs/Caf\u00e9.md" }]);
  assert.deepEqual(files(t), ["Caf\u00e9.md"]);
}));

test("首尾带空白、内容不同：按同名拒绝；保存时的名字不因这条规则改变", () => withTask((service, t) => {
  // 末尾带空白的名字（「需求.md 」）过不了类型检查（扩展名要在最后），实际能碰到的是首部带空白。
  assert.equal(service.upload(t, " 需求.md", Buffer.from("甲")).path, "inputs/ 需求.md", "保存时照原名，首部的空格也留着");
  const e = rejected(() => service.upload(t, "需求.md", Buffer.from("乙")));
  assert.deepEqual([e.code, e.message, e.data], ["name_taken", nameTakenText(" 需求.md"), { path: "inputs/ 需求.md" }]);
  assert.equal(rejected(() => service.upload(t, "\u3000\t需求.md", Buffer.from("丙"))).code, "name_taken", "全角空格与制表符也去掉");
  assert.equal(rejected(() => service.upload(t, "需求.md ", Buffer.from("丁"))).code, "unsupported_type");
  assert.deepEqual(files(t), [" 需求.md"]);
}));

test("只差全角半角、内容不同：不算同名，照常保存", () => withTask((service, t) => {
  service.upload(t, "需求(一).md", Buffer.from("甲"));
  assert.deepEqual(service.upload(t, "需求（一）.md", Buffer.from("乙")), { ok: true, path: "inputs/需求（一）.md" });
  assert.deepEqual(files(t), ["需求(一).md", "需求（一）.md"]);
}));

test("只差大小写、内容也相同：报内容相同（先比内容再比文件名）", () => withTask((service, t) => {
  service.upload(t, "Spec.md", Buffer.from("甲"));
  assert.equal(rejected(() => service.upload(t, "SPEC.md", Buffer.from("甲"))).code, "duplicate_content");
}));

/** 经 HTTP 上传一份文件，返回状态码与应答。 */
function post(port: number, taskId: string, name: string, text: string): Promise<{ status: number; body: any }> {
  const body = Buffer.from(`--B\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n${text}\r\n--B--\r\n`, "utf-8");
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path: `/api/v1/tasks/${taskId}/materials`, method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=B", "Content-Length": body.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

test("并发：两个请求同时上传同一份文件只存下一份；同时上传同名不同内容也只存下一份", async () => {
  const root = fresh();
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1 });
  const server = makeServer(service);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  try {
    const taskId = service.create({ task_type: "srs-authoring", task_name: "并发" }).task_id;
    const t = service.task(taskId);
    for (let round = 0; round < 5; round++) {
      const same = await Promise.all([post(port, taskId, `同一份${round}.md`, `内容${round}`), post(port, taskId, `同一份${round}.md`, `内容${round}`),
        post(port, taskId, `另一个名字${round}.md`, `内容${round}`)]);
      assert.deepEqual(same.map((r) => r.status).sort(), [200, 409, 409], `第 ${round} 轮`);
      assert.ok(same.filter((r) => r.status === 409).every((r) => r.body.error.code === "duplicate_content"));
      const clash = await Promise.all([post(port, taskId, `同名${round}.md`, `甲${round}`), post(port, taskId, `同名${round}.md`, `乙${round}`)]);
      assert.deepEqual(clash.map((r) => r.status).sort(), [200, 409]);
      assert.equal(clash.find((r) => r.status === 409)!.body.error.code, "name_taken");
    }
    assert.equal(files(t).length, 10, "每轮一份内容、一份同名，共十份");
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    await service.close();
  }
});

test("经 HTTP：同名同内容报内容相同（duplicate_content）；同名不同内容报 name_taken，已有文件的字节不变", async () => {
  const root = fresh();
  const service = new Service(join(root, "tasks"), join(root, "runs"), {}, { port: 1 });
  const server = makeServer(service);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  try {
    const taskId = service.create({ task_type: "srs-authoring", task_name: "经 HTTP" }).task_id;
    const t = service.task(taskId);
    assert.equal((await post(port, taskId, "需求说明.md", "买家可以申请退货。")).status, 200);
    const before = readFileSync(join(t.dir, "inputs", "需求说明.md"));
    const same = await post(port, taskId, "需求说明.md", "买家可以申请退货。");
    assert.deepEqual([same.status, same.body.error.code, same.body.error.data], [409, "duplicate_content", { path: "inputs/需求说明.md" }]);
    const clash = await post(port, taskId, "需求说明.md", "买家不能申请退货。");
    assert.deepEqual([clash.status, clash.body.error.code, clash.body.error.message, clash.body.error.data],
      [409, "name_taken", nameTakenText("需求说明.md"), { path: "inputs/需求说明.md" }]);
    assert.deepEqual(readFileSync(join(t.dir, "inputs", "需求说明.md")), before, "已有文件的字节没有变");
    assert.deepEqual(files(t), ["需求说明.md"]);
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    await service.close();
  }
});
