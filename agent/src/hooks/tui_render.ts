/**
 * 终端界面（TUI，pi 的交互模式）里「回复」与「保存修订」两个工具块的渲染器。
 *
 * pi 的渲染器是工具定义上的两个可选函数：renderCall 画调用那一行，renderResult 画结果。只有交互模式会调它们，
 * RPC 模式不调，所以挂上它们不改变任何工具的行为。排版用 lib/tool_render.ts 的纯函数，这里只加颜色。
 *
 * 挂法：扩展入口把 pi 交给 withTuiRenderers 包一层，再交给两个工具的登记函数；包过的 registerTool
 * 在登记这两个工具时把渲染器并进工具定义，其余调用原样转给 pi。这样工具的登记文件不必改动。
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { REPLY_TOOL_NAME } from "../lib/reply.ts";
import {
  REPLY_HEADING,
  SAVE_HEADING,
  type SavedOperation,
  replyBodyLines,
  replyRejectedLines,
  saveRejectedLines,
  savedLines,
  titlesForOperations,
} from "../lib/tool_render.ts";

const SAVE_TOOL_NAME = "save_revision";

type Result = { content?: { type: string; text?: string }[]; details?: any };

function textOf(result: Result): string {
  return (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

const block = (lines: string[]) => new Text(lines.join("\n"), 0, 0);

const renderers: Record<string, { renderCall: any; renderResult: any }> = {
  [REPLY_TOOL_NAME]: {
    // 标题行不写「正在写」之类的进度：续接旧会话时恢复出来的工具块没有「已开始执行」的标记，会被误标；
    // 模型还在写参数时 pi 自己有 Working 指示。
    renderCall(_args: unknown, theme: Theme) {
      return new Text(theme.fg("toolTitle", theme.bold(REPLY_HEADING)), 0, 0);
    },
    renderResult(result: Result, _options: unknown, theme: Theme, context: any) {
      if (context.isError) return block(replyRejectedLines(textOf(result)).map((line) => theme.fg("error", line)));
      const reply = result.details?.reply ?? context.args ?? {};
      return block(replyBodyLines(reply));
    },
  },
  [SAVE_TOOL_NAME]: {
    renderCall(args: any, theme: Theme) {
      const count = Array.isArray(args?.operations) ? args.operations.length : 0;
      return new Text(theme.fg("toolTitle", theme.bold(SAVE_HEADING)) + theme.fg("muted", `（${count} 个操作）`), 0, 0);
    },
    renderResult(result: Result, _options: unknown, theme: Theme, context: any) {
      if (context.isError) return block(saveRejectedLines(textOf(result)).map((line) => theme.fg("error", line)));
      const details = result.details ?? {};
      // 标题要读库；同一个工具块每次重画都会调这里，读一次记在渲染器状态里。
      if (!context.state.titles) {
        context.state.titles = titlesForOperations(context.cwd, (details.operations ?? []) as SavedOperation[]);
      }
      return block(savedLines(details, context.state.titles));
    },
  },
};

/** 把 pi 包一层：登记上面两个工具时并入渲染器，其余原样转交。 */
export function withTuiRenderers(pi: ExtensionAPI): ExtensionAPI {
  return new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool: any) => target.registerTool({ ...tool, ...(renderers[tool.name] ?? {}) });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
