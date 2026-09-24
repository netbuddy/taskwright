// 任务列表页：一次普通读取（GET /api/v1/tasks），不连事件流。

import { useEffect, useState } from "react";
import { Alert, Button, Table, Tag } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api, ApiError } from "../api/client";
import type { TaskListEntry } from "../api/types";
import { NewTaskModal, Shell, sortByActivity } from "../components/Shell";
import { formatTime } from "../model/format";
import { go, href } from "../router";

export function statusTag(status: string) {
  const color = status === "进行中" ? "orange" : status === "已完成" ? "green" : "default";
  return <Tag color={color}>{status}</Tag>;
}

export function TaskListPage() {
  const [tasks, setTasks] = useState<TaskListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.listTasks().then((list) => setTasks(sortByActivity(list))).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);

  const running = tasks?.filter((t) => t.status === "进行中").length ?? 0;
  return (
    <Shell>
      <div className="page-title" style={{ justifyContent: "space-between" }}>
        <h1>任务</h1>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>新建任务</Button>
      </div>
      <p className="lede">
        {tasks ? `一共 ${tasks.length} 个任务，其中 ${running} 个进行中。` : "正在读取任务列表。"}一个任务一份交付物，任务里的所有会话共用这份交付物。
      </p>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Table<TaskListEntry>
        rowKey="task_id"
        loading={!tasks && !error}
        dataSource={tasks ?? []}
        pagination={false}
        size="middle"
        onRow={(t) => ({ onClick: () => go(href.task(t.task_id)), style: { cursor: "pointer" } })}
        columns={[
          { title: "任务名", dataIndex: "task_name", render: (v: string, t) => (<><b>{v}</b>{t.domain_tag && <div className="muted small">{t.domain_tag}</div>}</>) },
          { title: "任务类型", dataIndex: "task_type" },
          { title: "状态", dataIndex: "status", render: statusTag },
          { title: "条目数", dataIndex: "item_count" },
          {
            title: "完成条件",
            render: (_: unknown, t) => (t.completion_total == null ? <span className="muted">这次没有算出来</span> : (t.completion_unmet ?? 0) === 0 ? "都已满足" : `还差 ${t.completion_unmet} 项`),
          },
          { title: "最近活动", dataIndex: "last_active_at", render: formatTime },
          { title: "会话数", dataIndex: "session_count" },
          { title: "", render: (_: unknown, t) => <Button size="small" onClick={() => go(href.task(t.task_id))}>打开</Button> },
        ]}
      />
      <NewTaskModal open={open} onClose={() => setOpen(false)} />
    </Shell>
  );
}
