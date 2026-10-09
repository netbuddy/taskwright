// 数据升级页：程序启动时发现这台电脑上有上一版留下的数据（服务信息里 upgrade_pending 为真），页面整屏换成它，别的都不显示。
// 上面写要升级什么、升级之前的备份放在哪里、大概多久；用户点「开始升级」才做。做的时候每半秒取一次进度；都做成了自动进正常界面；
// 有任务没有做成时停在这一页显示报告与备份位置，点「继续使用」进正常界面（没有做成的任务在任务列表里标「需要处理」）；
// 整体没有做成（例如备份不成）时一个任务都没有动，可以再试一次。升级在任务服务里做（GET、POST /api/v1/service/upgrade）。

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "antd";
import { api, ApiError } from "../api/client";
import type { UpgradeView } from "../api/types";

/** 取进度的间隔（毫秒）。 */
export const UPGRADE_POLL_MS = 500;

/** 要升级的任务最多列出几个名字，多的写「等 N 个」。 */
const LISTED = 6;

function taskNames(view: UpgradeView): string {
  const names = view.tasks.slice(0, LISTED).map((t) => `「${t.name ?? t.task_id}」`).join("、");
  return view.tasks.length > LISTED ? `${names}等 ${view.tasks.length} 个` : names;
}

export function UpgradeScreen({ onContinue }: { onContinue: () => void }) {
  const [view, setView] = useState<UpgradeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const left = useRef(false);

  const load = useCallback(() => {
    api.upgradeState().then((got) => {
      setError(null);
      // 没有要做的升级了（例如在别的窗口里做完了）：直接进正常界面。
      if (got.upgrade === null) onContinue();
      else setView(got.upgrade);
    }).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [onContinue]);

  useEffect(() => { load(); }, [load]);

  // 正在做的时候每半秒取一次进度。
  useEffect(() => {
    if (view?.state !== "running") return;
    const timer = setInterval(load, UPGRADE_POLL_MS);
    return () => clearInterval(timer);
  }, [view?.state, load]);

  // 都做成了：不用人点，直接进正常界面（只进一次）。
  useEffect(() => {
    if (view?.state === "done" && view.report && view.report.failed === 0 && !left.current) {
      left.current = true;
      onContinue();
    }
  }, [view, onContinue]);

  const start = () => {
    setStarting(true);
    api.startUpgrade().then((got) => { setError(null); setView(got.upgrade); })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => setStarting(false));
  };

  const report = view?.report ?? null;
  return (
    <div className="svc-gone upg" data-testid="upgrade-screen" data-state={view?.state ?? "loading"}>
      <div className="box">
        <b>数据升级</b>
        {!view && !error && <span>正在查看这台电脑上的数据……</span>}
        {error && <p className="upg-err" data-testid="upgrade-error">{error} <a role="button" onClick={load}>再看一次</a></p>}
        {view?.state === "pending" && <>
          <p>这台电脑上有上一版留下的数据，要先升级到现在的格式才能接着用。升级不改动任务的内容。</p>
          <ul className="upg-what" data-testid="upgrade-what">
            {view.tasks.length > 0 && <li>要升级的任务有 {view.tasks.length} 个：{taskNames(view)}。</li>}
            {view.service && <li>任务登记要升级。</li>}
            <li>知识库不需要升级。</li>
            <li>升级之前会先备份，备份放在 <code>{view.backup_dir}</code>。</li>
            <li>通常不到一分钟。升级的时候请不要关闭程序。</li>
          </ul>
          <Button type="primary" loading={starting} onClick={start} data-testid="upgrade-start">开始升级</Button>
        </>}
        {view?.state === "running" && <>
          <p data-testid="upgrade-progress">
            正在升级，请不要关闭程序。{view.progress ? `一共 ${view.progress.total} 项，做完了 ${view.progress.done} 项。` : ""}
          </p>
          {view.progress?.current && <span data-testid="upgrade-current">{view.progress.current}……</span>}
        </>}
        {view?.state === "done" && report && report.failed > 0 && <>
          <p data-testid="upgrade-result">升级做完了：{report.succeeded} 个任务做成了，{report.failed} 个没有做成。没有做成的任务原样没动，在任务列表里标着「需要处理」。</p>
          <pre className="upg-report" data-testid="upgrade-report">{report.text}</pre>
          <Button type="primary" onClick={onContinue} data-testid="upgrade-continue">继续使用</Button>
        </>}
        {view?.state === "failed" && report && <>
          <p data-testid="upgrade-result">没有升级，数据原样没动：{report.fatal}</p>
          <pre className="upg-report" data-testid="upgrade-report">{report.text}</pre>
          <Button type="primary" loading={starting} onClick={start} data-testid="upgrade-retry">再试一次</Button>
        </>}
      </div>
    </div>
  );
}
