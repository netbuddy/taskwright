/**
 * 扩展命令 /tw-board：打印交付物看板，给人在终端界面里亲手验证时看库里的现状。
 *
 *   /tw-board              整个看板：各集合的条目、完成条件逐项满足情况、事件表最后一个序号；
 *   /tw-board UC-001       这个条目当前版本的全部字段与来源；
 *   /tw-board UC-001 2     这个条目第 2 版的全部字段与来源。
 *
 * 内容由 lib/board.ts 读库排好，库以只读方式打开，不写库，也不往会话里追加任何消息，执行者看不到它。
 * 交互模式下以一个可滚动的面板显示，上下箭头与翻页键滚动，Esc 或 q 关掉；其他模式（例如 RPC）经 notify 发出。
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey } from "@earendil-works/pi-tui";
import { boardCommandLines } from "../lib/board.ts";

export const BOARD_COMMAND = "tw-board";

/** 可滚动的只读面板。 */
class BoardPanel {
  private offset = 0;
  private readonly text: Text;

  constructor(private readonly lines: string[], private readonly theme: Theme, private readonly close: () => void, private readonly redraw: () => void) {
    this.text = new Text(lines.join("\n"), 1, 0);
  }

  private height(): number {
    return Math.max(5, (process.stdout.rows || 24) - 6);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) return this.close();
    const page = this.height();
    if (matchesKey(data, "up")) this.offset -= 1;
    else if (matchesKey(data, "down")) this.offset += 1;
    else if (matchesKey(data, "pageUp")) this.offset -= page;
    else if (matchesKey(data, "pageDown") || data === " ") this.offset += page;
    else if (matchesKey(data, "home")) this.offset = 0;
    else if (matchesKey(data, "end")) this.offset = Number.MAX_SAFE_INTEGER;
    else return;
    this.redraw();
  }

  render(width: number): string[] {
    const body = this.text.render(width);
    const page = this.height();
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, body.length - page)));
    const shown = body.slice(this.offset, this.offset + page);
    const range = body.length > page ? `第 ${this.offset + 1}–${this.offset + shown.length} 行，共 ${body.length} 行；↑↓ 与翻页键滚动，` : "";
    return [
      this.theme.fg("accent", this.theme.bold(" 交付物看板（只读，执行者看不到） ")),
      ...shown,
      this.theme.fg("dim", ` ${range}Esc 或 q 关掉`),
    ];
  }

  invalidate(): void {
    this.text.invalidate();
  }
}

export function registerBoardCommand(pi: ExtensionAPI): void {
  pi.registerCommand(BOARD_COMMAND, {
    description: "打印交付物看板（只读）：不带参数看整个任务，带条目编号看这个条目的全部字段与来源，例如 /tw-board UC-001",
    handler: async (args, ctx) => {
      let lines: string[];
      try {
        lines = boardCommandLines(ctx.cwd, args ?? "");
      } catch (error) {
        lines = [`读库时出错了：${(error as Error).message}`];
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new BoardPanel(lines, theme, () => done(), () => tui.requestRender()));
    },
  });
}
