// 知识库页面（#/knowledge，带库编号时选中那个库）：左边是库的清单（新建、改名、删除），右边是选中的库里的文档表格与上传框。
// 通用库每个任务都会用到，不能改名、不能删除。文档没有版本：一份文档改了，就当作一份新文件上传。
// 上传前先选「这是什么资料」（五种种类，只是标签）；类型与大小按服务信息里知识库那一项先查，不符的不发请求。

import { useEffect, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Spin, Upload } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api, ApiError } from "../api/client";
import type { KnowledgeKind, KnowledgeLibrary } from "../api/types";
import { Shell } from "../components/Shell";
import { useToast } from "../components/Toasts";
import { useService } from "../components/ServiceControls";
import { formatBytes, formatTime } from "../model/format";
import { GENERAL, docCountText, kindName, knowledgeLimitText, knowledgeTooLargeText, sortedLibraries, usageText } from "../model/knowledge";
import { go, href } from "../router";

/** 新建库与改名共用的填名字对话框。 */
type NameDialog = { mode: "create" } | { mode: "rename"; id: string; name: string };

export function KnowledgePage({ libraryId }: { libraryId: string | null }) {
  const [libraries, setLibraries] = useState<KnowledgeLibrary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<NameDialog | null>(null);
  const [name, setName] = useState("");
  const [removingLib, setRemovingLib] = useState<KnowledgeLibrary | null>(null);
  const [removingDoc, setRemovingDoc] = useState<string | null>(null);
  const toast = useToast();
  const service = useService();
  const kinds = service.info?.knowledge_upload?.kinds ?? [];
  const [kind, setKind] = useState<KnowledgeKind | null>(null);
  const chosenKind = kind ?? kinds[0]?.kind ?? "standard";

  const load = () => api.knowledge().then((list) => { setLibraries(list); setError(null); })
    .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  useEffect(() => { void load(); }, []);

  if (error) return <Shell nav="knowledge"><Alert type="error" showIcon message={error} /></Shell>;
  if (!libraries) return <Shell nav="knowledge"><Spin /></Shell>;

  const libs = sortedLibraries(libraries);
  const current = libs.find((l) => l.id === libraryId) ?? libs[0] ?? null;
  const fail = (e: unknown, text: string) => toast.error(e instanceof ApiError ? e.message : text);

  const saveName = async () => {
    if (!dialog) return;
    try {
      if (dialog.mode === "create") {
        const created = await api.createLibrary(name);
        toast.success(`已新建库「${created.name}」。`);
        go(href.knowledge(created.id));
      } else {
        await api.renameLibrary(dialog.id, name);
        toast.success(`已把库「${dialog.name}」改名为「${name.trim()}」。`);
      }
      setDialog(null);
      void load();
    } catch (e) {
      fail(e, dialog.mode === "create" ? "新建库没有成功。" : "改名没有成功。");
    }
  };

  const removeLibrary = async () => {
    const lib = removingLib;
    if (!lib) return;
    try {
      await api.deleteLibrary(lib.id);
      toast.success(`已删除库「${lib.name}」。`);
      setRemovingLib(null);
      go(href.knowledge());
      void load();
    } catch (e) {
      fail(e, "删除没有成功。");
    }
  };

  const removeDocument = async () => {
    if (!current || !removingDoc) return;
    try {
      await api.deleteDocument(current.id, removingDoc);
      toast.success(`已删除文档《${removingDoc}》。`);
      setRemovingDoc(null);
      void load();
    } catch (e) {
      fail(e, "删除没有成功。");
    }
  };

  const typesText = service.info?.knowledge_upload?.types_text;
  const limitText = knowledgeLimitText(service.info);
  const extensions = service.info?.knowledge_upload?.extensions;

  return (
    <Shell nav="knowledge" libraries={libs.length}>
      <div className="page-title" style={{ justifyContent: "space-between" }}>
        <div className="page-title"><h1>知识库</h1></div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setName(""); setDialog({ mode: "create" }); }} data-testid="kb-new-library">新建一个库</Button>
      </div>
      <p className="lede">知识库里放的是整理材料时用来参考的资料。助手只在任务选用的库里查找。</p>
      <div className="kbgrid">
        <div className="card kblibs" data-testid="kb-libraries">
          <div className="cap">一共 {libs.length} 个库</div>
          {libs.map((l) => (
            <div key={l.id} className={`kblib${l.id === current?.id ? " on" : ""}`} onClick={() => go(href.knowledge(l.id))} data-testid={`kb-lib-${l.id}`}>
              <div className="ln">{l.name}{l.id === GENERAL && <span className="chip def">默认选用</span>}</div>
              <div className="lm">{docCountText(l)} · {usageText(l)}</div>
            </div>
          ))}
        </div>
        {current && (
          <div className="card" data-testid="kb-pane">
            <div className="kbhead">
              <h2>{current.name}</h2>
              {current.id === GENERAL && <span className="chip def">默认选用</span>}
              <span className="sp" />
              {current.id !== GENERAL && <Button size="small" onClick={() => { setName(current.name); setDialog({ mode: "rename", id: current.id, name: current.name }); }}>改名</Button>}
              {current.id !== GENERAL && <Button size="small" onClick={() => setRemovingLib(current)} data-testid="kb-delete-library">删除这个库</Button>}
            </div>
            <div className="kbmeta">
              {current.documents.length} 份文档。{current.id === GENERAL ? "每个任务都会用到。新建的任务会自动选用它，也不能去掉。" : `${usageText(current)}。`}
            </div>
            <div className="flabel">这是什么资料（上传之前先选好）</div>
            <div className="updest-seg" data-testid="kb-kind">
              {kinds.map((k) => (
                <label key={k.kind} className={chosenKind === k.kind ? "on" : ""}>
                  <input type="radio" name="kb-kind" checked={chosenKind === k.kind} onChange={() => setKind(k.kind)} />{k.name}
                </label>
              ))}
            </div>
            <Upload.Dragger accept={extensions?.join(",")} showUploadList={false} style={{ marginTop: "0.6rem" }} multiple
              customRequest={async ({ file, onSuccess, onError }) => {
                const f = file as File;
                const ok = !extensions || extensions.some((ext) => f.name.toLowerCase().endsWith(ext));
                const wrongType = ok ? null : service.info?.knowledge_upload?.unsupported_type_text ?? null;
                const refused = wrongType ?? knowledgeTooLargeText(service.info, f);
                if (refused) {
                  toast.error(refused);
                  onError?.(new Error(refused));
                  return;
                }
                try {
                  await api.uploadDocument(current.id, f, chosenKind);
                  toast.success(`已放进「${current.name}」：${f.name}。`);
                  onSuccess?.({});
                  void load();
                } catch (e) {
                  fail(e, "上传没有成功。");
                  onError?.(e as Error);
                }
              }}>
              <span className="muted small" data-testid="kb-upload-hint">
                把文件拖到这里，或者点这里选择文件，放进「{current.name}」{typesText && limitText ? `（只接受 ${typesText}，${limitText}；PDF 暂时不接受，下一版起支持）` : ""}。
              </span>
            </Upload.Dragger>
            {current.documents.length === 0
              ? <Empty description="这个库里还没有文档。" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              : (
                <table className="kbtable" data-testid="kb-documents">
                  <thead><tr><th>文档名</th><th>种类</th><th>大小</th><th>上传时间</th><th>操作</th></tr></thead>
                  <tbody>
                    {current.documents.map((d) => (
                      <tr key={d.name}>
                        <td className="dn">{d.name}</td>
                        <td>{kindName(service.info, d.kind)}</td>
                        <td>{formatBytes(d.bytes)}</td>
                        <td>{formatTime(d.uploaded_at)}</td>
                        <td><a role="button" onClick={() => setRemovingDoc(d.name)}>删除</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            <div className="kbfoot">文档没有版本：一份文档改了，就当作一份新文件上传。助手在任务里看到的是所选用的库的文档清单（名称、种类、一句话说明），需要时到文档里查找相关的片段。</div>
          </div>
        )}
      </div>

      <Modal title={dialog?.mode === "rename" ? `给库「${dialog.name}」改名` : "新建一个库"} open={!!dialog} onCancel={() => setDialog(null)}
        onOk={() => void saveName()} okText={dialog?.mode === "rename" ? "改名" : "新建"} cancelText="取消" okButtonProps={{ disabled: !name.trim() }} destroyOnHidden>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="库的名字，例如：城北区图书馆的资料" onPressEnter={() => name.trim() && void saveName()}
          data-testid="kb-name-input" autoFocus />
      </Modal>
      <Modal title={removingLib ? `删除库「${removingLib.name}」？` : ""} open={!!removingLib} onCancel={() => setRemovingLib(null)}
        onOk={() => void removeLibrary()} okText="删除" cancelText="取消" destroyOnHidden>
        <p>{removingLib ? `库里的 ${removingLib.documents.length} 份文档会一并删除。选用了这个库的任务会自动不再选用它。` : ""}</p>
      </Modal>
      <Modal title={removingDoc ? `删除文档《${removingDoc}》？` : ""} open={!!removingDoc} onCancel={() => setRemovingDoc(null)}
        onOk={() => void removeDocument()} okText="删除" cancelText="取消" destroyOnHidden>
        <p>删除之后，已经引用它的条目上的来源仍然保留，出处旁会写明这份文档已经不在知识库里。</p>
      </Modal>
    </Shell>
  );
}
