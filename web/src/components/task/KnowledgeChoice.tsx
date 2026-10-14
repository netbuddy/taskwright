// 活动输入页的「领域知识库」一块：列出全部知识库，勾上的这个任务会用到；通用知识库每个任务都会用到，勾着、不能去掉。
// 勾一下就改这个任务选用的知识库（与任务起点页「选用的知识库」卡改的是同一份），不用另点保存。

import { Checkbox } from "antd";
import { BookOutlined } from "@ant-design/icons";
import type { KnowledgeLibrary } from "../../api/types";
import { GENERAL, docCountText, sortedLibraries } from "../../model/knowledge";
import { href } from "../../router";

export function KnowledgeChoice({ libraries, selected, onChange }: {
  libraries: KnowledgeLibrary[];
  selected: string[];
  /** 改选用：给出改完之后的整个列表。 */
  onChange: (ids: string[]) => void;
}) {
  const libs = sortedLibraries(libraries);
  const toggle = (id: string, on: boolean) =>
    onChange([GENERAL, ...libs.filter((l) => l.id !== GENERAL && (l.id === id ? on : selected.includes(l.id))).map((l) => l.id)]);
  return (
    <section className="tp-pane" aria-label="领域知识库" data-testid="knowledge-choice">
      <div className="tp-sec-h"><h2><BookOutlined className="tp-hic" />领域知识库</h2><span className="aside">可选</span></div>
      <p className="tp-in-p">不属于某一项目的通用知识，供助手在分析过程中查阅；引用时注明出自知识库。</p>
      <div className="tp-in-kb">
        {libs.map((l) => (
          <Checkbox key={l.id} checked={l.id === GENERAL || selected.includes(l.id)} disabled={l.id === GENERAL}
            onChange={(e) => toggle(l.id, e.target.checked)} data-testid={`kb-check-${l.id}`}>
            {l.name}<span className="pm">{docCountText(l)}{l.id === GENERAL ? " · 每个任务都会用到" : ""}</span>
          </Checkbox>
        ))}
      </div>
      <div className="tp-kbfoot">
        <a className="tp-lnk" href={href.knowledge()}>上传领域文档到知识库</a>
        <span className="note">改动在下一次会话开始时生效。</span>
      </div>
    </section>
  );
}
