// 右侧栏的「调试」页签，只在服务开着调试模式（带 --debug 启动）时出现。最上面是阶段条（StageBar.tsx：六个阶段的名字与当前阶段还差哪几项，
// 平常的页面上不显示它），下面四块，从上到下：
//   1. 最近一次运行实际发给模型的系统提示，按部分列出，每一部分写明出自哪里，点开看原文；
//   2. 阶段记录：谁在什么时候把任务从哪个阶段移到哪个阶段、理由；
//   3. 现在这个阶段的每盏灯：通过、没通过还是不适用，整句，与它列出的编号（可以点开）；
//   4. 被拒的工具调用：缺省只列最近一次工作里的，可以改看全部。
// 打开页签时取一次，助手每做完一轮再取一次，另有「刷新」；不定时轮询。灯随整份数据来，不另取。

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { DebugStage, DebugSystemPrompt, Item, StageView } from "../../api/types";
import { formatTime } from "../../model/format";
import { STAGE_NAMES } from "../../model/stage";
import { StageBar } from "./StageBar";

const HOW_TEXT: Record<string, string> = { recomposed: "这一次是重新读文件拼的", reused: "这一次沿用了上一次拼好的", kept_after_error: "这一次重拼出错，沿用了上一次拼好的" };
const ACTOR_TEXT: Record<string, string> = { user: "用户", executor: "助手" };
const LAMP_STATE: [string, string][] = [["ok", "通过"], ["no", "没通过"], ["na", "不适用"]];

export function DebugPane({ taskId, stage, items = [], working, onOpenItem, onOpenMaterial }: {
  taskId: string;
  stage: StageView | null;
  /** 任务的条目（阶段条上点一盏没通过的灯，要找它差的第一页、第一条）。 */
  items?: readonly Item[];
  /** 打开一份材料（阶段条上点「材料还没有读完」之类的灯）。 */
  onOpenMaterial?: (path: string) => void;
  /** 助手是不是正在工作：从工作中变为不在工作时再取一次。 */
  working: boolean;
  onOpenItem: (itemId: string) => void;
}) {
  const [prompt, setPrompt] = useState<DebugSystemPrompt | null>(null);
  const [facts, setFacts] = useState<DebugStage | null>(null);
  const [error, setError] = useState("");
  const [allRejections, setAllRejections] = useState(false);
  const load = useCallback(() => {
    Promise.all([api.debugSystemPrompt(taskId), api.debugStage(taskId)])
      .then(([p, f]) => { setPrompt(p); setFacts(f); setError(""); })
      .catch((e: Error) => setError(e.message));
  }, [taskId]);
  useEffect(() => { load(); }, [load]);
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) load();
    wasWorking.current = working;
  }, [working, load]);

  const lamps = stage ? stage.lamps[stage.current] ?? [] : [];
  const rejections = facts ? (allRejections ? facts.rejections : facts.rejections.filter((one) => one.work_id === facts.latest_work_id)) : [];
  return (
    <div className="dbg-pane" data-testid="debug-pane">
      <StageBar stage={stage} items={items} onOpenItem={onOpenItem} onOpenMaterial={onOpenMaterial ?? (() => {})} />
      <div className="dbg-top">
        <span className="dbg-note">这些只在调试模式下有，给调说明文字的人看。</span>
        <button type="button" className="btn sm" onClick={load} data-testid="debug-refresh">刷新</button>
      </div>
      {error && <div className="dbg-err" data-testid="debug-error">没有取到：{error}</div>}

      <section data-testid="debug-prompt">
        <div className="dbg-h">最近一次运行的系统提示</div>
        {!prompt ? <div className="dbg-none">正在取。</div> : !prompt.available ? <div className="dbg-none">{prompt.note}</div> : (
          <>
            <div className="dbg-meta" data-testid="debug-prompt-meta">
              {prompt.replaced ? `阶段：${prompt.stage_name ?? "（没有）"}。${HOW_TEXT[prompt.how ?? ""] ?? ""}。` : (prompt.note ?? "")}
              {prompt.prompt_dir ? `提示词目录：${prompt.prompt_dir}。` : prompt.replaced ? "没有用提示词目录。" : ""}
              {prompt.at ? `${formatTime(prompt.at)} 发出。` : ""}
            </div>
            {prompt.error && <div className="dbg-err">{prompt.error}</div>}
            {(prompt.notes ?? []).map((note, index) => <div key={index} className="dbg-err">{note}</div>)}
            {prompt.parts.map((part, index) => (
              <details key={index} className="dbg-part" data-testid={`debug-part-${part.part}`}>
                <summary>{part.part_name} · {part.from_name}{part.file ? ` · ${part.file}` : ""} · {part.lines} 行</summary>
                <pre>{part.text}</pre>
              </details>
            ))}
          </>
        )}
      </section>

      <section data-testid="debug-records">
        <div className="dbg-h">阶段记录</div>
        {!facts ? <div className="dbg-none">正在取。</div> : facts.records.length === 0 ? <div className="dbg-none">还没有人移动过阶段。</div> : (
          <table className="dbg-table">
            <thead><tr><th>时刻</th><th>谁</th><th>从哪到哪</th><th>理由</th></tr></thead>
            <tbody>
              {facts.records.map((one, index) => (
                <tr key={index}>
                  <td>{formatTime(one.at)}</td><td>{ACTOR_TEXT[one.actor] ?? one.actor}</td>
                  <td>{one.from_name} → {one.to_name}</td><td>{one.reason || "（没有写）"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section data-testid="debug-lamps">
        <div className="dbg-h">{stage ? `「${STAGE_NAMES[stage.current]}」这一段的灯` : "这一段的灯"}</div>
        {!stage ? <div className="dbg-none">这个任务没有阶段。</div> : lamps.length === 0 ? <div className="dbg-none">这一段没有灯。</div> : lamps.map((lamp) => {
          const [cls, text] = LAMP_STATE[lamp.ok === true ? 0 : lamp.ok === false ? 1 : 2];
          return (
            <div key={lamp.key} className={`dbg-lamp ${cls}`} data-testid={`debug-lamp-${lamp.key}`}>
              <span className="st">{text}</span>
              <span className="sum">{lamp.summary}</span>
              {lamp.items.length > 0 && (
                <span className="ids">
                  {lamp.items.map((id) => <a key={id} role="button" onClick={() => onOpenItem(id)}>{id}</a>)}
                </span>
              )}
              <code className="key">{lamp.key}</code>
            </div>
          );
        })}
      </section>

      <section data-testid="debug-rejections">
        <div className="dbg-h">
          被拒的工具调用
          {facts && facts.rejections.length > 0 && (
            <label className="dbg-all"><input type="checkbox" checked={allRejections} onChange={(e) => setAllRejections(e.target.checked)} data-testid="debug-all-rejections" />看全部（共 {facts.rejections.length} 次）</label>
          )}
        </div>
        {!facts ? <div className="dbg-none">正在取。</div> : rejections.length === 0 ? <div className="dbg-none">{facts.rejections.length === 0 ? "还没有被拒的调用。" : "最近一次工作里没有被拒的调用。"}</div>
          : rejections.map((one, index) => (
            <div key={`${one.call_id}-${index}`} className="dbg-rej" data-testid="debug-rejection">
              <div className="hd"><code>{one.tool}</code><span>{formatTime(one.at)}</span></div>
              <div className="fact">{one.fact}</div>
              {one.guidance && <div className="guide">指引：{one.guidance}</div>}
            </div>
          ))}
      </section>
    </div>
  );
}
