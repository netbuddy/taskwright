// 任务页的材料卡：材料清单（名称、大小、上传时间、「查看」；还没有进入对话的材料另有「删除」）与上传区。
// 这里上传的一律是材料，不问去向；参考文档在知识库页面上传。材料一旦进入了对话（上传之后有会话活动过）就不能删除，
// 后端在任务详情里给每份材料标了 deletable，这里只按它决定显不显示「删除」。任务已结束时没有「删除」，也没有上传区。

import { useState } from "react";
import { Modal, Upload } from "antd";
import { FileTextOutlined, FileWordOutlined, UploadOutlined } from "@ant-design/icons";
import { api, ApiError } from "../../api/client";
import type { Material, ServiceInfo } from "../../api/types";
import { formatBytes, formatTimeShort } from "../../model/format";
import { tooLargeText, unsupportedTypeText, uploadAccept, uploadLimitText, uploadTypesText } from "../../model/upload";
import { useToast } from "../Toasts";

const fileName = (path: string) => path.split("/").pop() ?? path;

/** 上传区的说明：类型与大小两半句取自服务信息；还没取到时只写前一句，不猜。 */
export function uploadHintText(info: ServiceInfo | null): string {
  const parts = [uploadTypesText(info), uploadLimitText(info)].filter(Boolean);
  return `把文件拖到这里，或者点这里选择文件。${parts.length ? `${parts.join("，")}。` : ""}`;
}

export function MaterialsCard({ taskId, materials, closed, info, onView, onChanged }: {
  taskId: string;
  /** 用户放进来的材料（不含由 Word 材料生成的文件）。 */
  materials: Material[];
  /** 任务已完成或已放弃：只能查看。 */
  closed: boolean;
  info: ServiceInfo | null;
  onView: (material: Material) => void;
  /** 上传或删除成功之后：重读任务。 */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [deleting, setDeleting] = useState<string | null>(null);

  const remove = async () => {
    const path = deleting;
    if (!path) return;
    try {
      await api.deleteMaterial(taskId, path);
      toast.success(`已删除材料《${fileName(path)}》。`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "删除没有成功。");
      // 被拒绝多半是它刚进入了对话：重读一次，让「删除」按新的情况显示。
      onChanged();
    } finally {
      setDeleting(null);
    }
  };

  return (
    <section className="tp-pane" aria-label="材料" data-testid="materials-card">
      <div className="tp-sec-h"><h2><FileTextOutlined className="tp-hic" />材料</h2><span className="cnt" data-testid="material-count">{materials.length} 份</span></div>
      {materials.length === 0 ? <div className="tp-none">这个任务还没有材料。</div> : (
        <table className="tp-mtable">
          <thead><tr><th>名称</th><th>大小</th><th>上传时间</th><th>操作</th></tr></thead>
          <tbody>
            {materials.map((m) => (
              <tr key={m.path} data-testid="material-row">
                <td className="nm">{/\.docx$/i.test(m.path) ? <FileWordOutlined className="fic" /> : <FileTextOutlined className="fic" />}{fileName(m.path)}</td>
                <td className="num">{formatBytes(m.bytes)}</td>
                <td className="num">{formatTimeShort(m.modified_at)}</td>
                <td>
                  <a className="tp-lnk" role="button" onClick={() => onView(m)} data-testid="material-view">查看</a>
                  {!closed && m.deletable && <a className="tp-lnk quiet" role="button" onClick={() => setDeleting(m.path)} data-testid="material-delete">删除</a>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!closed && (
        <div className="tp-drop">
          <Upload.Dragger
            accept={uploadAccept(info)}
            showUploadList={false}
            customRequest={async ({ file, onSuccess, onError }) => {
              // 类型不符或超过上限的文件不发请求，直接报后端给的那句话（先查类型，与后端的先后相同）。
              // 拖进来的文件与在选择框里选了「所有文件」时选中的文件都不经过滤，所以类型也要在这里查。
              const refused = unsupportedTypeText(info, file as File) ?? tooLargeText(info, file as File);
              if (refused) {
                toast.error(refused);
                onError?.(new Error(refused));
                return;
              }
              try {
                const r = await api.uploadMaterial(taskId, file as File);
                toast.success(`已上传：${r.path}`);
                onSuccess?.({});
                onChanged();
              } catch (e) {
                toast.error(e instanceof ApiError ? e.message : "上传没有成功。");
                onError?.(e as Error);
              }
            }}
          >
            <UploadOutlined className="up" />
            <span data-testid="upload-hint">{uploadHintText(info)}</span>
          </Upload.Dragger>
        </div>
      )}
      <Modal title={deleting ? `删除材料《${fileName(deleting)}》？` : ""} open={!!deleting} onCancel={() => setDeleting(null)}
        onOk={() => void remove()} okText="删除" cancelText="取消" destroyOnHidden>
        <p>删除之后这份材料就没有了，助手下次开始会话时不会再看到它。</p>
      </Modal>
    </section>
  );
}
