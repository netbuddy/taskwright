// 任务页的交付物一块：每个条目集合一张卡，一行排开。卡上是集合名与编号前缀、大号条目数、一行「评审通过 m/n · 已读 k/n」；
// 详细的说明放在悬停提示里。集合色只用来标识集合（图标与顶部细线），不表示状态，按集合名取；没有条目的卡降成灰阶。
// 点卡片进入最近活动的那条会话的工作视图，条目区停在这个集合；任务还没有会话时卡片不可点。

import type { ReactNode } from "react";
import { ApartmentOutlined, AppstoreOutlined, LockOutlined, ProfileOutlined, QuestionCircleOutlined, ReadOutlined, SlidersOutlined } from "@ant-design/icons";
import type { Task } from "../../api/types";
import { isUnread, needsReview, reviewCounts } from "../../model/items";
import { href } from "../../router";

/** 五种集合色的样式类（依次是蓝、青绿、靛蓝、琥珀、石板灰，见 styles/task-page.css）。 */
const COLORS = ["c1", "c2", "c3", "c4", "c5"];
/** 已知集合的图标（按语义选）与颜色，都按集合名取：集合在任务定义里排第几、任务里有没有别的集合，都不改变它的图标与颜色。 */
const KNOWN: Record<string, { icon: ReactNode; color: string }> = {
  功能用例: { icon: <ApartmentOutlined />, color: "c1" },
  非功能需求: { icon: <SlidersOutlined />, color: "c2" },
  约束: { icon: <LockOutlined />, color: "c3" },
  问题: { icon: <QuestionCircleOutlined />, color: "c4" },
  领域说明: { icon: <ReadOutlined />, color: "c5" },
};
/** 一个集合的图标与颜色；不认识的集合用通用的清单图标，颜色按它在任务定义里的先后轮换。 */
export function collectionLook(name: string, index: number): { icon: ReactNode; color: string } {
  return KNOWN[name] ?? { icon: <ProfileOutlined />, color: COLORS[index % COLORS.length] };
}

export const NO_SESSION_TITLE = "还没有会话，新建会话之后可以从这里进入工作视图。";

export function CollectionCards({ task, sessionId }: {
  task: Task;
  /** 点卡片进入哪条会话的工作视图；任务还没有会话时为 null，卡片不可点。 */
  sessionId: string | null;
}) {
  const latest = task.latest_revision ?? task.items.reduce((m, i) => Math.max(m, i.revision_no), 0);
  return (
    <section className="tp-sec">
      <div className="tp-sec-h">
        <h2><AppstoreOutlined className="tp-hic" />交付物</h2>
        {latest > 0 && <span className="aside" data-testid="latest-revision">最后改在修订 {latest}</span>}
      </div>
      <div className="tp-colls">
        {task.definition.collections.map((coll, index) => {
          const items = task.items.filter((i) => i.collection === coll.name);
          const n = items.length;
          const empty = n === 0;
          const look = collectionLook(coll.name, index);
          const reviewed = needsReview(task, coll.name);
          const counts = reviewCounts(task, coll.name);
          const read = items.filter((i) => !isUnread(i)).length;
          const about = empty ? `${coll.name}还没有条目。`
            : reviewed
              ? `这 ${n} 个条目里，${counts.passed} 个在当前所在的修订上评审通过，${counts.kept > 0 ? `${counts.kept} 个评审不通过但你保留了写法（按你的决定算通过），` : ""}你已经看过其中 ${read} 个。`
              : `这 ${n} 个条目里，你已经看过 ${read} 个。这个集合不评审。`;
          const title = `${about}${sessionId ? `点这张卡进入工作视图，只看${coll.name}。` : NO_SESSION_TITLE}`;
          const body = (
            <>
              <div className="tp-coll-h">
                <span className="cic">{look.icon}</span>
                <span className="tp-coll-name">{coll.name}</span><span className="tp-coll-pre">{coll.prefix}</span>
              </div>
              <div className="tp-coll-n" data-testid={`board-count-${coll.name}`}>{n}</div>
              <div className="tp-coll-s">
                {empty ? "还没有条目。" : (
                  <>
                    {reviewed && <span data-testid={`board-review-${coll.name}`}>评审通过 <b>{counts.passed}/{n}</b>{counts.kept > 0 && <> · 已保留写法 <b>{counts.kept}</b></>} · </span>}
                    <span data-testid={`board-read-${coll.name}`}>已读 <b>{read}/{n}</b></span>
                  </>
                )}
              </div>
            </>
          );
          const className = `tp-coll ${look.color}${empty ? " empty" : ""}${sessionId ? "" : " static"}`;
          return sessionId
            ? <a key={coll.name} className={className} href={href.work(task.task_id, sessionId, coll.name)} title={title} data-testid={`board-${coll.name}`}>{body}</a>
            : <div key={coll.name} className={className} title={title} data-testid={`board-${coll.name}`}>{body}</div>;
        })}
      </div>
    </section>
  );
}
