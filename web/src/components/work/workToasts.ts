// 工作视图里由事件引起、要报成全站提示条（Toasts.tsx）的三件事：
//   · 评审进度与结果：review_progress 到了报一条「进行中」（评审中 3/12，带进度条与正在评的条目），同一批用同一个 key 原地更新；
//     review_finished 到了换成「成功」（评审完了：N 条合规，M 条不合规），评审出错时换成「失败」，都带「看评审页签」。
//     对话区里那条「评审完成」的界面操作记录是对话留痕，照旧在。
//   · 服务器发来的 problem：带重试信息的（模型服务暂时不可用，正在第 N 次重试）报「警告」，同一种问题用同一个 key，
//     再次重试时重新出现；其余（助手没有说话就停下了）报「失败」。
//   · 事件流断开：报「警告」，8 秒后淡出，还没连上就每隔一会儿重新出现；连上之后收起它，另报一条「成功」。

import { useEffect, useRef } from "react";
import type { StreamStatus } from "../../api/events";
import type { Problem } from "../../api/types";
import type { ReviewRun } from "../../state/workState";
import { TOAST_MS, useToast } from "../Toasts";

export const RECONNECTING_TEXT = "与服务器的连接断了，正在重连……你照常可以看和改，连上之后会补上断开期间的变化。";
export const RECONNECTED_TEXT = "已重新连上服务器。";

/** 评审完了那一句。 */
export function reviewFinishedText(f: NonNullable<ReviewRun["finished"]>): string {
  return `评审完了：${f.passed} 条合规，${f.failed} 条不合规${f.unfinished ? `，${f.unfinished} 条没有评完（可以再评一次）` : ""}。${f.error ?? ""}`;
}

export function useReviewToast(review: ReviewRun | null, onShowReviews: () => void) {
  const toast = useToast();
  const show = useRef(onShowReviews);
  show.current = onShowReviews;
  useEffect(() => {
    if (!review) return;
    const key = `review-${review.op_id}`;
    const f = review.finished;
    if (!f) {
      toast.running(key, `评审中 ${review.done}/${review.total}`, {
        progress: review.total ? review.done / review.total : 0,
        note: review.current.length ? `${review.current.join("、")} 正在评审…（每条约十秒，可以继续做别的）` : "正在收尾…",
      });
      return;
    }
    const action = { label: "看评审页签", onClick: () => show.current() };
    if (f.error) toast.error(reviewFinishedText(f), { key, action });
    else toast.success(reviewFinishedText(f), { key, action });
  }, [review?.op_id, review?.done, review?.total, review?.current.join("、"), !!review?.finished]);
}

export function useProblemToasts(problems: Problem[]) {
  const toast = useToast();
  const shown = useRef(0);
  useEffect(() => {
    if (problems.length < shown.current) shown.current = 0;
    for (const p of problems.slice(shown.current)) {
      if (p.retry) toast.warning(p.text, { key: `problem-${p.code}` });
      else toast.error(p.text);
    }
    shown.current = problems.length;
  }, [problems]);
}

export function useConnectionToast(stream: StreamStatus) {
  const toast = useToast();
  const down = useRef(false);
  useEffect(() => {
    if (stream === "reconnecting") {
      down.current = true;
      const say = () => { if (!toast.isShown("connection")) toast.warning(RECONNECTING_TEXT, { key: "connection" }); };
      say();
      // 警告 8 秒后淡出；情况还在，淡出之后再报一次。
      const timer = setInterval(say, (TOAST_MS.warn ?? 8000) + 1500);
      return () => clearInterval(timer);
    }
    if (stream === "open" && down.current) {
      down.current = false;
      toast.dismiss("connection");
      toast.success(RECONNECTED_TEXT);
    }
  }, [stream]);
}
