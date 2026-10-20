/**
 * 拼不成系统提示时停下这次运行（agent/src/hooks/stage_prompt.ts）：用真的后端进程与真的 pi（模型换成假端点）走一遍。
 * 任务目录里活动的声明写坏了，用户说一句话：模型一次也没有被调用，会话里留下一条说明拼不成、原因是什么的系统说明；改好之后再说一句照常运行。
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { NO_PI, withStack } from "./consent_stack.ts";
import { captureConsole, tempDir } from "./helpers.ts";

captureConsole();
process.env.PI_OFFLINE = "1";

const tmp = tempDir();
after(() => rmSync(tmp, { recursive: true, force: true }));

type Dict = Record<string, any>;
const SCRIPT = { default: { tool_calls: [{ name: "reply", arguments: { informs: [], act: null, text: "好的。" } }] } };

test("活动的声明写坏了：这次运行停下，模型一次也没有被调用，会话里有一条拼不成的系统说明；改回去之后照常运行", { skip: NO_PI, timeout: 60000 }, async () => {
  await withStack(tmp, "compose-failure", SCRIPT, async ({ call, taskId, session, dir, requests, send }) => {
    const file = join(dir, "tasks", taskId, ".pi", "skills", "requirements-engineering", "activities", "reading.md");
    const good = readFileSync(file, "utf-8");
    writeFileSync(file, good.replace(/^mode: .*$/m, "mode: 乱写"), "utf-8");
    await send({ text: "你好。", client_id: "c-1" });
    assert.equal(requests().length, 0, "拼不成时不调用模型");
    const notes = ((await call("GET", `/api/v1/tasks/${taskId}/conversation?session=${session}`)).body.messages as Dict[])
      .filter((one) => one.type === "system_note" && one.kind === "stage_prompt_error");
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /mode/);

    // 改回去：下一句照常拼、照常调用模型。
    writeFileSync(file, good, "utf-8");
    await send({ text: "再来一句。", client_id: "c-2" });
    assert.ok(requests().length > 0, "改好之后照常运行");
  });
});
