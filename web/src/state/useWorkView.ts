// 工作视图的数据来源：先连事件流，连上之后再读一次整份数据，之后只听事件。
// 收到 resync 或发现库事件序号有缺口时，状态回到「等整份数据」，这里就再读一次。
// 断线重连时带上已应用到的库事件序号（Last-Event-ID），由后端从它之后补发。

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { openEventStream, type StreamStatus } from "../api/events";
import { initialWorkState, workReducer, type WorkAction, type WorkState } from "./workState";
import { rebuildBlocks } from "../model/changes";

export interface WorkView {
  state: WorkState;
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

  // 整份数据到了之后，按各条目的版本历史重建改动块（刷新前的那些修订）。只在快照换了时做一次。
  const rebuiltFor = useRef<number | null>(null);
  useEffect(() => {
    const task = state.task;
    if (state.phase !== "ready" || !task || state.snapshotSeq == null || rebuiltFor.current === state.snapshotSeq) return;
    rebuiltFor.current = state.snapshotSeq;
    const messages = state.messages;
    const wanted = task.items.filter((i) => i.version_count > 0);
    void Promise.all(wanted.map((i) => api.itemVersions(taskId, i.item_id).then((v) => [i.item_id, v] as const).catch(() => [i.item_id, []] as const)))
      .then((pairs) => dispatch({ type: "rebuilt_blocks", blocks: rebuildBlocks(task, Object.fromEntries(pairs), messages) }));
    // 只跟着快照走：之后到达的库事件由 changeBlocks 实时拼。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.snapshotSeq]);

  // resync 或序号缺口让状态回到「等整份数据」时，再读一次。
  useEffect(() => {
    if (state.phase === "waiting_snapshot" && everOpened.current && stream === "open") void loadSnapshot();
  }, [state.phase, stream, loadSnapshot]);

  return { state, dispatch, stream, loadError, reload: loadSnapshot };
}
