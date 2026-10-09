// 任务页的材料卡：材料清单（名称、大小、上传时间、「查看」；还没有进入对话的材料另有「替换」与「删除」）与上传区。
// 这里上传的一律是材料，不问去向；参考文档在知识库页面上传。材料一旦进入了对话（上传之后有会话活动过）就不能删除、也不能替换，
// 后端在任务详情里给每份材料标了 deletable，这里只按它决定：为真时「替换」与「删除」都可以点；为假时没有「删除」，
// 「替换」是灰的、点不动，鼠标停在上面说明为什么。任务已结束时这两样都没有，也没有上传区。

import { useRef, useState } from "react";
import { Modal, Upload } from "antd";
import { FileTextOutlined, FilePdfOutlined, FileWordOutlined, UploadOutlined } from "@ant-design/icons";
import { api, ApiError } from "../../api/client";
import type { Material, ServiceInfo } from "../../api/types";
import { formatBytes, formatTimeShort } from "../../model/format";
import { pdfUploadingText, tooLargeText, unsupportedTypeText, uploadAccept, uploadLimitText, uploadTypesText } from "../../model/upload";
import { forgetDocx } from "../../state/docxStore";
import { forgetPdf } from "../../state/pdfStore";
import { useToast } from "../Toasts";

const fileName = (path: string) => path.split("/").pop() ?? path;

/** 已经进入对话的材料不能替换：灰色的「替换」上鼠标悬停时写的说明（与后端拒绝时的原话相同）。 */
export const ENTERED_REPLACE_HINT = "这份材料已经进入了对话，不能替换；请上传一份新材料，并告诉助手以新的为准。";

/** 上传区的说明：类型与大小两半句取自服务信息；还没取到时只写前一句，不猜。 */
export function uploadHintText(info: ServiceInfo | null): string {
  const parts = [uploadTypesText(info), uploadLimitText(info)].filter(Boolean);
  return `把文件拖到这里，或者点这里选择文件。${parts.length ? `${parts.join("，")}。` : ""}`;
}

/** PDF 材料名字后面的那句：共几页，有几页没有可读的文字（都读出了文字时不写后半句）。 */
export function pdfSummary(pdf: { pages: number; no_text_pages: number[] }): string {
  return `${pdf.pages} 页${pdf.no_text_pages.length > 0 ? `，其中 ${pdf.no_text_pages.length} 页没有可读的文字` : ""}`;
}

export function MaterialsCard({ taskId, materials, closed, info, onView, onChanged }: {
  taskId: string;
  /** 用户放进来的材料（不含由 Word 材料生成的文件）。 */
  materials: Material[];
  /** 任务已完成或已放弃：只能查看。 */
  closed: boolean;
  info: ServiceInfo | null;
  onView: (material: Material) => void;
  /** 上传、替换或删除成功之后：重读任务。 */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [deleting, setDeleting] = useState<string | null>(null);
  // 删除请求发出去、还没有回来：确认框的「删除」转圈、「取消」不可点，再点不会发第二次。
  const [removing, setRemoving] = useState(false);

  const remove = async () => {
    const path = deleting;
    if (!path || removing) return;
    setRemoving(true);
    try {
      await api.deleteMaterial(taskId, path);
      forgetDocx(taskId, path);
      forgetPdf(taskId, path);
      toast.success(`已删除材料《${fileName(path)}》。`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "删除没有成功。");
      // 被拒绝多半是它刚进入了对话：重读一次，让「删除」按新的情况显示。
      onChanged();
    } finally {
      setRemoving(false);
      setDeleting(null);
    }
  };

  // 替换：点「替换」先记下是哪份材料、打开文件选择框；选好文件（类型与大小照上传的规矩先查）才弹确认框。
  const picker = useRef<HTMLInputElement>(null);
  const pickFor = useRef<string | null>(null);
  const [replacing, setReplacing] = useState<{ path: string; file: File } | null>(null);
  // 替换请求发出去、还没有回来：确认框的「替换」转圈、「取消」不可点，再点不会发第二次。
  const [swapping, setSwapping] = useState(false);

  const pick = (path: string) => {
    pickFor.current = path;
    if (picker.current) {
      picker.current.value = ""; // 连着两次选同一个文件也要触发
      picker.current.click();
    }
  };
  const picked = (file: File | undefined) => {
    const path = pickFor.current;
    pickFor.current = null;
    if (!file || !path) return;
    const refused = unsupportedTypeText(info, file) ?? tooLargeText(info, file);
    if (refused) toast.error(refused);
    else setReplacing({ path, file });
  };
  const replace = async () => {
    if (!replacing || swapping) return;
    const { path, file } = replacing;
    setSwapping(true);
    try {
      const r = await api.replaceMaterial(taskId, path, file);
      forgetDocx(taskId, path);
      forgetDocx(taskId, r.path);
      forgetPdf(taskId, path);
      forgetPdf(taskId, r.path);
      const [was, now] = [fileName(path), fileName(r.path)];
      toast.success(was === now ? `已替换材料《${was}》。` : `已把材料《${was}》替换成《${now}》。`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "替换没有成功。");
      // 被拒绝多半是它刚进入了对话：重读一次，让「替换」按新的情况显示。
      onChanged();
    } finally {
      setSwapping(false);
      setReplacing(null);
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
                <td className="nm">
                  {/\.docx$/i.test(m.path) ? <FileWordOutlined className="fic" /> : /\.pdf$/i.test(m.path) ? <FilePdfOutlined className="fic" /> : <FileTextOutlined className="fic" />}{fileName(m.path)}
                  {m.pdf && <span className="tp-mnote" data-testid="material-pdf">{pdfSummary(m.pdf)}</span>}
                </td>
                <td className="num">{formatBytes(m.bytes)}</td>
                <td className="num">{formatTimeShort(m.modified_at)}</td>
                <td>
                  <a className="tp-lnk" role="button" onClick={() => onView(m)} data-testid="material-view">查看</a>
                  {!closed && m.deletable && <a className="tp-lnk quiet" role="button" onClick={() => pick(m.path)} data-testid="material-replace">替换</a>}
                  {!closed && !m.deletable && <span className="tp-lnk off" aria-disabled="true" title={ENTERED_REPLACE_HINT} data-testid="material-replace-off">替换</span>}
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
              // PDF 要等一会儿：先说一句，结果出来时原地换成结果（同一个 key）。
              const waiting = pdfUploadingText((file as File).name);
              const same = waiting ? { key: `upload:${(file as File).name}` } : undefined;
              if (waiting && same) toast.running(same.key, waiting);
              try {
                const r = await api.uploadMaterial(taskId, file as File);
                toast.success(`已上传：${r.path}`, same);
                onSuccess?.({});
                onChanged();
              } catch (e) {
                toast.error(e instanceof ApiError ? e.message : "上传没有成功。", same);
                onError?.(e as Error);
              }
            }}
          >
            <UploadOutlined className="up" />
            <span data-testid="upload-hint">{uploadHintText(info)}</span>
          </Upload.Dragger>
        </div>
      )}
      {/* 替换用的文件选择框：放在上传区之后，看不见，由「替换」打开。 */}
      {!closed && <input ref={picker} type="file" accept={uploadAccept(info)} hidden onChange={(e) => picked(e.target.files?.[0])} data-testid="material-replace-input" />}
      <Modal title={replacing ? `用《${replacing.file.name}》替换材料《${fileName(replacing.path)}》？` : ""} open={!!replacing}
        onCancel={() => { if (!swapping) setReplacing(null); }} onOk={() => void replace()} okText="替换" cancelText="取消" confirmLoading={swapping}
        cancelButtonProps={{ disabled: swapping }} closable={!swapping} maskClosable={!swapping} keyboard={!swapping} destroyOnHidden>
        <p>用新文件替换这份材料，旧文件就没有了；助手下次开始会话时看到的是新文件。</p>
      </Modal>
      <Modal title={deleting ? `删除材料《${fileName(deleting)}》？` : ""} open={!!deleting} onCancel={() => { if (!removing) setDeleting(null); }}
        onOk={() => void remove()} okText="删除" cancelText="取消" confirmLoading={removing} cancelButtonProps={{ disabled: removing }}
        closable={!removing} maskClosable={!removing} keyboard={!removing} destroyOnHidden>
        <p>删除之后这份材料就没有了，助手下次开始会话时不会再看到它。</p>
      </Modal>
    </section>
  );
}
