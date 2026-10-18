// 工作台中栏「材料与证据」页签：本项目的材料与选用的知识库，版式照业务说明的节页（.oa-page）。
//   · 项目材料一张表：名称、类型、大小、上传时刻、被几节几处引用（model/assetTabs.ts 的 materialCitations）、「查看」「替换」「删除」。
//     「查看」在右侧栏「原文定位」里打开这份材料；替换与删除只对还没有进入对话的材料可用（任务详情里的 deletable），
//     操作与任务起点页的材料卡相同（components/task/materialOps.tsx）。右上角「上传材料」。
//   · 选用的知识库一张表：名称、文档份数、本项目的条目引用了几处、「查看」「取消选用」；一个都没选时写一句；表下「选用别的知识库」。
//     服务没有知识库这一功能时整块不显示。
// 材料清单与选用的知识库都取自任务详情（GET …/tasks/{task_id}）：打开这一页时取一次，材料增删（事件流推来的材料清单变了）与改选用之后再取。

import { useEffect, useState } from "react";
import { Upload } from "antd";
import { FilePdfOutlined, FileTextOutlined, FileWordOutlined, UploadOutlined } from "@ant-design/icons";
import { api, ApiError } from "../../api/client";
import type { KnowledgeLibrary, Material, ServiceInfo, Task, TaskDetail } from "../../api/types";
import { citationText, libraryCitations, materialCitations, materialKind } from "../../model/assetTabs";
import { ownMaterials } from "../../model/docx";
import { formatBytes, formatTimeShort } from "../../model/format";
import { docCountText } from "../../model/knowledge";
import { uploadAccept } from "../../model/upload";
import { href } from "../../router";
import { KnowledgePickButton } from "../TaskKnowledgeCard";
import { ENTERED_REPLACE_HINT } from "../task/MaterialsCard";
import { fileName, useMaterialOps } from "../task/materialOps";
import { useToast } from "../Toasts";

/** 页上的一句说明。 */
export const MATERIALS_LEAD = "本项目的材料与选用的知识库。每份材料被哪些节引用由「核读材料」记录；点「查看」在右侧栏对照原文。上传后需启动「核读材料」才会进入业务说明。";

export function MaterialsTab({ task, materials, info, libraries, readOnly, onView }: {
  task: Task;
  /** 工作台手里的材料清单（随事件流更新）：它变了就重取任务详情。 */
  materials: Material[];
  info: ServiceInfo | null;
  /** 知识库清单；服务没有知识库这一功能时不给（不显示知识库一块），还没取到时是 null。 */
  libraries?: KnowledgeLibrary[] | null;
  readOnly: boolean;
  /** 「查看」：在右侧栏原文定位里打开这份材料。 */
  onView: (path: string) => void;
}) {
  const toast = useToast();
  const taskId = task.task_id;
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const load = () => { api.getTask(taskId).then(setDetail).catch(() => undefined); };
  const paths = materials.map((one) => one.path).join("\n");
  useEffect(load, [taskId, paths]);
  const ops = useMaterialOps(taskId, info, load);
  const all = detail?.materials ?? materials;
  const own = ownMaterials(all);
  const selected = detail?.knowledge_libraries ?? [];
  const chosen = libraries ? libraries.filter((one) => selected.includes(one.id)) : [];

  const changeKnowledge = async (ids: string[]) => {
    try {
      await api.setTaskKnowledge(taskId, ids);
      load();
      return true;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "选用的知识库没有改成。");
      return false;
    }
  };

  return (
    <div className="oa-page ap-page" data-testid="materials-tab">
      <div className="ap-head">
        <h2>材料与证据</h2>
        {!readOnly && (
          <Upload accept={uploadAccept(info)} showUploadList={false} customRequest={ops.upload}>
            <button type="button" className="btn sm" data-testid="materials-upload"><UploadOutlined /> 上传材料</button>
          </Upload>
        )}
      </div>
      <p className="ap-lead">{MATERIALS_LEAD}</p>

      <section className="oa-blk">
        <h3>项目材料<small data-testid="materials-count">{own.length} 份</small></h3>
        {own.length === 0 ? <p className="oa-empty">这个任务还没有材料。点右上角「上传材料」。</p> : (
          <div className="oa-tablebox">
            <table className="oa-table ap-table" data-testid="materials-table">
              <thead><tr><th>材料</th><th>类型</th><th>大小</th><th>上传</th><th>被引用</th><th /></tr></thead>
              <tbody>
                {own.map((m) => (
                  <tr key={m.path} data-testid="materials-row">
                    <td className="nm">
                      {/\.docx$/i.test(m.path) ? <FileWordOutlined className="fic" /> : /\.pdf$/i.test(m.path) ? <FilePdfOutlined className="fic" /> : <FileTextOutlined className="fic" />}
                      {fileName(m.path)}
                    </td>
                    <td className="mut">{materialKind(m.path)}</td>
                    <td className="mut num">{formatBytes(m.bytes)}</td>
                    <td className="mut num">{formatTimeShort(m.modified_at)}</td>
                    <td data-testid="materials-cited">{citationText(materialCitations(task, all, m.path))}</td>
                    <td className="acts">
                      <a className="ap-lnk" role="button" onClick={() => onView(m.path)} data-testid="materials-view">查看</a>
                      {!readOnly && (m.deletable
                        ? <>
                            <a className="ap-lnk" role="button" onClick={() => ops.replace(m.path)} data-testid="materials-replace">替换</a>
                            <a className="ap-lnk" role="button" onClick={() => ops.remove(m.path)} data-testid="materials-delete">删除</a>
                          </>
                        : <span className="ap-lnk off" aria-disabled="true" title={ENTERED_REPLACE_HINT} data-testid="materials-replace-off">替换</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {libraries !== undefined && (
        <section className="oa-blk" data-testid="materials-knowledge">
          <h3>选用的知识库<small>{chosen.length} 个</small></h3>
          {libraries === null ? <p className="oa-empty">正在读知识库清单。</p> : (
            <div className="oa-tablebox">
              <table className="oa-table ap-table" data-testid="knowledge-table">
                <thead><tr><th>知识库</th><th>文档</th><th>本项目引用</th><th /></tr></thead>
                <tbody>
                  {chosen.length === 0 && <tr><td colSpan={4} className="mut" data-testid="knowledge-none">这个任务还没有选用知识库，助手查不到参考资料。</td></tr>}
                  {chosen.map((l) => {
                    const cited = libraryCitations(task, libraries, l.id);
                    return (
                      <tr key={l.id} data-testid={`knowledge-row-${l.id}`}>
                        <td className="nm">{l.name}</td>
                        <td className="mut">{docCountText(l)}</td>
                        <td className={cited ? undefined : "mut"}>{cited ? `${cited} 处` : "还没有被引用"}</td>
                        <td className="acts">
                          <a className="ap-lnk" href={href.knowledge(l.id)}>查看</a>
                          {!readOnly && (
                            <a className="ap-lnk" role="button" onClick={() => void changeKnowledge(selected.filter((x) => x !== l.id))} data-testid={`knowledge-drop-${l.id}`}>取消选用</a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="ap-foot">
            {!readOnly && libraries && <KnowledgePickButton libraries={libraries} selected={selected} onChange={changeKnowledge} placement="bottomLeft" plain />}
            <span>助手只在这几个知识库里查找。</span>
          </div>
        </section>
      )}
      {ops.elements}
    </div>
  );
}
