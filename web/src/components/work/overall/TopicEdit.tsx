// 修改一页主题：把这一页的各个字段摆成一张表来改（标题、别名、它是什么、例子、已经定下的、标签、上级主题、状态、改看），
// 用的是条目详情里同一套字段编辑框。保存只带改过的字段，作为用户的直接修改发出去；界面上的变化等库事件到了才发生。
// 字段声明里写了「只许本集合」的条目引用（上级主题、改看）只能从总体分析别的页里选，写了「至多一个」的至多选一个；
// 不照着限制的话保存会被后端拒绝。

import { useEffect, useState } from "react";
import type { CollectionDef, Fields, Task } from "../../../api/types";
import { writeOffReason } from "../../../model/items";
import { TOPIC, isDeprecated, pagesOf, titleOf, type OverallItem, type TopicFieldDef } from "../../../model/overall";
import { FieldEditor, normalize, type SubmitAction } from "../ItemDetail";
import { rejectedText } from "../errors";
import { useToast } from "../../Toasts";

const HINT: Record<string, string> = {
  [TOPIC.alias]: "别处用这几个词说到它时，也算提到它。",
  [TOPIC.examples]: "一条一段话；这种不算的例子以「反例：」开头。",
  [TOPIC.settled]: "一句一条。",
  [TOPIC.labels]: "可以不选，也可以选几个；贴了标签的主题才会进文档。",
  [TOPIC.parent]: "它在提纲里排在哪一页下面；不选就是最上面一级。",
  [TOPIC.see]: "这一页已废弃时，让人改看哪一页。",
};

export function TopicEdit({ task, item, def, readOnly, writesOff = false, submit, onDone, onDirty }: {
  task: Task; item: OverallItem; def: CollectionDef; readOnly: boolean; writesOff?: boolean; submit: SubmitAction;
  /** 保存成了或者取消了。 */
  onDone: () => void;
  onDirty?: (dirty: boolean) => void;
}) {
  const toast = useToast();
  // 进入修改时这一页的样子：改了什么与它比，保存时带它的修订号（别人在这期间改过，后端会说修订过期）。
  const [base] = useState({ revision_no: item.revision_no, fields: item.fields });
  const [draft, setDraft] = useState<Fields>(item.fields);
  const [saving, setSaving] = useState(false);
  const changed = (): Fields => {
    const out: Fields = {};
    for (const f of def.fields) {
      const now = normalize(f, draft[f.name] ?? null);
      if (JSON.stringify(now) !== JSON.stringify(normalize(f, base.fields[f.name] ?? null))) out[f.name] = now;
    }
    return out;
  };
  const dirty = Object.keys(changed()).length > 0;
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false); }, [dirty]);
  const off = writeOffReason(task, { readOnly, writesOff, pending: saving });
  const others = pagesOf(task).filter((p) => p.item_id !== item.item_id && !isDeprecated(p)).map((p) => ({ value: p.item_id, label: `${p.item_id} ${titleOf(p)}` }));

  const save = async () => {
    const fields = changed();
    if (Object.keys(fields).length === 0) { onDone(); return; }
    const label = `修改 ${item.item_id} 的${Object.keys(fields).join("、")}`;
    setSaving(true);
    const e = await submit({ kind: "edit_fields", targets: [{ item_id: item.item_id, base_revision: base.revision_no }], fields, notify_executor: false }, label);
    setSaving(false);
    if (e) toast.error(rejectedText(label, e, item.item_id));
    else onDone();
  };

  return (
    <div className="oa-edit" data-testid="topic-edit">
      {(def.fields as TopicFieldDef[]).map((f) => (
        <div className="fld" key={f.name} data-f={f.name}>
          <div className="k">{f.name}{f.required && <span className="oa-req"> *</span>}</div>
          <div className="v editing">
            <FieldEditor def={f} value={draft[f.name] ?? null} task={task} onChange={(v) => setDraft((d) => ({ ...d, [f.name]: v }))}
              choices={f.same_collection ? others : undefined} single={f.single === true} />
            {HINT[f.name] && <div className="oa-hint">{HINT[f.name]}</div>}
          </div>
        </div>
      ))}
      <div className="dfoot">
        <button type="button" className="btn pri" disabled={!!off || !dirty} title={off ?? (dirty ? undefined : "还没有改动")} onClick={() => void save()} data-testid="topic-save">保存</button>
        <button type="button" className="btn" onClick={onDone} data-testid="topic-cancel">取消</button>
        <span className="aihint">保存的是你亲手改的内容，助手会看到这次修改。</span>
      </div>
    </div>
  );
}
