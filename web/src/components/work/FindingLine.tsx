// 一条评审发现，条目详情与评审页签共用，两行、都左对齐：
//   第一行只放发现本身：「问题：」或「建议：」、列表型字段的第几项、问题原文、「改法：……」、「违反 UC-R7」（点编号展开条文），
//     末尾小字「第 N 次评审指出」；
//   第二行是这条发现的去向：状态词在前（未处理／已在修订 N 改／已保留），保留的理由跟在后面（「已保留 · 理由：……」），
//     操作链接放在这一行末尾：让助手照这条改、保留这种写法（点开填理由，可以不写）、撤销保留。
// 没给状态时（例如评审通过的条目的建议）不画第二行里的状态词，只放能用的链接。

import { useState } from "react";
import type { Finding, ReviewRule } from "../../api/types";
import { type FindingStatus, isProblem } from "../../model/items";

export function FindingLine({ finding, rule, batchNo = null, status = null, onOpen, onFix, fixOff, onKeep, onUnwaive, unwaiveOff }: {
  finding: Finding;
  /** 发现引用的那条规则，展开条文用。 */
  rule?: ReviewRule;
  /** 这条发现出自第几次评审。 */
  batchNo?: number | null;
  /** 这条发现的去向；为空时第二行不写状态词。 */
  status?: FindingStatus | null;
  /** 点发现文字：打开条目并指到字段（评审页签里用）。 */
  onOpen?: () => void;
  /** 「让助手照这条改」。 */
  onFix?: (f: Finding) => void;
  fixOff?: boolean;
  /** 「保留这种写法」；不能保留时不给。 */
  onKeep?: (reason: string) => void;
  /** 「撤销保留」；没有保留或不能撤销时不给。 */
  onUnwaive?: () => void;
  unwaiveOff?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const [reason, setReason] = useState("");
  const problem = isProblem(finding);
  const statusWord = status === null ? null
    : status.kind === "fixed" ? `已在修订 ${status.revision} 改`
    : status.kind === "kept" ? (status.reason ? `已保留 · 理由：${status.reason}` : "已保留")
    : "未处理";
  const hasSecond = statusWord !== null || !!onFix || !!onKeep || !!onUnwaive;
  const text = <>{finding.index != null ? `第 ${finding.index + 1} 项：` : ""}{finding.problem}</>;
  return (
    <span className={`finding${problem ? "" : " advice"}`} data-testid={problem ? "finding-problem" : "finding-advice"}>
      <span>
        <b>{problem ? "问题：" : "建议："}</b>
        {onOpen ? <span role="button" style={{ cursor: "pointer" }} onClick={onOpen}>{text}</span> : text}
        {finding.suggestion && <> 改法：{finding.suggestion}</>}
        {finding.rule_id && (
          <> 违反 <span className="clause" role="button" onClick={() => setOpen(!open)} data-testid={`clause-${finding.rule_id}`}>{finding.rule_id}</span></>
        )}
        {batchNo != null && <span className="muted small"> · 第 {batchNo} 次评审指出</span>}
      </span>
      {open && (
        <span className="clause-body" data-testid="clause-body">
          {rule ? `${rule.id}（${rule.level}）　${rule.text}` : `${finding.rule_id}　这条规则的条文这次没有读到。`}
        </span>
      )}
      {hasSecond && (
        <span className="fix-how" data-testid="finding-fate">
          {statusWord !== null && <b className={`st${status?.kind === "open" ? " open" : ""}`} data-testid="finding-status">{statusWord}</b>}
          {onFix && <span className="keep-link" role="button" aria-disabled={fixOff} onClick={() => { if (!fixOff) onFix(finding); }} data-testid="fix-finding">让助手照这条改</span>}
          {onKeep && !keeping && <span className="keep-link" role="button" onClick={() => setKeeping(true)} data-testid="keep-finding">保留这种写法</span>}
          {onUnwaive && <span className="keep-link" role="button" aria-disabled={unwaiveOff} onClick={() => { if (!unwaiveOff) onUnwaive(); }} data-testid="unwaive-finding">撤销保留</span>}
        </span>
      )}
      {onKeep && keeping && (
        <span className="keep-box">
          <input className="reason" placeholder="保留的理由（可以不写）" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="keep-finding-reason" />
          <button type="button" className="btn sm" onClick={() => { onKeep(reason); setKeeping(false); setReason(""); }} data-testid="keep-finding-ok">保留现在的写法</button>
          <button type="button" className="btn sm" onClick={() => setKeeping(false)}>取消</button>
        </span>
      )}
    </span>
  );
}
