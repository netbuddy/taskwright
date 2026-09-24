/**
 * 两个扩展命令：/tw-user（用户在界面上的直接操作）与 /tw-ui（卡片上需要执行者再出力的点击）。
 *
 * 后端经 RPC 发一条以斜杠开头的 prompt，pi 发现是已登记的扩展命令，就不交给模型，直接在 pi 进程里运行
 * 这里的处理函数；执行者正在运行时也立即执行（已实测）。模型没有触发扩展命令的途径；用户打的以斜杠
 * 开头的字，后端会在前面加「用户说：」再发，所以也不会被当成命令。
 *
 * /tw-user <JSON>：参数形状见 docs/api.md 的「直接操作」一节，另加后端生成的 op_id。调用 lib/user_ops.ts，写完往会话里
 * 追加一条自定义消息（customType 为 taskwright-user-edit，正文用固定句式），notify_executor 为真的确认之后再用
 * sendUserMessage 发固定模板的那句话。结果经状态栏键 taskwright-user-result 回传：
 *   成功 {"op_id", "ok": true, "event_seqs", "results", "revision_no"}；
 *   拒绝 {"op_id", "ok": false, "error": {"code", "message", "data"}}。
 * 状态栏是给后端读的，交互模式下只显示成底部一行截短的 JSON；所以交互模式里被拒时另外用 notify 把完整的拒绝原因
 * 发给人看（rejectionText），RPC 模式不发，后端照旧只读状态栏。
 *
 * /tw-ui <JSON>：{"op_id", "reply_entry", "option_key", "option_text", "text"}。先追加 taskwright-ui-click 自定义消息
 * （标注点的是哪条回复的哪个选项），再 sendUserMessage 模板句；两条都传 deliverAs: "followUp"，执行者空闲时
 * 立即生效，正在运行时排到这次运行本该停下的时候，两条紧挨着并入（排队模式为 all，见任务目录的 .pi/settings.json）。
 * 结果经状态栏键 taskwright-ui-result 回传。
 *
 * 处理函数里的写库是同步的（node:sqlite），从开事务到提交之间没有 await，与工具的执行函数不会交错。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { UserOpError, runUserOperation } from "../lib/user_ops.ts";

export const USER_COMMAND = "tw-user";
export const UI_COMMAND = "tw-ui";
export const USER_RESULT_KEY = "taskwright-user-result";
export const UI_RESULT_KEY = "taskwright-ui-result";
export const USER_EDIT_CUSTOM_TYPE = "taskwright-user-edit";
export const UI_CLICK_CUSTOM_TYPE = "taskwright-ui-click";

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
      try {
        const result = runUserOperation({ workspaceDir: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() }, request);
        pi.sendMessage(
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
            },
          },
          // 不传送法：执行者空闲时立即加进会话；正在运行时 pi 暂存到这一轮结束再加（不能插在工具调用与结果之间），
          // 只作上下文，不另外引出一次模型请求。
        );
        if (result.notify_text) pi.sendUserMessage(result.notify_text, { deliverAs: "followUp" });
        report({ ok: true, event_seqs: result.event_seqs, results: result.results, revision_no: result.revision_no });
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
      const option = request.option_text ? `「${request.option_key ? `${request.option_key}. ` : ""}${request.option_text}」` : "";
      pi.sendMessage(
        {
          customType: UI_CLICK_CUSTOM_TYPE,
          content: `界面点击（不是用户打的字）：用户在回复 ${String(request.reply_entry ?? "")} 的卡片上${option ? `选了${option}` : "点了一个按钮"}。`,
          display: true,
          details: {
            op_id: opId,
            reply_entry: request.reply_entry ?? null,
            option_key: request.option_key ?? null,
            option_text: request.option_text ?? null,
            text,
          },
        },
        { deliverAs: "followUp" },
      );
      pi.sendUserMessage(text, { deliverAs: "followUp" });
      ctx.ui.setStatus(UI_RESULT_KEY, JSON.stringify({ op_id: opId, ok: true, idle: ctx.isIdle() }));
    },
  });
}
