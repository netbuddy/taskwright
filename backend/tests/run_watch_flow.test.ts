// 看门狗的整条链：真的后端进程与真的 pi，假端点照 P6 那一次的样子回答——工具参数先写一段正常的 JSON 开头，然后一连几千段空白。
// 看门狗在第 200 段空白时中止这一次运行：这一轮记为失败，会话里留一条说明原因的系统消息，任务库里没有新的修订，
// 运行状态帧推过「工具参数」这一段，最后一帧带着中止的原因。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { NO_PI, withStack } from "./consent_stack.ts";
import { sendAndWaitTurnEvents } from "./helpers.ts";

const tmp = mkdtempSync(join(tmpdir(), "taskwright-run-watch-"));
after(() => { if (!process.env.KEEP_RUN_WATCH_TMP) rmSync(tmp, { recursive: true, force: true }); });

const BLANK_REPLAY = {
  sequence: [{
    stream: {
      tool: { name: "save_revision", pieces: ['{"operations":[{"op":"update","item":"OA-001","fields":{"它是什么":"改写的正文"},"sources', '[{" ,"kind string? no JSON typo. Let\'s craft exact."'] },
      repeat: { piece: " \n", times: 3000 },
      interval_ms: 2,
    },
  }],
};

test("模型把工具参数写成一连串空白：看门狗在第 200 段空白时中止，这一轮记为失败，会话里留一条说明，任务库没有新的修订", { skip: NO_PI, timeout: 120_000 }, async () => {
  await withStack(tmp, "blank", BLANK_REPLAY, async ({ call, taskId, session, port, db }) => {
    const before = db("SELECT COUNT(*) AS n FROM event WHERE name = 'REVISION_SAVED'")[0].n;
    const events = await sendAndWaitTurnEvents(port, taskId, session, async () => {
      assert.equal((await call("POST", `/api/v1/tasks/${taskId}/messages?session=${session}`, { text: "改一下这一页。", client_id: "c-1", attachments: [] })).status, 200);
    });
    const ended = events.find((one) => one.event === "work_ended")!;
    assert.equal(ended.data.outcome, "failed");
    const frames = events.filter((one) => one.event === "run_status").map((one) => one.data);
    assert.ok(frames.some((one) => one.phase === "tool_args" && one.tool === "save_revision"), JSON.stringify(frames.slice(0, 5)));
    assert.equal(frames.at(-1)!.aborted, "连续输出了 200 段空白");
    // 只报一条中止的问题，不再报「没有说话就停下了」一类。
    assert.deepEqual(events.filter((one) => one.event === "problem").map((one) => one.data.code), ["model_output_aborted"]);
    // 会话里那条系统消息写进了会话之后，快照里能看到。
    let note: any = null;
    for (let i = 0; i < 50 && !note; i++) {
      const snap = (await call("GET", `/api/v1/tasks/${taskId}/snapshot?session=${session}`)).body;
      note = snap.conversation.messages.find((m: any) => m.type === "ui_action_noted" && m.kind === "output_aborted") ?? null;
      if (!note) await new Promise((ok) => setTimeout(ok, 200));
    }
    assert.ok(note, "会话里应当有一条中止的说明");
    assert.equal(note.text, "系统说明（不是用户打的字）：模型输出异常（连续输出了 200 段空白），这一步已中止，没有写入任何内容；发一句「继续」即可接着做。");
    assert.equal(db("SELECT COUNT(*) AS n FROM event WHERE name = 'REVISION_SAVED'")[0].n, before);
  }, { seed: true });
});
