/**
 * 上传上限对外给出：服务信息接口的 upload 一项写上限（字节）与超过时的那句话，与后端拒绝过大上传时用的是同一份常量，
 * 前端据此在发送之前拦下过大的文件；类型不符时的那句话也经服务信息给出，与后端拒绝类型不符的上传时用的是同一个函数。
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ApiError } from "../src/errors.ts";
import { serviceInfo } from "../src/http.ts";
import { MAX_UPLOAD, Service, TOO_LARGE_TEXT, unsupportedTypeText } from "../src/service.ts";
import { captureConsole, tempDir } from "./helpers.ts";

// 本文件在测试进程里运行会写日志的后端代码，日志收进内存，不写标准输出（原因见 helpers.ts 的 captureConsole）。
captureConsole();

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

test("服务信息的 upload：上限 5 MB、「单个文件不能超过 5 MB。」、允许的扩展名与类型不符时的那句话，两种运行形态都给；上传超过上限时报的也是这句话", async () => {
  for (const mode of ["server", "desktop"] as const) {
    const service = new Service(join(tmp, `t-${mode}`), join(tmp, `r-${mode}`), {}, { port: 1, mode });
    try {
      assert.deepEqual(serviceInfo(service).upload, { max_bytes: 5 * 1024 * 1024, too_large_text: "单个文件不能超过 5 MB。", extensions: [".md", ".txt", ".docx"], unsupported_type_text: "只接受 .md、.txt 与 .docx（Word）三种文件。" });
    } finally {
      await service.close();
    }
  }
  const service = new Service(join(tmp, "tasks"), join(tmp, "runs"), {}, { port: 1 });
  try {
    const { task_id: taskId } = service.create({ task_type: "srs-authoring" });
    assert.throws(() => service.upload(service.task(taskId), "a.md", Buffer.alloc(MAX_UPLOAD + 1)),
      (error: unknown) => error instanceof ApiError && error.code === "too_large" && error.message === TOO_LARGE_TEXT);
  } finally {
    await service.close();
  }
});

test("上传类型不符的文件时报的那句话，与服务信息 upload.unsupported_type_text 给前端的是同一句", async () => {
  const service = new Service(join(tmp, "types"), join(tmp, "types-runs"), {}, { port: 1 });
  try {
    const { task_id: taskId } = service.create({ task_type: "srs-authoring" });
    assert.equal(serviceInfo(service).upload.unsupported_type_text, unsupportedTypeText());
    for (const name of ["图.png", "说明.pdf", "没有扩展名"]) {
      assert.throws(() => service.upload(service.task(taskId), name, Buffer.from("x")),
        (error: unknown) => error instanceof ApiError && error.code === "unsupported_type" && error.message === unsupportedTypeText(), name);
    }
  } finally {
    await service.close();
  }
});
