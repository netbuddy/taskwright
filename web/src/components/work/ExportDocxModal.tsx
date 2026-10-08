// 「导出 Word」的对话框：把条目区里勾选的条目导出成一份 Word 文件。写明导出的是每个条目最新的版本，
// 有一项「带上来源」（缺省勾上）。文件由任务服务生成，这里只负责下载；导出不改任何东西，助手工作中、任务结束后都能用。
// 没有导出成时把原因写在对话框里，对话框留着；导出成了就关掉，条目区的勾选不动。

import { useEffect, useState } from "react";
import { Checkbox, Modal } from "antd";
import { api } from "../../api/client";
import type { Item, Task } from "../../api/types";
import { saveBlob } from "../../model/download";

export const EXPORT_DOCX_HINT = "先在列表里勾选要导出的条目";
export const EXPORT_FAILED_TEXT = "没有导出成：";

/** 对话框里的那一句：选中的条目来自不止一个集合时写明来自几个集合。 */
export function exportSummary(items: Item[]): string {
  const collections = new Set(items.map((i) => i.collection)).size;
  return `导出选中的 ${items.length} 个条目${collections > 1 ? `（来自 ${collections} 个集合）` : ""}最新的版本。`;
}

export function ExportDocxModal({ open, task, items, onClose }: { open: boolean; task: Task; items: Item[]; onClose: () => void }) {
  const [withSources, setWithSources] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 每次打开都回到缺省：带上来源，没有上一次的报错。
  useEffect(() => {
    if (open) {
      setWithSources(true);
      setError(null);
    }
  }, [open]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob, fileName } = await api.exportItemsDocx(task.task_id, items.map((i) => i.item_id), withSources, `${task.task_name}-条目.docx`);
      saveBlob(blob, fileName);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="导出 Word" open={open} onCancel={onClose} onOk={() => void run()} okText="导出" cancelText="取消" confirmLoading={busy}
      okButtonProps={{ disabled: !items.length, "data-testid": "export-docx-ok" } as never} destroyOnHidden>
      <p data-testid="export-docx-summary">{exportSummary(items)}</p>
      <p className="muted small">每个条目一张表，按集合分段；条目之后又改过的，导出的是改过之后的内容。</p>
      <Checkbox checked={withSources} onChange={(e) => setWithSources(e.target.checked)} data-testid="export-docx-sources">带上来源</Checkbox>
      {error && <p role="alert" style={{ color: "#cf1322", marginTop: "0.75rem" }} data-testid="export-docx-error">{EXPORT_FAILED_TEXT}{error}</p>}
    </Modal>
  );
}
