// 知识库页面（#/knowledge，带库编号时选中那个库）：左边是库的清单（新建、改名、删除），右边是选中的库里的文档表格与上传框。
// 通用知识库每个任务都会用到，不能改名、不能删除。文档没有版本：一份文档改了，就当作一份新文件上传。
// 上传前先选「这是什么资料」（五种种类，只是标签）；类型与大小按服务信息里知识库那一项先查，不符的不发请求。
// 文档要换算成数字串之后才能按意思查找：文档表格里每份文档有换算状态，表格上面一行是这个知识库「已换算几份 / 一共几份」与进度条；
// 选了嵌入模型而且有没换算的文档时给「开始换算」，换算失败的文档给「重试」。有文档在等待换算或者换算中时，隔两秒再取一次清单。
// 文档表格下面是「试一试按意思查找」（components/KnowledgeSearchBox.tsx），只查选中的这一个知识库。

import { Fragment, useEffect, useState } from "react";
import { Alert, Button, Empty, Input, Modal, Spin, Upload } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api, ApiError } from "../api/client";
import type { EmbeddedLibrary, KnowledgeKind, KnowledgeOverview } from "../api/types";
import { KnowledgeSearchBox } from "../components/KnowledgeSearchBox";
import { Shell } from "../components/Shell";
import { useToast } from "../components/Toasts";
import { useService } from "../components/ServiceControls";
import { formatBytes, formatTime } from "../model/format";
import {
  GENERAL, docCountText, embeddingBusy, embeddingModelName, embeddingPolling, embeddingStatusText, kindName, knowledgeLimitText, knowledgeTooLargeText,
  sortedLibraries, usageText,
} from "../model/knowledge";
import { go, href } from "../router";

/** 新建库与改名共用的填名字对话框。 */
type NameDialog = { mode: "create" } | { mode: "rename"; id: string; name: string };

export function KnowledgePage({ libraryId }: { libraryId: string | null }) {
  const [overview, setOverview] = useState<KnowledgeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<NameDialog | null>(null);
  const [name, setName] = useState("");
  const [removingLib, setRemovingLib] = useState<EmbeddedLibrary | null>(null);
  const [removingDoc, setRemovingDoc] = useState<string | null>(null);
  const toast = useToast();
  const service = useService();
  const kinds = service.info?.knowledge_upload?.kinds ?? [];
  const [kind, setKind] = useState<KnowledgeKind | null>(null);
  const chosenKind = kind ?? kinds[0]?.kind ?? "standard";

  // quiet：隔两秒自动取的那一次没取到时不换成报错的页面，留着上一次的内容，下一次再取。
  const load = (quiet = false) => api.knowledgeOverview().then((got) => { setOverview(got); setError(null); })
    .catch((e) => { if (!quiet) setError(e instanceof ApiError ? e.message : String(e)); });
  useEffect(() => { void load(); }, []);
  const running = overview?.embedding.running ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(true), embeddingPolling.intervalMs);
    return () => clearInterval(timer);
  }, [running]);

  if (error) return <Shell nav="knowledge"><Alert type="error" showIcon message={error} /></Shell>;
  if (!overview) return <Shell nav="knowledge"><Spin /></Shell>;

  const embedding = overview.embedding;
  const libs = sortedLibraries(overview.libraries);
  const current = libs.find((l) => l.id === libraryId) ?? libs[0] ?? null;
  const fail = (e: unknown, text: string) => toast.error(e instanceof ApiError ? e.message : text);

  const saveName = async () => {
    if (!dialog) return;
    try {
      if (dialog.mode === "create") {
        const created = await api.createLibrary(name);
        toast.success(`已新建知识库「${created.name}」。`);
        go(href.knowledge(created.id));
      } else {
        await api.renameLibrary(dialog.id, name);
        toast.success(`已把知识库「${dialog.name}」改名为「${name.trim()}」。`);
      }
      setDialog(null);
      void load();
    } catch (e) {
      fail(e, dialog.mode === "create" ? "新建知识库没有成功。" : "改名没有成功。");
    }
  };

  const removeLibrary = async () => {
    const lib = removingLib;
    if (!lib) return;
    try {
      await api.deleteLibrary(lib.id);
      toast.success(`已删除知识库「${lib.name}」。`);
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

  /** 开始换算：不给文档名是这个知识库里还没有换算好的全部，给了是那一份（换算失败之后重试）。 */
  const embed = async (library: string, name?: string) => {
    try {
      await api.embedKnowledge(name === undefined ? { library } : { library, name });
      void load();
    } catch (e) {
      fail(e, "没能开始换算。");
    }
  };
  /** 「开始换算」在什么时候给：选了嵌入模型，这个知识库里有没换算好的文档，而且没有文档正在算或者等着算。 */
  const canStart = (lib: EmbeddedLibrary) => embedding.model !== null && lib.embedding.done < lib.embedding.total && !embeddingBusy(lib);

  const typesText = service.info?.knowledge_upload?.types_text;
  const limitText = knowledgeLimitText(service.info);
  const extensions = service.info?.knowledge_upload?.extensions;

  return (
    <Shell nav="knowledge" libraries={libs.length}>
      <div className="page-title" style={{ justifyContent: "space-between" }}>
        <div className="page-title"><h1>知识库</h1></div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setName(""); setDialog({ mode: "create" }); }} data-testid="kb-new-library">新建一个知识库</Button>
      </div>
      <p className="lede">知识库里放的是整理材料时用来参考的资料。助手只在任务选用的知识库里查找。</p>
      <div className="kbgrid">
        <div className="card kblibs" data-testid="kb-libraries">
          <div className="cap">一共 {libs.length} 个知识库</div>
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
              {current.id !== GENERAL && <Button size="small" onClick={() => setRemovingLib(current)} data-testid="kb-delete-library">删除这个知识库</Button>}
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
            {current.documents.length > 0 && (
              <div className="kbembed" data-testid="kb-embedding">
                {embedding.model === null ? (
                  <span>还没有选嵌入模型，这些文档没有换算：助手查知识库只按字面找，用词不同的找不到。<a href={href.settings()}>去设置里选</a></span>
                ) : (
                  <>
                    <span className="en" data-testid="kb-embedding-count">已换算 {current.embedding.done} / {current.embedding.total}</span>
                    <span className="kbbar" role="progressbar" aria-valuemin={0} aria-valuemax={current.embedding.total} aria-valuenow={current.embedding.done}>
                      <span style={{ width: `${(current.embedding.done / current.embedding.total) * 100}%` }} />
                    </span>
                    <span className="em">嵌入模型：{embeddingModelName(embedding.model)}</span>
                    {canStart(current) && <Button size="small" onClick={() => void embed(current.id)} data-testid="kb-embed-start">开始换算</Button>}
                    {embedding.stopped_reason && <span className="es" data-testid="kb-embedding-stopped">换算停下了：{embedding.stopped_reason}</span>}
                  </>
                )}
              </div>
            )}
            {current.documents.length === 0
              ? <Empty description="这个知识库里还没有文档。" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              : (
                <table className="kbtable" data-testid="kb-documents">
                  <thead><tr><th>文档名</th><th>种类</th><th>大小</th><th>上传时间</th><th>换算</th><th>操作</th></tr></thead>
                  <tbody>
                    {current.documents.map((d) => {
                      // 换算失败的原因可能很长：写在这份文档下面单独的一行里，横跨整张表，不把「换算」那一列撑宽。
                      const failed = d.embedding.status === "failed";
                      return (
                        <Fragment key={d.name}>
                          <tr className={failed ? "failed" : undefined}>
                            <td className="dn">{d.name}</td>
                            <td>{kindName(service.info, d.kind)}</td>
                            <td>{formatBytes(d.bytes)}</td>
                            <td>{formatTime(d.uploaded_at)}</td>
                            <td className={`de ${d.embedding.status}`} data-testid={`kb-doc-embedding-${d.name}`}>
                              {embeddingStatusText(d.embedding)}
                              {failed && embedding.model !== null && <a role="button" className="retry" onClick={() => void embed(current.id, d.name)}>重试</a>}
                            </td>
                            <td><a role="button" onClick={() => setRemovingDoc(d.name)}>删除</a></td>
                          </tr>
                          {failed && <tr className="why"><td colSpan={6} data-testid={`kb-doc-embedding-error-${d.name}`}>{d.embedding.error}</td></tr>}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            {current.documents.length > 0 && <KnowledgeSearchBox key={current.id} library={current} model={embedding.model} />}
            <div className="kbfoot">文档没有版本：一份文档改了，就当作一份新文件上传。助手在任务里看到的是所选用的知识库的文档清单（名称、种类、大小），需要时到文档里查找相关的片段。</div>
          </div>
        )}
      </div>

      <Modal title={dialog?.mode === "rename" ? `给知识库「${dialog.name}」改名` : "新建一个知识库"} open={!!dialog} onCancel={() => setDialog(null)}
        onOk={() => void saveName()} okText={dialog?.mode === "rename" ? "改名" : "新建"} cancelText="取消" okButtonProps={{ disabled: !name.trim() }} destroyOnHidden>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="知识库的名字，例如：城北区图书馆的资料" onPressEnter={() => name.trim() && void saveName()}
          data-testid="kb-name-input" autoFocus />
      </Modal>
      <Modal title={removingLib ? `删除知识库「${removingLib.name}」？` : ""} open={!!removingLib} onCancel={() => setRemovingLib(null)}
        onOk={() => void removeLibrary()} okText="删除" cancelText="取消" destroyOnHidden>
        <p>{removingLib ? `这个知识库里的 ${removingLib.documents.length} 份文档会一并删除。选用了这个知识库的任务会自动不再选用它。` : ""}</p>
      </Modal>
      <Modal title={removingDoc ? `删除文档《${removingDoc}》？` : ""} open={!!removingDoc} onCancel={() => setRemovingDoc(null)}
        onOk={() => void removeDocument()} okText="删除" cancelText="取消" destroyOnHidden>
        <p>删除之后，已经引用它的条目上的来源仍然保留，出处旁会写明这份文档已经不在知识库里。</p>
      </Modal>
    </Shell>
  );
}
