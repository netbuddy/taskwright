// 工作台中栏「文档与版本」页签，版式照业务说明的节页（.oa-page）。自上而下：
//   · 页头「文档与版本」，右边「生成文档」（打开生成文档对话框：选修订、选条目、预览与下载）与「发布第 N 版」。发布的条件与绿色提示条相同
//     （model/docsPage.ts 的 publishOff），不能点时灰着并悬停说明；点了打开条目区里那个发布框（可写发布说明），发出去由工作视图做。
//   · 文档：「预览」在页里展开最新修订生成的文档（再点收起）；「下载 Word」「下载 Markdown」下载最新修订的整份文档。
//   · 按章覆盖：文档的各章一行（前七章是业务说明，其后每个集合一章），写节数、条目数、图数、有没有导语，空章标出。
//   · 发布前检查：完成条件逐条，满足的打勾，没满足的写差什么并给去补的入口；下面一组非阻断提示，每条也给入口。
//     完成条件全部满足时这张表收成一句。入口怎样走由条目区做（onGo）。两张表的算法在 model/docsCheck.ts。
//   · 版本：发布过的各版一张表（版本、发布时刻与谁、修订、说明、存档下载），点「修订 N」在右侧栏修订页签里选中那次修订；表下「与上一版的差异」一句。
//     各版的存档在不在、图存了没有以版本接口为准：版本列表变了（发布了新的一版）就重取一次；取到之前先照整份数据里的那一份画。
//   · 追溯：一句（model/docsPage.ts 的 traceLine）。生成的文档最后有追溯附录，写每个需求条目依据了哪几节、哪几张图。

import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "../../api/client";
import type { Task, VersionView } from "../../api/types";
import { differenceLine, publishOff, traceLine } from "../../model/docsPage";
import { type GoTarget, checkRows, coverageRows, hints } from "../../model/docsCheck";
import { toc } from "../../model/chapters";
import { saveBlob } from "../../model/download";
import { figuresOf, figuresText, missingArchiveText, nextVersionNo, versionMeta } from "../../model/versions";
import { figurePngs } from "../diagram/mermaid";
import { DocumentPreview } from "../DocumentPreview";

/** 页上的一句说明。 */
export const DOCS_LEAD = "需求规格说明由业务说明、分析模型与需求条目编排生成；发布把当前资产固化为一个版本，并存下当时生成的 Markdown 与 Word。";

export function DocsTab({ task, readOnly, writesOff, onGenerate, onPublish, publishError, onShowRevision, onGo }: {
  task: Task;
  readOnly: boolean;
  writesOff: boolean;
  /** 「生成文档」：打开生成文档对话框。 */
  onGenerate: () => void;
  /** 「发布第 N 版」：打开发布框；不给时按钮不显示。 */
  onPublish?: () => void;
  /** 上一次发布没有成的原因。 */
  publishError?: string | null;
  /** 版本表里点「修订 N」。 */
  onShowRevision: (revision: number) => void;
  /** 发布前检查里点「去补」的入口。 */
  onGo: (target: GoTarget) => void;
}) {
  const taskId = task.task_id;
  const off = publishOff(task, { readOnly, writesOff });
  const [preview, setPreview] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState<"preview" | "md" | "docx" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 预览的是最新修订：交付物有了新修订就作废，下次要用时重取。
  useEffect(() => { setPreview(null); setShowPreview(false); }, [task.latest_revision]);

  const latestText = async () => preview ?? api.previewDocument(taskId, {}).then((r) => { setPreview(r.text); return r.text; });
  const run = async (what: "preview" | "md" | "docx", job: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    try { await job(); setError(null); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(null); }
  };
  const togglePreview = () => {
    if (showPreview) { setShowPreview(false); return; }
    void run("preview", async () => { await latestText(); setShowPreview(true); });
  };
  const downloadMarkdown = () => run("md", async () => {
    saveBlob(await api.downloadDocument(taskId, {}), `${task.task_name}-修订${task.latest_revision}.md`);
  });
  const downloadWord = () => run("docx", async () => {
    const { blob, fileName } = await api.downloadDocumentDocx(taskId, {}, await figurePngs(figuresOf(await latestText())), `${task.task_name}-修订${task.latest_revision}.docx`);
    saveBlob(blob, fileName);
  });

  return (
    <div className="oa-page ap-page" data-testid="docs-tab">
      <div className="ap-head">
        <h2>文档与版本</h2>
        <span className="ap-act">
          <button type="button" className="btn sm" onClick={onGenerate} data-testid="docs-generate">生成文档</button>
          {onPublish && (
            <button type="button" className="btn sm pri" disabled={!!off} title={off ?? undefined} onClick={onPublish} data-testid="docs-publish">
              发布第 {nextVersionNo(task)} 版
            </button>
          )}
        </span>
      </div>
      <p className="ap-lead">{DOCS_LEAD}</p>
      {publishError && <p className="ap-err" role="alert" data-testid="docs-publish-error">{publishError}</p>}

      <section className="oa-blk">
        <h3>文档<small>按最新的修订 {task.latest_revision}</small></h3>
        <div className="ap-btns">
          <button type="button" className="btn sm" disabled={busy !== null} onClick={togglePreview} data-testid="docs-preview">
            {busy === "preview" ? "正在生成预览…" : showPreview ? "收起预览" : "预览"}
          </button>
          <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void downloadWord()} data-testid="docs-download-word">
            {busy === "docx" ? "正在准备 Word…" : "下载 Word"}
          </button>
          <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void downloadMarkdown()} data-testid="docs-download-md">下载 Markdown</button>
        </div>
        {error && <p className="ap-err" role="alert" data-testid="docs-error">{error}</p>}
        {showPreview && preview !== null && <div className="ap-preview" data-testid="docs-preview-body"><DocumentPreview text={preview} /></div>}
      </section>

      <Coverage task={task} />
      <PublishCheck task={task} onGo={onGo} />

      <section className="oa-blk">
        <h3>版本</h3>
        <VersionsTable taskId={taskId} versions={task.versions ?? []} onShowRevision={onShowRevision} />
        {(task.versions ?? []).length > 0 && <p className="ap-line" data-testid="docs-difference">{differenceLine(task)}</p>}
      </section>

      <section className="oa-blk">
        <h3>追溯</h3>
        <p className="ap-line" data-testid="docs-trace">{traceLine(task)}<span className="ap-note">生成的文档最后有追溯附录，逐条写出每个需求条目依据了哪几节、哪几张图。</span></p>
      </section>
    </div>
  );
}

/** 版本表：最新的一版在上。 */
function VersionsTable({ taskId, versions, onShowRevision }: { taskId: string; versions: VersionView[]; onShowRevision: (revision: number) => void }) {
  const [fetched, setFetched] = useState<VersionView[] | null>(null);
  useEffect(() => {
    let live = true;
    if (versions.length) api.listVersions(taskId).then((list) => { if (live) setFetched(list); }).catch(() => undefined);
    return () => { live = false; };
  }, [taskId, versions.length]);
  const list = [...(fetched && fetched.length >= versions.length ? fetched : versions)].sort((a, b) => b.version_no - a.version_no);
  if (list.length === 0) return <p className="oa-empty" data-testid="versions-empty">还没有发布过。完成条件都满足之后，可以在上方「发布第 1 版」。</p>;
  const archive = (one: VersionView, format: "md" | "docx", has: boolean | undefined, label: string): ReactNode => (has
    ? <a className="ap-lnk" href={api.versionDocumentHref(taskId, one.version_no, format)} data-testid={`version-${one.version_no}-${format}`}>{label}</a>
    : <span className="ap-lnk off" title={missingArchiveText(one)}>{label}</span>);
  return (
    <div className="oa-tablebox">
      <table className="oa-table ap-table" data-testid="versions">
        <thead><tr><th>版本</th><th>发布</th><th>修订</th><th>说明</th><th>存档</th></tr></thead>
        <tbody>
          {list.map((one) => (
            <tr key={one.version_no} data-testid={`version-${one.version_no}`}>
              <td className="nm">第 {one.version_no} 版</td>
              <td className="mut num">{versionMeta(one)}</td>
              <td><a className="ap-lnk" role="button" onClick={() => onShowRevision(one.revision_no)} title="在右侧栏修订页签里选中这次修订">修订 {one.revision_no}</a></td>
              <td>{one.note || <span className="mut">—</span>}</td>
              <td className="acts">
                {archive(one, "docx", one.has_docx, "Word")}{archive(one, "md", one.has_markdown, "Markdown")}
                {!one.has_markdown && !one.has_docx && <span className="ap-note">{missingArchiveText(one)}</span>}
                {figuresText(one) && <span className="ap-note" data-testid={`version-${one.version_no}-figures`}>{figuresText(one)}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 按章覆盖：文档的各章一行。 */
function Coverage({ task }: { task: Task }) {
  const rows = coverageRows(task, toc(task));
  const cell = (n: number | null) => (n === null ? <span className="mut">—</span> : n);
  return (
    <section className="oa-blk">
      <h3>按章覆盖<small>前七章是业务说明，其后每类需求条目一章，最后是追溯附录</small></h3>
      <div className="oa-tablebox">
        <table className="oa-table ap-table" data-testid="docs-coverage">
          <thead><tr><th>章</th><th>节</th><th>条目</th><th>图</th><th>导语</th><th>备注</th></tr></thead>
          <tbody>
            {rows.map((one) => (
              <tr key={one.name} className={one.empty ? "ap-fresh" : undefined} data-testid={`coverage-${one.name}`}>
                <td className="nm">{one.name}</td>
                <td className="num">{cell(one.sections)}</td>
                <td className="num">{cell(one.items)}</td>
                <td className="num">{cell(one.diagrams)}</td>
                <td className={one.intro ? undefined : "mut"}>{one.intro === null ? "—" : one.intro ? "有" : "没有"}</td>
                <td className={one.empty ? "ap-warn" : "mut"}>{one.note || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 发布前检查：完成条件逐条与非阻断提示。 */
function PublishCheck({ task, onGo }: { task: Task; onGo: (target: GoTarget) => void }) {
  const rows = checkRows(task);
  const tips = hints(task, toc(task));
  const allMet = !!task.completion?.all_met;
  const go = (target: GoTarget | null, text: string, id: string) => target && (
    <a className="ap-lnk" role="button" onClick={() => onGo(target)} data-testid={`go-${id}`}>{text}</a>
  );
  return (
    <section className="oa-blk">
      <h3>发布前检查<small>{allMet ? "" : `满足 ${rows.filter((one) => one.state === "met").length} / ${rows.filter((one) => one.state !== "empty").length} 条`}</small></h3>
      {allMet ? <p className="ap-line" data-testid="check-all-met">✓ 完成条件全部满足，可以发布。</p> : (
        <div className="oa-tablebox">
          <table className="oa-table ap-table ap-check" data-testid="docs-check">
            <thead><tr><th>完成条件</th><th>现状</th><th /></tr></thead>
            <tbody>
              {rows.map((one) => (
                <tr key={one.key} data-testid={`check-${one.key}`}>
                  <td className="nm">{one.label}</td>
                  <td className={one.state === "unmet" ? "ap-warn" : "mut"}>{one.state === "met" ? "✓ 已满足" : one.gap}</td>
                  <td className="acts">{go(one.go, one.goText, one.key)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="ap-hints" data-testid="docs-hints">
        <div className="ap-hints-h">非阻断提示<span className="ap-note">不挡发布，发布之前值得看一眼</span></div>
        {tips.length === 0 ? <p className="oa-empty">没有。</p> : (
          <ul>
            {tips.map((one) => <li key={one.key} data-testid={`hint-${one.key}`}><span>{one.text}</span>{go(one.go, one.goText, one.key)}</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}
