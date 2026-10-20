/**
 * 两个扩展命令：/tw-user（用户在界面上的直接操作）与 /tw-ui（卡片上需要执行者再出力的点击）。
 *
 * 后端经 RPC 发一条以斜杠开头的 prompt，pi 发现是已登记的扩展命令，就不交给模型，直接在 pi 进程里运行
 * 这里的处理函数；执行者正在运行时也立即执行（已实测）。模型没有触发扩展命令的途径；用户打的以斜杠
 * 开头的字，后端会在前面加「用户说：」再发，所以也不会被当成命令。
 *
 * /tw-user <JSON>：参数形状见 docs/api.md 的「直接操作」一节，另加后端生成的 op_id。调用 lib/user_ops.ts，写完往会话里
 * 追加一条自定义消息（customType 为 taskwright-user-edit，正文用固定句式；打开详情写已读时正文为空，不追加），
 * notify_executor 为真的标为已读之后再用 sendUserMessage 发固定模板的那句话。结果经状态栏键 taskwright-user-result 回传：
 *   成功 {"op_id", "ok": true, "event_seqs", "results", "revision_no"}；
 *   拒绝 {"op_id", "ok": false, "error": {"code", "message", "data"}}。
 *
 * 例外是评审（kind 为 request_review）：核对通过、记下第一条进度事件就立即回报成功（results 是这批要评的条目），
 * 评审在后台接着跑（lib/review_ui.ts），不等它跑完，免得撞上后端等界面操作结果的 10 秒上限。每记一条进度事件，
 * 经状态栏键 taskwright-review 提示后端去查库转发；全部评完后往会话里追加一条 taskwright-user-edit 自定义消息，
 * 正文只有一句结论（几条合规、几条不合规，问题与建议各几条），details.review 带这几个数；逐条发现执行者经「查询任务状态」取，
 * 界面上看评审页签。不另外发话引出一次运行。点名的条目在当前修订、当前规则下已经评过时整批拒绝（同一次修订只评审一次）。
 * 另一个例外是改图（kind 为 edit_diagram）：用户在页面上改了一张图的 Mermaid 文本，写的是图自己的一次新修订，走 lib/user_diagram.ts；
 * 结果里 results 是 [{diagram_id, revision_no}]（图自己的修订号），revision_no 为 null，追加的那条自定义消息不可撤销。
 * 还有一个例外是停止（kind 为 stop_run）：用户在界面上停止了助手这一次运行，后端等运行停下之后发来。它不写库，只追加一条
 * taskwright-user-edit 自定义消息（正文是 lib/user_ops.ts 的 STOP_RUN_NOTE），助手下一次运行时据此知道上一次没有做完。
 * 还有一个例外是「继续本阶段」（kind 为 continue_stage）：用户在提议进入下一个阶段的卡片上选了留在这一段。它也不写库，只追加一条
 * taskwright-user-edit 自定义消息（lib/user_stage.ts），不发话、不引出运行；details 里带卡片所在回复的编号，页面据此把卡片显示为已选。
 * 状态栏是给后端读的，交互模式下只显示成底部一行截短的 JSON；所以交互模式里被拒时另外用 notify 把完整的拒绝原因
 * 发给人看（rejectionText），RPC 模式不发，后端照旧只读状态栏。
 *
 * /tw-ui <JSON>：{"op_id", "reply_entry", "option_key", "option_text", "text"}。先追加 taskwright-ui-click 自定义消息
 * （标注点的是哪条回复的哪个选项），再 sendUserMessage 模板句；两条都传 deliverAs: "followUp"，执行者空闲时
 * 立即生效，正在运行时排到这次运行本该停下的时候，两条紧挨着并入（排队模式为 all，见任务目录的 .pi/settings.json）。
 * 结果经状态栏键 taskwright-ui-result 回传。
 * 点的是助手提议转移的那张卡片上生效的那一项时（选项键 next_step、goto:<活动标识符>，早先的 enter_clarify、start_items 之类照样认），
 * 在发这两条之前先替用户记一次移动（lib/stage_read.ts 的 recordStageCardClick）；记下了的话，结果里的 stage_event_seq 是那条事件的序号，
 * 后端据此去查库转发。
 * option_key 是 typed 时不是点击：用户在那张卡片的文本框里打了一句话。这时追加的是 taskwright-card-typed 自定义消息
 * （文字见 lib/dialogue_acts.ts 的 cardTypedNotice：卡片还开着时写明它的行为编号），不替用户移动阶段，随后照样 sendUserMessage 用户的原话；
 * 这句话不算点击，助手照常要写理解。
 *
 * 处理函数里的写库是同步的（node:sqlite），从开事务到提交之间没有 await，与工具的执行函数不会交错。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { REVIEW_OP_KIND, STOP_RUN_KIND, STOP_RUN_NOTE, UserOpError, checkReviewRequest, runUserOperation, stopRunDetails } from "../lib/user_ops.ts";
import { ReviewError } from "../lib/review.ts";
import { piComplete, startReview } from "../lib/review_ui.ts";
import { batchCounts } from "../lib/review_run.ts";
import { DIAGRAM_OP_KIND, DIAGRAM_VIEW_OP_KIND, editDiagram, markDiagramViewed } from "../lib/user_diagram.ts";
import { recordStageCardClick } from "../lib/stage_read.ts";
import { CONTINUE_STAGE_KIND, continueStage } from "../lib/user_stage.ts";
import { CARD_TYPED_KEY, CARD_TYPED_TYPE, cardTypedNotice } from "../lib/dialogue_acts.ts";
import { fillText } from "../lib/texts.ts";

export const USER_COMMAND = "tw-user";
export const UI_COMMAND = "tw-ui";
export const USER_RESULT_KEY = "taskwright-user-result";
export const UI_RESULT_KEY = "taskwright-ui-result";
export const USER_EDIT_CUSTOM_TYPE = "taskwright-user-edit";
export const UI_CLICK_CUSTOM_TYPE = "taskwright-ui-click";
/** 界面发起的评审每记一条事件，经这个状态栏键提示后端去查库。 */
export const REVIEW_STATUS_KEY = "taskwright-review";

function parse(args: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(args);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** 给人看的拒绝原因：错误码、完整的说明，data.reasons 里还有别的原因就逐条列出。 */
export function rejectionText(error: { code: string; message: string; data?: unknown }): string {
  const lines = [`/tw-user 没有执行（${error.code}）：${error.message}`];
  const reasons = (error.data as { reasons?: unknown } | undefined)?.reasons;
  if (Array.isArray(reasons)) {
    for (const reason of reasons) if (typeof reason === "string" && reason !== error.message) lines.push(`- ${reason}`);
  }
  return lines.join("\n");
}

export function registerUserCommands(pi: ExtensionAPI): void {
  pi.registerCommand(USER_COMMAND, {
    description: "用户在界面上的直接操作（由后端发，不经模型写库）。",
    handler: async (args, ctx) => {
      const request = parse(args);
      const opId = request && typeof request.op_id === "string" ? request.op_id : null;
      const report = (value: Record<string, unknown>) => {
        ctx.ui.setStatus(USER_RESULT_KEY, JSON.stringify({ op_id: opId, ...value }));
        if (value.ok === false && ctx.mode === "tui") ctx.ui.notify(rejectionText(value.error as { code: string; message: string; data?: unknown }), "error");
      };
      if (!request) {
        report({ ok: false, error: { code: "bad_request", message: "/tw-user 的参数应当是一个 JSON 对象。", data: {} } });
        return;
      }
      if (request.kind === REVIEW_OP_KIND) {
        startUiReview(pi, ctx, request, opId, report);
        return;
      }
      if (request.kind === STOP_RUN_KIND) {
        // 用户在界面上停止了这一次运行：后端在运行停下之后发来，这里只留一条通知，不写库。
        pi.sendMessage({ customType: USER_EDIT_CUSTOM_TYPE, content: STOP_RUN_NOTE, display: true, details: stopRunDetails(opId) });
        report({ ok: true, event_seqs: [], results: [], revision_no: null });
        return;
      }
      if (request.kind === CONTINUE_STAGE_KIND) {
        // 用户在进入卡片上选了「继续本阶段」：只留一条通知，不写库、不发话，提议仍然开着。
        try {
          const result = continueStage({ workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }, ctx.sessionManager.getBranch() as never, request);
          pi.sendMessage({
            customType: USER_EDIT_CUSTOM_TYPE,
            content: result.note,
            display: true,
            details: { op_id: result.op_id, kind: result.kind, event_seqs: [], results: [], revision_no: null, undoable: false,
              reply_entry: result.reply_entry, option_key: result.option_key, stage: result.stage },
          });
          report({ ok: true, event_seqs: [], results: [], revision_no: null });
        } catch (error) {
          if (error instanceof UserOpError) report({ ok: false, error: { code: error.code, message: error.message, data: error.data } });
          else report({ ok: false, error: { code: "rejected", message: (error as Error).message, data: { reasons: [(error as Error).message] } } });
        }
        return;
      }
      if (request.kind === DIAGRAM_VIEW_OP_KIND) {
        // 用户打开看了一张图：只记一条事件，不往会话里追加任何东西，不经 runUserOperation（lib/user_diagram.ts）。
        try {
          const result = markDiagramViewed({ workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }, request);
          report({ ok: true, event_seqs: result.event_seqs, results: result.results, revision_no: null });
        } catch (error) {
          if (error instanceof UserOpError) report({ ok: false, error: { code: error.code, message: error.message, data: error.data } });
          else report({ ok: false, error: { code: "rejected", message: (error as Error).message, data: { reasons: [(error as Error).message] } } });
        }
        return;
      }
      if (request.kind === DIAGRAM_OP_KIND) {
        // 用户改了一张图的 Mermaid 文本：写的是图自己的修订，不经 runUserOperation（lib/user_diagram.ts）。
        try {
          const result = await editDiagram({ workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }, request);
          pi.sendMessage({
            customType: USER_EDIT_CUSTOM_TYPE,
            content: result.note,
            display: true,
            details: { op_id: result.op_id, kind: result.kind, event_seqs: result.event_seqs, results: result.results, revision_no: null, undoable: false },
          });
          report({ ok: true, event_seqs: result.event_seqs, results: result.results, revision_no: null });
        } catch (error) {
          if (error instanceof UserOpError) report({ ok: false, error: { code: error.code, message: error.message, data: error.data } });
          else report({ ok: false, error: { code: "rejected", message: (error as Error).message, data: { reasons: [(error as Error).message] } } });
        }
        return;
      }
      try {
        const result = runUserOperation({ workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }, request);
        if (result.note) pi.sendMessage(
          {
            customType: USER_EDIT_CUSTOM_TYPE,
            content: result.note,
            display: true,
            details: {
              op_id: result.op_id,
              kind: result.kind,
              event_seqs: result.event_seqs,
              results: result.results,
              revision_no: result.revision_no,
              undoable: result.undoable,
              ...(result.record_id !== undefined ? { record_id: result.record_id } : {}),
              ...(result.archived_sessions !== undefined ? { archived_sessions: result.archived_sessions } : {}),
              ...(result.version_no !== undefined ? { version_no: result.version_no } : {}),
            },
          },
          // 不传送法：执行者空闲时立即加进会话；正在运行时 pi 暂存到这一轮结束再加（不能插在工具调用与结果之间），
          // 只作上下文，不另外引出一次模型请求。
        );
        if (result.notify_text) pi.sendUserMessage(result.notify_text, { deliverAs: "followUp" });
        report({ ok: true, event_seqs: result.event_seqs, results: result.results, revision_no: result.revision_no,
          ...(result.record_id !== undefined ? { activity_record_id: result.record_id } : {}),
          ...(result.archived_sessions !== undefined ? { archived_sessions: result.archived_sessions } : {}),
          ...(result.version_no !== undefined ? { version_no: result.version_no } : {}) });
      } catch (error) {
        if (error instanceof UserOpError) {
          report({ ok: false, error: { code: error.code, message: error.message, data: error.data } });
        } else {
          report({ ok: false, error: { code: "rejected", message: (error as Error).message, data: { reasons: [(error as Error).message] } } });
        }
      }
    },
  });

  pi.registerCommand(UI_COMMAND, {
    description: "卡片上需要执行者再出力的点击（由后端发）：先追加带标注的自定义消息，再发模板句。",
    handler: async (args, ctx) => {
      const request = parse(args);
      const opId = request && typeof request.op_id === "string" ? request.op_id : null;
      const text = request && typeof request.text === "string" ? request.text.trim() : "";
      if (!request || !text) {
        ctx.ui.setStatus(UI_RESULT_KEY, JSON.stringify({ op_id: opId, ok: false, error: { code: "bad_request", message: "/tw-ui 的参数要有 text。", data: {} } }));
        return;
      }
      // 用户在卡片的文本框里打的字：不是点击，只标明这句话写在哪张卡片里，再把原话发出去。
      if (request.option_key === CARD_TYPED_KEY) {
        const replyEntry = typeof request.reply_entry === "string" ? request.reply_entry : null;
        pi.sendMessage(
          {
            customType: CARD_TYPED_TYPE,
            content: cardTypedNotice(ctx.cwd, ctx.sessionManager.getSessionId(), replyEntry),
            display: true,
            details: { op_id: opId, reply_entry: replyEntry, text },
          },
          { deliverAs: "followUp" },
        );
        pi.sendUserMessage(text, { deliverAs: "followUp" });
        ctx.ui.setStatus(UI_RESULT_KEY, JSON.stringify({ op_id: opId, ok: true, idle: ctx.isIdle() }));
        return;
      }
      // 点的是「进入」某个阶段的选项：先替用户把任务移过去，再发下面两条，助手回应这次点击时从头就在新的阶段。
      let stageSeq: number | null = null;
      let stageMove: { from: string; to: string; how?: string } | null = null;
      let stageUnmoved: { at: string; why?: string; blocked?: string } | null = null;
      try {
        const moved = recordStageCardClick(ctx.cwd, ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch() as never,
          { opId: opId ?? "", replyEntry: request.reply_entry, optionKey: request.option_key });
        stageSeq = moved?.event_seq ?? null;
        // 记下了移动：标注里另写从哪个阶段到哪个阶段，对话区据此在用户那句话下面写一行。
        // how 写这次是流程里的换站（move）；早先的对话里另有启动首次分析（launch）与继续首次分析（resume）。
        if (moved?.moved && moved.from !== null) stageMove = { from: moved.from, to: moved.requested, ...(moved.how ? { how: moved.how } : {}) };
        // 认出了是进入某个阶段的卡片、任务也有阶段，但这次点击没有让阶段移动（次序不对，或者任务本来就在那里）：
        // 标注里写下任务当时在哪个阶段，卡片上据此告诉用户这次点击没有改变阶段。
        // 这条会话不在做流程的工作项时，进入与退回都不算数：另写 why 为 not_in_flow，卡片上据此提示从任务起点页启动一个工作项。
        // 要去的那一步的 requires 不满足（why 为 not_ready）：另写缺什么，卡片上照它告诉用户。
        else if (moved && !moved.moved && moved.from !== null) {
          stageUnmoved = { at: moved.from, ...(moved.why === "not_in_flow" || moved.why === "not_ready" ? { why: moved.why } : {}), ...(moved.blocked ? { blocked: moved.blocked } : {}) };
        }
      } catch (error) {
        ctx.ui.setStatus(UI_RESULT_KEY, JSON.stringify({ op_id: opId, ok: false,
          error: { code: "rejected", message: `没有能把任务移到下一个阶段：${(error as Error).message}`, data: {} } }));
        return;
      }
      const option = request.option_text ? `「${request.option_key ? `${request.option_key}. ` : ""}${request.option_text}」` : "";
      pi.sendMessage(
        {
          customType: UI_CLICK_CUSTOM_TYPE,
          content: option
            ? fillText("ui_ops.ui_click_option", { reply: String(request.reply_entry ?? ""), option })
            : fillText("ui_ops.ui_click_button", { reply: String(request.reply_entry ?? "") }),
          display: true,
          details: {
            op_id: opId,
            reply_entry: request.reply_entry ?? null,
            option_key: request.option_key ?? null,
            option_text: request.option_text ?? null,
            text,
            ...(stageSeq !== null ? { stage_event_seq: stageSeq } : {}),
            ...(stageMove !== null ? { stage_move: stageMove } : {}),
            ...(stageUnmoved !== null ? { stage_unmoved: stageUnmoved } : {}),
          },
        },
        { deliverAs: "followUp" },
      );
      pi.sendUserMessage(text, { deliverAs: "followUp" });
      ctx.ui.setStatus(UI_RESULT_KEY, JSON.stringify({ op_id: opId, ok: true, idle: ctx.isIdle(), ...(stageSeq !== null ? { stage_event_seq: stageSeq } : {}) }));
    },
  });
}

/**
 * 界面发起的评审：核对、开始，立即回报；评完之后往会话里追加结果。拒绝经 report 回传，错误码与其他直接操作一致
 * （核对不通过、上一批还没做完都是 rejected）。
 */
function startUiReview(pi: ExtensionAPI, ctx: ExtensionCommandContext, request: Record<string, unknown>, opId: string | null,
  report: (value: Record<string, unknown>) => void): void {
  const sessionId = ctx.sessionManager.getSessionId();
  const nudge = (value: Record<string, unknown>) => {
    try {
      ctx.ui.setStatus(REVIEW_STATUS_KEY, JSON.stringify({ op_id: opId, ...value }));
    } catch {
      // 会话已切换、界面不可用时只是少一次提示，后端每 2 秒的兜底轮询照样能查到新事件。
    }
  };
  let started;
  try {
    const requested = checkReviewRequest({ workspaceDir: ctx.cwd, sessionId }, request);
    const { model, complete } = piComplete(ctx, opId ?? "");
    started = startReview({ workspaceDir: ctx.cwd, sessionId, callId: opId ?? "" }, requested,
      { model, complete, onRecorded: (seq) => nudge({ event_seq: seq }) });
  } catch (error) {
    if (error instanceof UserOpError) report({ ok: false, error: { code: error.code, message: error.message, data: error.data } });
    else if (error instanceof ReviewError) report({ ok: false, error: { code: "rejected", message: error.message, data: { reasons: [error.message] } } });
    else report({ ok: false, error: { code: "rejected", message: (error as Error).message, data: { reasons: [(error as Error).message] } } });
    return;
  }
  report({ ok: true, event_seqs: [started.event_seq], results: started.items, revision_no: null });
  started.finished.then(({ outcome, event_seq, error }) => {
    const counts = outcome ? batchCounts(outcome.details.results) : null;
    const tally = counts && { passed: counts.passed, failed: counts.failed, problems: counts.problems, advice: counts.advice };
    const text = counts
      ? (counts.unfinished ? fillText("ui_ops.review_counts_unfinished", { ...tally!, unfinished: counts.unfinished }) : fillText("ui_ops.review_counts", tally!))
      : (error ?? fillText("ui_ops.review_not_finished"));
    // 会话里只追加一句结论；逐条发现不在这里，执行者要用时经「查询任务状态」去查，界面上看评审页签。
    pi.sendMessage({
      customType: USER_EDIT_CUSTOM_TYPE,
      content: fillText("ui_ops.review_done", { result: text }),
      display: true,
      details: { op_id: opId, kind: REVIEW_OP_KIND, event_seqs: event_seq >= 0 ? [event_seq] : [], results: started.items, revision_no: null, undoable: false,
        review: counts },
    });
    nudge({ finished: true, event_seq });
    if (ctx.mode === "tui") ctx.ui.notify(text, error ? "error" : "info");
  }).catch((e) => nudge({ finished: true, error: String((e as Error)?.message ?? e) }));
}
