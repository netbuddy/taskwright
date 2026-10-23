// 导出诊断包的确认框（任务列表每行菜单里的「导出诊断包」）：写明它是什么、请妥善保管，选「完整」或「脱敏」（默认完整，各有一句说明），
// 点「导出」下载这个任务的诊断包（导出接口加 diagnostic=1，脱敏再加 redact=1，后端定文件名），同时关掉确认框。
// 诊断包是排查问题用的，不用来恢复任务。

import { useEffect, useState } from "react";
import { Button, Modal, Radio } from "antd";
import { api } from "../../api/client";

/** 确认框里说用途的那一句。 */
export const DIAGNOSTIC_PURPOSE_TEXT = "把这个任务的运行记录、对话与条目打成一个文件，供排查问题；不含材料原件与密钥。";
/** 两种形态各自的说明。 */
export const FULL_FORM_TEXT = "不含材料原件，但含助手读到的材料文本、对话全文与条目，能查内容与流程问题。";
export const REDACTED_FORM_TEXT = "读到的材料文本与来源摘录已替换，只能查流程问题，仍含业务说明与条目的转述。";

/** 确认框里提醒保管的那一句。 */
export const DIAGNOSTIC_KEEP_TEXT = "包里含对话全文，请妥善保管。";

export function DiagnosticExportModal({ taskId, taskName, onClose }: {
  /** 要导出的任务；null 时确认框关着。 */
  taskId: string | null;
  taskName: string;
  onClose: () => void;
}) {
  const [redact, setRedact] = useState(false);
  // 每次打开都从「完整」开始。
  useEffect(() => { if (taskId) setRedact(false); }, [taskId]);
  return (
    // 任务名可能很长，不放进标题（会压到右上角的关闭按钮），写在正文第一行。
    <Modal open={!!taskId} title="导出诊断包" onCancel={onClose} destroyOnHidden
      footer={[
        <Button key="cancel" onClick={onClose}>取消</Button>,
        <Button key="export" type="primary" href={taskId ? api.exportDiagnosticHref(taskId, redact) : undefined} onClick={onClose} data-testid="diagnostic-export">导出</Button>,
      ]}>
      <p data-testid="diagnostic-task">任务「{taskName}」</p>
      <p data-testid="diagnostic-purpose">{DIAGNOSTIC_PURPOSE_TEXT}</p>
      <Radio.Group value={redact ? "redacted" : "full"} onChange={(e) => setRedact(e.target.value === "redacted")} data-testid="diagnostic-form"
        style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginBottom: "0.8rem" }}>
        <Radio value="full" data-testid="diagnostic-form-full"><b>完整</b><div className="muted small">{FULL_FORM_TEXT}</div></Radio>
        <Radio value="redacted" data-testid="diagnostic-form-redacted"><b>脱敏</b><div className="muted small">{REDACTED_FORM_TEXT}</div></Radio>
      </Radio.Group>
      <p className="muted small" data-testid="diagnostic-keep">{DIAGNOSTIC_KEEP_TEXT}</p>
    </Modal>
  );
}
