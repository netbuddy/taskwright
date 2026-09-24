// 生成文档对话框：勾条目、选版本，右边实时预览；预览与下载都是纯读取。
// 选到没有评审通过或没有确认记录的版本不拦，渲染程序会在文档里如实标注。

import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Empty, Modal, Select, Spin } from "antd";
import { api, ApiError } from "../api/client";
import type { Task } from "../api/types";

type Selection = Record<string, number | null>; // 条目编号 → 选中的版本号；null 表示不选

export function DocumentModal({ task, open, onClose }: { task: Task; open: boolean; onClose: () => void }) {
  const [selection, setSelection] = useState<Selection>({});
  const [versionOptions, setVersionOptions] = useState<Record<string, number[]>>({});
  const [preview, setPreview] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setSelection(Object.fromEntries(task.items.map((i) => [i.item_id, i.version_no])));
  }, [open, task.items]);

  const picked = useMemo(
    () => Object.entries(selection).filter(([, v]) => v != null).map(([item_id, version_no]) => ({ item_id, version_no: version_no! })),
    [selection],
  );

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      setLoading(true);
      api.previewDocument(task.task_id, picked)
        .then((r) => { setPreview(r.text); setError(null); })
        .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [open, picked, task.task_id]);

  const loadVersions = async (itemId: string) => {
    if (versionOptions[itemId]) return;
    const versions = await api.itemVersions(task.task_id, itemId).catch(() => []);
    setVersionOptions((o) => ({ ...o, [itemId]: versions.map((v) => v.version_no) }));
  };

  const download = async () => {
    const blob = await api.downloadDocument(task.task_id, picked);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${task.task_name}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal title="生成文档" open={open} onCancel={onClose} width={1080} footer={[
      <span key="n" className="muted small" style={{ marginRight: 12 }}>选了 {picked.length} 个条目</span>,
      <Button key="c" onClick={onClose}>关闭</Button>,
      <Button key="d" type="primary" disabled={!picked.length} onClick={download}>下载 Markdown</Button>,
    ]}>
      <p className="muted small">勾选要写进文档的条目与版本。没有评审通过或没有确认记录的版本也可以选，文档里会如实标注。</p>
      <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", gap: 16, height: 520 }}>
        <div style={{ overflow: "auto", borderRight: "1px solid var(--line2)", paddingRight: 8 }}>
          {task.definition.collections.map((coll) => {
            const items = task.items.filter((i) => i.collection === coll.name);
            if (!items.length) return null;
            return (
              <div key={coll.name} style={{ marginBottom: 10 }}>
                <div className="cond-group">{coll.name}</div>
                {items.map((item) => (
                  <div key={item.item_id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                    <Checkbox
                      checked={selection[item.item_id] != null}
                      onChange={(e) => setSelection((s) => ({ ...s, [item.item_id]: e.target.checked ? item.version_no : null }))}
                    />
                    <span className="mono muted">{item.item_id}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.title}</span>
                    <Select
                      size="small"
                      style={{ width: 92 }}
                      value={selection[item.item_id] ?? item.version_no}
                      disabled={selection[item.item_id] == null}
                      onFocus={() => loadVersions(item.item_id)}
                      onChange={(v) => setSelection((s) => ({ ...s, [item.item_id]: v }))}
                      options={(versionOptions[item.item_id] ?? [item.version_no]).map((v) => ({ value: v, label: `第 ${v} 版` }))}
                    />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div style={{ overflow: "auto" }}>
          {error && <div className="busy-note">{error}</div>}
          {loading && <Spin size="small" />}
          {picked.length ? <pre className="doc-text" data-testid="doc-preview">{preview}</pre> : <Empty description="还没有选任何条目" />}
        </div>
      </div>
    </Modal>
  );
}
