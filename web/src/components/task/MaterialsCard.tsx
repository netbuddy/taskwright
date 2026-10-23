// 任务起点页与活动输入页的材料卡：材料清单（名称、大小、上传时间、「查看」；还没有进入对话的材料另有「替换」与「删除」）与上传区。
// 这里上传的一律是材料，不问去向；参考文档在知识库页面上传。材料一旦进入了对话（上传之后有会话活动过）就不能删除、也不能替换，
// 后端在任务详情里给每份材料标了 deletable，这里只按它决定：为真时「替换」与「删除」都可以点；为假时没有「删除」，
// 「替换」是灰的、点不动，鼠标停在上面说明为什么。任务已结束时这两样都没有，也没有上传区。
// 文件缺失的材料（后端标了 missing：从不带材料的数据包导入、还没补齐）在大小一栏写「文件缺失，请补齐」，「查看」是灰的，没有替换与删除，
// 有「补齐」（选一份文件上传，与导出时的指纹核对；原件不是导出时那份的不收）。

import type { ReactNode } from "react";
import { Upload } from "antd";
import { FileTextOutlined, FilePdfOutlined, FileWordOutlined, UploadOutlined } from "@ant-design/icons";
import type { Material, ServiceInfo } from "../../api/types";
import { formatBytes, formatTimeShort } from "../../model/format";
import { uploadAccept, uploadLimitText, uploadTypesText } from "../../model/upload";
import { fileName, useMaterialOps } from "./materialOps";

/** 已经进入对话的材料不能替换：灰色的「替换」上鼠标悬停时写的说明（与后端拒绝时的原话相同）。 */
export const ENTERED_REPLACE_HINT = "这份输入资料已经进入了对话，不能替换；请上传一份新的，并告诉助手以新的为准。";

/** 文件缺失的材料在大小一栏写的话。 */
export const MISSING_FILE_TEXT = "文件缺失，请补齐";

/** 上传区的说明：类型与大小两半句取自服务信息；还没取到时只写前一句，不猜。 */
export function uploadHintText(info: ServiceInfo | null): string {
  const parts = [uploadTypesText(info), uploadLimitText(info)].filter(Boolean);
  return `把文件拖到这里，或者点这里选择文件。${parts.length ? `${parts.join("，")}。` : ""}`;
}

/** PDF 材料名字后面的那句：共几页，有几页没有可读的文字（都读出了文字时不写后半句）。 */
export function pdfSummary(pdf: { pages: number; no_text_pages: number[] }): string {
  return `${pdf.pages} 页${pdf.no_text_pages.length > 0 ? `，其中 ${pdf.no_text_pages.length} 页没有可读的文字` : ""}`;
}

export function MaterialsCard({ taskId, materials, info, onView, onChanged, title = "输入资料", aside, intro, marked = false, slot, upload = true, replace = true, testId = "materials-card", emptyText = "这个任务实例还没有输入资料。" }: {
  taskId: string;
  /** 用户放进来的材料（不含由 Word 材料生成的文件）。 */
  materials: Material[];
  info: ServiceInfo | null;
  onView: (material: Material) => void;
  /** 上传、替换或删除成功之后：重读任务。 */
  onChanged: () => void;
  /** 卡片的标题；活动输入页上叫「项目材料」。 */
  title?: string;
  /** 份数后面的一句小字，例如「可选 · 推荐」。 */
  aside?: string;
  /** 标题下面、清单上面的说明；活动输入页在这里写适合上传哪几类文件。 */
  intro?: ReactNode;
  /** 这张卡是不是页面现在要用户先看的那一块：是的话描黑边。 */
  marked?: boolean;
  /** 这张卡上传的材料放进哪个槽位（活动输入页按槽位分块时给）；不给是不经槽位上传。 */
  slot?: string;
  /** 有没有上传区。 */
  upload?: boolean;
  /** 有没有「替换」：一个值管整张卡，或者按每份材料定（输入页按槽位分块时，没有放进槽位的材料不能替换：替换会沿用空的槽位）。 */
  replace?: boolean | ((material: Material) => boolean);
  testId?: string;
  /** 清单是空的时那一句；按槽位分块的卡写「还没有放进这一块的材料。」。 */
  emptyText?: string;
}) {
  const ops = useMaterialOps(taskId, info, onChanged, slot);
  const canReplace = (m: Material) => (typeof replace === "function" ? replace(m) : replace);

  return (
    <section className={`tp-pane${marked ? " marked" : ""}`} aria-label={title} data-testid={testId}>
      <div className="tp-sec-h">
        <h2><FileTextOutlined className="tp-hic" />{title}</h2><span className="cnt" data-testid="material-count">{materials.length} 份</span>
        {aside && <span className="aside">{aside}</span>}
      </div>
      {intro}
      {materials.length === 0 ? <div className="tp-none">{emptyText}</div> : (
        <table className="tp-mtable">
          <thead><tr><th>名称</th><th>大小</th><th>上传时间</th><th>操作</th></tr></thead>
          <tbody>
            {materials.map((m) => (
              <tr key={m.path} data-testid="material-row">
                <td className="nm">
                  {/\.docx$/i.test(m.path) ? <FileWordOutlined className="fic" /> : /\.pdf$/i.test(m.path) ? <FilePdfOutlined className="fic" /> : <FileTextOutlined className="fic" />}{fileName(m.path)}
                  {m.pdf && <span className="tp-mnote" data-testid="material-pdf">{pdfSummary(m.pdf)}</span>}
                  {m.role && <span className="tp-mrole" data-testid="material-role">{m.role}</span>}
                </td>
                <td className="num" data-testid={m.missing ? "material-missing" : undefined}>{m.missing ? MISSING_FILE_TEXT : formatBytes(m.bytes)}</td>
                <td className="num">{formatTimeShort(m.modified_at)}</td>
                {m.missing ? (
                  <td>
                    <span className="tp-lnk off" aria-disabled="true" data-testid="material-view-off">查看</span>
                    {ops.busy === m.path
                      ? <span className="tp-lnk off" aria-disabled="true" data-testid="material-replenish-busy">补齐中</span>
                      : <a className="tp-lnk" role="button" onClick={() => ops.replenish(m.path)} data-testid="material-replenish">补齐</a>}
                  </td>
                ) : (
                  <td>
                    <a className="tp-lnk" role="button" onClick={() => onView(m)} data-testid="material-view">查看</a>
                    {canReplace(m) && m.deletable && <a className="tp-lnk quiet" role="button" onClick={() => ops.replace(m.path)} data-testid="material-replace">替换</a>}
                    {canReplace(m) && !m.deletable && <span className="tp-lnk off" aria-disabled="true" title={ENTERED_REPLACE_HINT} data-testid="material-replace-off">替换</span>}
                    {m.deletable && <a className="tp-lnk quiet" role="button" onClick={() => ops.remove(m.path)} data-testid="material-delete">删除</a>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {upload && <div className="tp-drop">
        {/* 可以一次选几份。filter: "native" 只让文件选择框按类型过滤：拖进来的几份照样交给上传处理，类型不符的由它报那句话，
            不被悄悄丢掉（多选时上传组件默认按 accept 筛掉拖进来的文件）。 */}
        <Upload.Dragger
          accept={{ format: uploadAccept(info) ?? "", filter: "native" }}
          showUploadList={false}
          multiple
          customRequest={ops.upload}
        >
          <UploadOutlined className="up" />
          <span data-testid="upload-hint">{uploadHintText(info)}</span>
        </Upload.Dragger>
      </div>}
      {ops.elements}
    </section>
  );
}
