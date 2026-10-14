// 查看一份材料用的弹窗：Word 与 PDF 按原样分页显示（与工作视图材料区同一个渲染），别的显示文字。
// 任务起点页与活动输入页的材料卡共用：view 交给材料卡的「查看」，viewer 放在页面里。

import { useState, type ReactNode } from "react";
import { Modal } from "antd";
import { api } from "../../api/client";
import type { Material } from "../../api/types";
import { DocxPaper } from "../work/DocxPaper";
import { PdfPaper } from "../work/PdfPaper";

export function useMaterialViewer(taskId: string): { view: (material: Material) => void; viewer: ReactNode } {
  const [material, setMaterial] = useState<{ path: string; text: string } | null>(null);
  // Word 材料的「查看」按原版式显示，不显示给助手读的投影。
  const [wordPath, setWordPath] = useState<string | null>(null);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const view = (m: Material) => (/\.docx$/i.test(m.path) ? setWordPath(m.path) : /\.pdf$/i.test(m.path) ? setPdfPath(m.path)
    : void api.materialContent(taskId, m.path).then(setMaterial));
  const viewer = (
    <>
      <Modal title={material?.path} open={!!material} onCancel={() => setMaterial(null)} footer={null} width="min(54.286rem, 94vw)">
        <pre className="doc-text" style={{ maxHeight: "40rem", overflow: "auto" }}>{material?.text}</pre>
      </Modal>
      <Modal title={wordPath} open={!!wordPath} onCancel={() => setWordPath(null)} footer={null} width="min(64rem, 94vw)" destroyOnHidden>
        {wordPath && (
          <div className="app docx-view">
            <div className="doc-b"><DocxPaper taskId={taskId} path={wordPath} items={[]} locate={null} /></div>
          </div>
        )}
      </Modal>
      <Modal title={pdfPath} open={!!pdfPath} onCancel={() => setPdfPath(null)} footer={null} width="min(64rem, 94vw)" destroyOnHidden>
        {pdfPath && (
          <div className="app docx-view">
            <div className="doc-b pdf-modal-b"><PdfPaper taskId={taskId} path={pdfPath} items={[]} locate={null} /></div>
          </div>
        )}
      </Modal>
    </>
  );
  return { view, viewer };
}
