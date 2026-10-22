// 运行状态条：数由后端推来，页面只写成一行字并定颜色；收到别的会话的帧不管；中止之后「看说明」滚到那条系统消息。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { RunStatus } from "../api/types";
import { runStatusLine } from "../model/runStatus";
import { RunStatusBar } from "../components/work/RunStatusBar";
import { initialWorkState, workReducer } from "../state/workState";

afterEach(cleanup);
const frame = (over: Partial<RunStatus> = {}): RunStatus => ({ phase: "tool_args", tool: "save_revision", run_seconds: 12, received_chars: 830, tool_args_chars: 640,
  idle_seconds: 1, stalled: false, aborted: null, ...over });

describe("运行状态条", () => {
  it("输出中：写阶段、已运行秒数、本轮收到的字数；空闲时不显示", () => {
    expect(runStatusLine(frame())).toEqual({ tone: "normal", text: "模型输出中：保存修订的参数 640 字 · 本次运行已 12 秒 · 本轮已收到 830 字" });
    expect(runStatusLine(frame({ phase: "tool", tool: "get_item" }))!.text.startsWith("执行工具：查看 · ")).toBe(true);
    expect(runStatusLine(frame({ phase: "waiting" }))!.text.startsWith("等待模型 · ")).toBe(true);
    expect(runStatusLine(frame({ phase: "idle", run_seconds: null }))).toBeNull();
    expect(runStatusLine(null)).toBeNull();
  });

  it("可能卡住了：琥珀色，写已多少秒没有新内容、可以停止再发继续；中止之后：红色，写原因与没有写入任何内容", () => {
    expect(runStatusLine(frame({ phase: "thinking", stalled: true, idle_seconds: 47 }))).toEqual({ tone: "stalled",
      text: "这一步可能卡住了：已 47 秒没有新内容；可以点「停止」，再发一句「继续」。（模型输出中：思考 · 本次运行已 12 秒 · 本轮已收到 830 字）" });
    expect(runStatusLine(frame({ phase: "idle", aborted: "连续输出了 200 段空白" }))).toEqual({ tone: "aborted",
      text: "已中止：模型输出异常（连续输出了 200 段空白），没有写入任何内容；发一句「继续」即可接着做" });
  });

  it("组件：中止之后带「看说明」；页面状态只收这条会话的帧", () => {
    render(<div className="app"><RunStatusBar status={frame({ phase: "idle", aborted: "90 秒没有新内容" })} /></div>);
    expect(screen.getByTestId("run-status").getAttribute("data-tone")).toBe("aborted");
    expect(screen.getByTestId("run-status-note")).toHaveTextContent("看说明");
    const state = initialWorkState("s-1");
    expect(workReducer(state, { type: "sse", event: "run_status", data: { ...frame(), session_id: "s-2" } }).runStatus).toBeNull();
    expect(workReducer(state, { type: "sse", event: "run_status", data: { ...frame(), session_id: "s-1" } }).runStatus?.tool).toBe("save_revision");
  });
});
