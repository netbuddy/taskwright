// 工作视图的数据来源：先连事件流，连上之后再读一次整份数据，之后只听事件。
// 收到 resync 或发现库事件序号有缺口时，状态回到「等整份数据」，这里就再读一次。
// 断线重连时带上已应用到的库事件序号（Last-Event-ID），由后端从它之后补发。
// 修订日志（GET …/revisions）不在整份数据里：整份数据到了读一次，之后最新修订号变了、或一次工作结束时再读一次。

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { openEventStream, type StreamStatus } from "../api/events";
import { initialWorkState, workReducer, type WorkAction, type WorkState } from "./workState";
import type { RevisionLogEntry } from "../api/types";

export interface WorkView {
  state: WorkState;
  /** 修订日志，最新在前；还没读到时是空列表。 */
  log: RevisionLogEntry[];
  dispatch: (action: WorkAction) => void;
  stream: StreamStatus;
  loadError: string | null;
  reload: () => void;
}

export function useWorkView(taskId: string, sessionId: string): WorkView {
  const [state, dispatch] = useReducer(workReducer, sessionId, initialWorkState);
  const [stream, setStream] = useState<StreamStatus>("connecting");
  const [loadError, setLoadError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const loading = useRef(false);
  const everOpened = useRef(false);

  const loadSnapshot = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const snapshot = await api.snapshot(taskId, sessionId);
      setLoadError(null);
      dispatch({ type: "snapshot", snapshot });
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.message : String(error));
    } finally {
      loading.current = false;
    }
  }, [taskId, sessionId]);

  useEffect(() => {
    everOpened.current = false;
    const url = `/api/v1/tasks/${encodeURIComponent(taskId)}/events?session=${encodeURIComponent(sessionId)}`;
    const close = openEventStream(url, () => stateRef.current.seq, {
      onMessage: (m) => dispatch({ type: "sse", event: m.event, data: m.data }),
      onStatus: (status) => {
        setStream(status);
        // 第一次连上之后读整份数据；重连之后如果还没有整份数据（例如上次读失败），也再读一次。
        if (status === "open" && (!everOpened.current || stateRef.current.phase === "waiting_snapshot")) {
          everOpened.current = true;
          void loadSnapshot();
        }
      },
    });
    return close;
  }, [taskId, sessionId, loadSnapshot]);

  // 修订日志：最新修订号变了（整份数据到达、有新修订）或一次工作结束（这次工作的修订归到哪句话要等会话记录写全）时重读。
  // 连着到的几条事件只读一次：稍等一下再读，后到的请求盖掉先到的结果。
  const [log, setLog] = useState<RevisionLogEntry[]>([]);
  const working = state.currentWork != null;
  useEffect(() => {
    if (state.phase !== "ready" || !state.task) return;
    let live = true;
    const timer = setTimeout(() => {
      api.revisionLog(taskId).then((r) => { if (live) setLog(r.revisions); }).catch(() => undefined);
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [taskId, state.phase, state.task != null, state.latestRevision, working]);

  // resync 或序号缺口让状态回到「等整份数据」时，再读一次。
  useEffect(() => {
    if (state.phase === "waiting_snapshot" && everOpened.current && stream === "open") void loadSnapshot();
  }, [state.phase, stream, loadSnapshot]);

  return { state, log, dispatch, stream, loadError, reload: loadSnapshot };
}
