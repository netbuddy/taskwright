// 评审页签里「保留这种写法」的入口与输入框，两块分开给，由用它的地方决定挂在哪里（现在挂在每一处问题上，也可以挂在一个条目上）：
//   · KeepLink：「保留这种写法」，写入不可用时灰掉并悬停说明原因；
//   · KeepBox：点开之后在原地出现，填理由（可以不填）与「保留」「取消」；回车等于「保留」，Esc 等于「取消」。
//     保留记在条目上，条目有两处以上问题时，输入框上面说明它们一起算通过。

import { useState, type KeyboardEvent } from "react";

export function KeepLink({ off, onOpen }: { off: string | undefined; onOpen: () => void }) {
  const run = () => { if (!off) onOpen(); };
  return (
    <span className="lk" role="button" tabIndex={0} aria-disabled={!!off || undefined} title={off} data-testid="keep-finding"
      onClick={run} onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); run(); } }}>保留这种写法</span>
  );
}

export function KeepBox({ problems, off, onKeep, onClose }: {
  /** 这个条目要处理的问题共几处。 */
  problems: number;
  off: string | undefined;
  onKeep: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const keep = () => { if (off) return; onKeep(reason); onClose(); };
  return (
    <div className="rv-keep">
      {problems > 1 && <div className="note" data-testid="keep-finding-note">保留之后，这个条目的 {problems} 处问题都按你的决定算通过。</div>}
      <input className="reason" autoFocus placeholder="保留的理由（可以不填）" value={reason} onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); keep(); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
        }} data-testid="keep-finding-reason" />
      <div className="row">
        <button type="button" className="btn sm pri" disabled={!!off} title={off} onClick={keep} data-testid="keep-finding-ok">保留</button>
        <button type="button" className="btn sm" onClick={onClose} data-testid="keep-finding-cancel">取消</button>
      </div>
    </div>
  );
}
