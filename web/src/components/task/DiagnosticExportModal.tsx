// 导出诊断包的确认框（任务列表每行菜单里的「导出诊断包」）：写明它是什么、请妥善保管，点「导出」下载这个任务的诊断包
// （导出接口加 diagnostic=1，后端定文件名），同时关掉确认框。诊断包是排查问题用的，不用来恢复任务。

import { Button, Modal } from "antd";
import { api } from "../../api/client";

/** 确认框里说用途的那一句。 */
export const DIAGNOSTIC_PURPOSE_TEXT = "把这个任务的运行记录、对话与条目打成一个文件，供排查问题；不含材料原件与密钥。";
/** 确认框里提醒保管的那一句。 */
export const DIAGNOSTIC_KEEP_TEXT = "包里含对话全文，请妥善保管。";

export function DiagnosticExportModal({ taskId, taskName, onClose }: {
  /** 要导出的任务；null 时确认框关着。 */
  taskId: string | null;
  taskName: string;
  onClose: () => void;
}) {
  return (
    // 任务名可能很长，不放进标题（会压到右上角的关闭按钮），写在正文第一行。
    <Modal open={!!taskId} title="导出诊断包" onCancel={onClose} destroyOnHidden
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="export" type="primary" href={taskId ? api.exportDiagnosticHref(taskId) : undefined} onClick={onClose} data-testid="diagnostic-export">导出</Button>,
      ]}>
      <p data-testid="diagnostic-task">任务「{taskName}」</p>
      <p data-testid="diagnostic-purpose">{DIAGNOSTIC_PURPOSE_TEXT}</p>
      <p className="muted small" data-testid="diagnostic-keep">{DIAGNOSTIC_KEEP_TEXT}</p>
    </Modal>
  );
}
