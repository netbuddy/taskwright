// 对话区底部、输入框上方的运行状态条：助手在做事时写现在在哪一段、这次运行已经多少秒、这一轮收到多少字；
// 很久没有新内容时变琥珀色，提示可以停止再发「继续」；看门狗中止之后变红，「看说明」滚到对话里那条中止的系统消息。
// 字与颜色由 model/runStatus.ts 定，数由后端推来。

import type { RunStatus } from "../../api/types";
import { runStatusLine } from "../../model/runStatus";

export function RunStatusBar({ status }: { status: RunStatus | null }) {
  const line = runStatusLine(status);
  if (!line) return null;
  const showNote = () => {
    const notes = document.querySelectorAll('[data-note-kind="output_aborted"]');
    notes[notes.length - 1]?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  };
  return (
    <div className={`runbar ${line.tone}`} role="status" data-testid="run-status" data-tone={line.tone}>
      <span className="dot" />
      <span className="txt">{line.text}</span>
      {line.tone === "aborted" && <span className="lnk" role="button" onClick={showNote} data-testid="run-status-note">看说明</span>}
    </div>
  );
}
