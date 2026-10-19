// 任务列表页：一次普通读取（GET /api/v1/tasks），不连事件流。任务没有状态：按最近活动排，最近的在前；每行写进展（流程到了哪一站、
// 几个工作项、几条阻断问题），数据随列表一起来，不逐个任务去取任务状况。版本不在这里写，在起点页的「文档与版本」与工作台的版本一节。
// 每行末尾除了「打开」还有一个菜单，里面是「删除任务」（确认框见 DeleteTaskModal）。
// 打开一个任务时去哪里由 model/startPage.ts 的 taskEntryHref 定：业务说明已经有内容的进工作台，否则进任务起点页。

import { useEffect, useState } from "react";
import { Alert, Button, Dropdown, Table, Tag } from "antd";
import { EllipsisOutlined, PlusOutlined } from "@ant-design/icons";
import { api, ApiError } from "../api/client";
import type { TaskListEntry } from "../api/types";
import { NewTaskModal, Shell, sortByActivity } from "../components/Shell";
import { DeleteTaskModal } from "../components/task/DeleteTaskModal";
import { formatTime } from "../model/format";
import { openTask } from "../model/startPage";
import { go } from "../router";

/** 格式太早的旧格式任务，或者正被别的服务占用的任务：列出来，灰显，打不开。 */
const unsupported = (t: TaskListEntry) => t.supported === false;
/** 数据格式与这个程序对不上的三种情形（后端给的字样）：上一版的数据还没有升级、升级没有做成、是更新的版本写的。原因在 note 里。 */
const FORMAT_STATES = ["需要升级", "需要处理", "需要更新的程序"];
const occupiedText = (t: TaskListEntry) => (t.occupied?.port ? `正被端口 ${t.occupied.port} 的服务占用` : "正被另一个服务占用");
/** 进展一栏：「需求分析 · 第 4 站写条目 · 2 个工作项 · 2 条阻断」；没有流程工作项写「未启动流程」，没有阻断问题时不写那一段。 */
export function progressText(t: Pick<TaskListEntry, "flow" | "work_item_count" | "blocking_count">): string {
  const flow = t.flow ? `${t.flow.name} · 第 ${t.flow.ordinal} 站${t.flow.node_name}` : "未启动流程";
  return [flow, `${t.work_item_count ?? 0} 个工作项`, t.blocking_count ? `${t.blocking_count} 条阻断` : ""].filter(Boolean).join(" · ");
}

export function TaskListPage() {
  const [tasks, setTasks] = useState<TaskListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<TaskListEntry | null>(null);

  useEffect(() => {
    api.listTasks().then((list) => setTasks(sortByActivity(list))).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);

  // 数据格式与这个程序对不上的任务（需要升级、需要处理、需要更新的程序）：后端在 unavailable 里写明是哪一种。
  const mismatched = tasks?.filter((t) => unsupported(t) && FORMAT_STATES.includes(t.unavailable ?? "")).length ?? 0;
  const old = tasks?.filter((t) => unsupported(t) && !t.occupied && !FORMAT_STATES.includes(t.unavailable ?? "")).length ?? 0;
  const taken = tasks?.filter((t) => !!t.occupied).length ?? 0;
  return (
    <Shell>
      <div className="page-title" style={{ justifyContent: "space-between" }}>
        <h1>任务</h1>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建任务</Button>
      </div>
      <p className="lede">
        {tasks ? `一共 ${tasks.length} 个任务${old ? `，${old} 个是旧格式、现在的程序打不开` : ""}${mismatched ? `，${mismatched} 个的数据要先处理才能打开` : ""}${taken ? `，${taken} 个正被别的服务占用、这里打不开` : ""}。` : "正在读取任务列表。"}一个任务一份交付物，任务里的所有会话共用这份交付物。
      </p>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: "0.857rem" }} />}
      <Table<TaskListEntry>
        rowKey="task_id"
        loading={!tasks && !error}
        dataSource={tasks ?? []}
        pagination={false}
        size="middle"
        onRow={(t) => (unsupported(t) ? { style: { color: "var(--mut)", cursor: "not-allowed" }, title: t.note } : { onClick: () => openTask(t.task_id, go), style: { cursor: "pointer" } })}
        columns={[
          { title: "任务名", dataIndex: "task_name", render: (v: string, t) => (<><b>{v}</b>{t.domain_tag && <div className="muted small">{t.domain_tag}</div>}</>) },
          { title: "任务类型", dataIndex: "task_type" },
          { title: "进展", render: (_: unknown, t) => (t.occupied ? <Tag data-testid="task-occupied">{occupiedText(t)}</Tag>
            : unsupported(t) && FORMAT_STATES.includes(t.unavailable ?? "") ? <Tag data-testid="task-format">{t.unavailable}</Tag>
            : unsupported(t) ? <Tag data-testid="task-unsupported">旧格式，不支持</Tag>
            : <span data-testid={`task-progress-${t.task_id}`}>{progressText(t)}</span>) },
          { title: "条目数", dataIndex: "item_count" },
          {
            title: "完成条件",
            render: (_: unknown, t) => (unsupported(t) ? <span className="muted">{t.note}</span> : t.completion_total == null ? <span className="muted">这次没有算出来</span> : (t.completion_unmet ?? 0) === 0 ? "都已满足" : `还差 ${t.completion_unmet} 项`),
          },
          { title: "最近活动", dataIndex: "last_active_at", render: formatTime },
          { title: "会话数", dataIndex: "session_count" },
          { title: "", render: (_: unknown, t) => (unsupported(t) ? null : (
            <span style={{ display: "inline-flex", gap: "0.3rem" }} onClick={(e) => e.stopPropagation()}>
              <Button size="small" onClick={() => openTask(t.task_id, go)}>打开</Button>
              <Dropdown trigger={["click"]} menu={{ items: [{ key: "delete", label: "删除任务", danger: true }], onClick: () => setDeleting(t) }}>
                <Button size="small" icon={<EllipsisOutlined />} aria-label="更多操作" title="更多操作" data-testid={`task-menu-${t.task_id}`} />
              </Dropdown>
            </span>
          )) },
        ]}
      />
      <NewTaskModal open={open} onClose={() => setOpen(false)} />
      <DeleteTaskModal taskId={deleting?.task_id ?? null} taskName={deleting?.task_name ?? ""} onClose={() => setDeleting(null)}
        onDeleted={(id) => { setDeleting(null); setTasks((list) => list?.filter((one) => one.task_id !== id) ?? null); }} />
    </Shell>
  );
}
