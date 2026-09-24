// 生成文档对话框：选一个修订（缺省最新，列表来自修订日志），
// 再勾选要写进文档的条目（那次修订时交付物里的条目，缺省全选），右边实时预览；预览与下载都是纯读取。
// 文档按那次修订整体导出，不再逐条目混选修订。没有评审通过或没有确认的条目照样写进去，渲染程序在文档里如实标注。

import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Empty, Modal, Select, Spin } from "antd";
import { api, ApiError, type DocumentPick } from "../api/client";
import type { RevisionLogEntry, Task } from "../api/types";
import { aliveAt, hhmm } from "../model/revisions";

export function DocumentModal({ task, log, open, revision: initial, onClose }: {
  task: Task;
  log: RevisionLogEntry[];
  open: boolean;
  /** 打开时选中的修订；不给就是最新。 */
  revision?: number | null;
  onClose: () => void;
}) {
  const latest = log.length ? Math.max(...log.map((r) => r.revision_no)) : 0;
  const [revision, setRevision] = useState<number>(initial ?? latest);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open) { setRevision(initial ?? latest); setUnchecked(new Set()); } }, [open, initial]);
  // 打开时修订日志还没读到：读到之后选最新的那次。
  useEffect(() => { if (open && !revision && latest) setRevision(latest); }, [open, latest]);

  const alive = useMemo(() => aliveAt(log, revision), [log, revision]);
  const order = task.definition.collections.map((c) => c.name);
  const ids = [...alive.keys()];
  const picked = ids.filter((id) => !unchecked.has(id));
  // 全选时不写 items，就是那次修订时的全部条目；少选了才列出来。
  const pick: DocumentPick = useMemo(() => ({ revision_no: revision || undefined, ...(unchecked.size ? { items: picked } : {}) }),
    [revision, unchecked, alive]);

  useEffect(() => {
    if (!open || !revision) return;
    const timer = setTimeout(() => {
      setLoading(true);
      api.previewDocument(task.task_id, pick)
        .then((r) => { setPreview(r.text); setError(null); })
        .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [open, pick, task.task_id]);

  const download = async () => {
    const blob = await api.downloadDocument(task.task_id, pick);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${task.task_name}-修订${revision}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const byWho = (r: RevisionLogEntry) => (r.by === "user" ? "你在界面上改的" : "助手");
  return (
    <Modal title="生成文档" open={open} onCancel={onClose} width="min(76rem, 94vw)" footer={[
      <span key="n" className="muted small" style={{ marginRight: "0.857rem" }}>修订 {revision}，选了 {picked.length} 个条目</span>,
      <Button key="c" onClick={onClose}>关闭</Button>,
      <Button key="d" type="primary" disabled={!picked.length || !revision} onClick={download} data-testid="doc-download">下载 Markdown</Button>,
    ]}>
      {!log.length ? <Empty description="这个任务还没有修订，没有可以生成的内容" /> : (
        <>
          <p className="muted small">
            文档按你选的那次修订整体生成：每个条目写的是它在那次修订时的内容。没有评审通过或没有确认的条目也可以选，文档里会如实标注。
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "0.571rem", marginBottom: "0.571rem" }}>
            <span>按哪次修订生成：</span>
            <Select style={{ width: "22rem" }} value={revision} onChange={(v) => { setRevision(v); setUnchecked(new Set()); }} data-testid="doc-revision"
              options={log.map((r) => ({ value: r.revision_no, label: `修订 ${r.revision_no} · ${hhmm(r.at)} · ${byWho(r)}${r.revision_no === latest ? "（最新）" : ""}` }))} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 3fr)", gap: "1.143rem", height: "min(37rem, 64vh)" }}>
            <div style={{ overflow: "auto", borderRight: "1px solid var(--line2)", paddingRight: "0.571rem" }} data-testid="doc-items">
              {order.map((coll) => {
                const inColl = ids.filter((id) => alive.get(id)!.collection === coll);
                if (!inColl.length) return null;
                return (
                  <div key={coll} style={{ marginBottom: "0.714rem" }}>
                    <div className="cond-group">{coll}</div>
                    {inColl.map((id) => (
                      <label key={id} style={{ display: "flex", alignItems: "center", gap: "0.571rem", padding: "0.214rem 0", cursor: "pointer" }}>
                        <Checkbox checked={!unchecked.has(id)} data-testid={`doc-item-${id}`}
                          onChange={(e) => setUnchecked((s) => { const n = new Set(s); if (e.target.checked) n.delete(id); else n.add(id); return n; })} />
                        <span className="mono muted">{id}</span>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{alive.get(id)!.title}</span>
                      </label>
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
        </>
      )}
    </Modal>
  );
}
