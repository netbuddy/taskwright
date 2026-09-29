// 评审通过时的说明：「评审通过：」加程序记下的那句话（不在页面上另拼），能列出规则时跟「看这 N 条规则」，点了展开规则清单，
// 再点收起。清单每条写编号与条文（级别不写，以后由单独的规则配置面板说明）；这个任务里关闭了的规则不列，末尾用灰字写另有几条已经关闭。
// 评审之后规则改过时不给链接，灰字说明列不出当时的规则。能列出哪些规则见 model/items.ts 的 passRules。
// 条目详情里是一块绿色的说明，第二行写评审的时刻与修订；评审页签里是条目那一行下面的一行，时刻与修订卡片上已经有了，不重复。

import { useState } from "react";
import type { Review, Task } from "../../api/types";
import { passRules } from "../../model/items";
import { formatTime } from "../../model/format";

export function PassNote({ task, collection, review, inRow = false }: {
  task: Task; collection: string; review: Review;
  /** 评审页签里条目那一行下面的样子：不加底色，不写时刻与修订。 */
  inRow?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const basis = passRules(task, collection, review);
  const n = basis.kind === "list" ? basis.rules.length : 0;
  return (
    <div className={inRow ? "sw-pass-row" : "sw-pass"} data-testid="pass-note">
      <div>
        <b>评审通过{review.reason ? "：" : "。"}</b>{review.reason ?? ""}
        {basis.kind === "list" && (
          <span className="rl-link" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}
            data-testid="pass-rules-link">{open ? `收起这 ${n} 条规则 ▴` : `看这 ${n} 条规则 ▸`}</span>
        )}
      </div>
      {basis.kind === "changed" && <div className="ml" data-testid="pass-rules-changed">评审之后规则改过，这里列不出当时核对的规则。</div>}
      {!inRow && <div className="ml">评审于 {review.at ? `${formatTime(review.at)}，` : ""}修订 {review.revision_no}</div>}
      {basis.kind === "list" && open && (
        <div className="rl-list" data-testid="pass-rules">
          {basis.rules.map((r) => (
            <div key={r.id} className="rl-row">
              <span className="rid">{r.id}</span>
              <span>{r.text}</span>
            </div>
          ))}
          {basis.off > 0 && <div className="rl-off">另有 {basis.off} 条规则已经关闭，这次没有核对。</div>}
        </div>
      )}
    </div>
  );
}
