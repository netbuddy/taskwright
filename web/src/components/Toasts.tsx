// 全站提示条：刚发生的一件事（保存成功、被拒、评审进度、连接断了）在页面右上角浮出一条，全站只有这一种提示画法。
// 表达页面当前状态的横幅（助手正在工作、还有 N 条未读、任务已完成只读）与区域自己的读取错误不走这里，留在原处。
//
// 新的在最上面。成功、进行中、警告三种最多同时叠三条，多出的最旧一条先收起；失败提示不算在这三条里，也不会被挤掉，
// 几条失败都留着，由用户逐条点 × 关。鼠标停在一条上时它暂停计时，移开后接着计。
// 四种语气，颜色与条目的状态徽标同一套：
//   · 成功（绿）4 秒后淡出；
//   · 进行中（蓝）带进度条，不自己消失，做完后由调用方用同一个 key 换成成功或失败；
//   · 警告（琥珀）8 秒后淡出，情况还在时调用方用同一个 key 再报一次，它重新出现；
//   · 失败（红）停住，点 × 才关。
// 末尾可带一个动作（「撤销」「打开最新」「看评审页签」），点了执行并收起这一条。每条都有 ×。
// 同一个 key 再报一次：原地换掉内容与语气、重新计时，不另起一条。

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastTone = "ok" | "run" | "warn" | "bad";

export interface ToastInput {
  tone: ToastTone;
  text: ReactNode;
  /** 同一件事的几次报告用同一个 key：原地更新，不另起一条。不给时每次都是新的一条。 */
  key?: string;
  /** 末尾的动作，例如「打开最新」。 */
  action?: { label: string; onClick: () => void };
  /** 进行中的进度，0 到 1。 */
  progress?: number;
  /** 进行中时进度条下面的一行小字。 */
  note?: ReactNode;
}

export interface ToastApi {
  show: (t: ToastInput) => string;
  success: (text: ReactNode, o?: Omit<ToastInput, "tone" | "text">) => string;
  warning: (text: ReactNode, o?: Omit<ToastInput, "tone" | "text">) => string;
  error: (text: ReactNode, o?: Omit<ToastInput, "tone" | "text">) => string;
  running: (key: string, text: ReactNode, o?: Omit<ToastInput, "tone" | "text" | "key">) => string;
  dismiss: (key: string) => void;
  /** 这一条现在还显示着没有。 */
  isShown: (key: string) => boolean;
}

/** 每种语气显示多久（毫秒）；null 是不自己消失。 */
export const TOAST_MS: Record<ToastTone, number | null> = { ok: 4000, run: null, warn: 8000, bad: null };
/** 成功、进行中、警告三种最多同时叠几条（失败提示不计）。 */
export const TOAST_MAX = 3;
const FADE_MS = 250;
const TONE_NAME: Record<ToastTone, string> = { ok: "成功", run: "进行中", warn: "警告", bad: "失败" };
const ICON: Record<ToastTone, string> = { ok: "✓", run: "…", warn: "!", bad: "×" };

interface Toast extends ToastInput { key: string; seq: number; leaving: boolean }

const noop: ToastApi = { show: () => "", success: () => "", warning: () => "", error: () => "", running: () => "", dismiss: () => {}, isShown: () => false };
const ToastContext = createContext<ToastApi>(noop);

/** 取全站提示条。放在 ToastProvider 之外时什么也不做。 */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const live = useRef(new Set<string>());
  /** 每条的计时：到点时刻与剩余毫秒；暂停时 timer 为 null。 */
  const timers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout> | null; deadline: number; remaining: number }>());

  const clearTimer = (key: string) => {
    const t = timers.current.get(key);
    if (t?.timer) clearTimeout(t.timer);
    timers.current.delete(key);
  };
  const remove = useCallback((key: string) => {
    clearTimer(key);
    live.current.delete(key);
    setToasts((list) => list.map((t) => (t.key === key ? { ...t, leaving: true } : t)));
    setTimeout(() => setToasts((list) => list.filter((t) => !(t.key === key && t.leaving))), FADE_MS);
  }, []);
  const arm = useCallback((key: string, ms: number) => {
    clearTimer(key);
    timers.current.set(key, { timer: setTimeout(() => remove(key), ms), deadline: Date.now() + ms, remaining: ms });
  }, [remove]);

  const show = useCallback((input: ToastInput) => {
    const key = input.key ?? `t${++seq.current}`;
    const s = ++seq.current;
    live.current.add(key);
    setToasts((list) => {
      const existing = list.find((t) => t.key === key);
      const next = existing ? list.map((t) => (t.key === key ? { ...input, key, seq: t.leaving ? s : t.seq, leaving: false } : t))
        : [...list, { ...input, key, seq: s, leaving: false }];
      const shown = next.filter((t) => !t.leaving && t.tone !== "bad").sort((a, b) => a.seq - b.seq);
      const drop = new Set(shown.slice(0, Math.max(0, shown.length - TOAST_MAX)).map((t) => t.key));
      drop.forEach((k) => { clearTimer(k); live.current.delete(k); });
      return next.filter((t) => !drop.has(t.key));
    });
    const ms = TOAST_MS[input.tone];
    if (ms == null) clearTimer(key);
    else arm(key, ms);
    return key;
  }, [arm]);

  const api = useMemo<ToastApi>(() => ({
    show,
    success: (text, o) => show({ ...o, tone: "ok", text }),
    warning: (text, o) => show({ ...o, tone: "warn", text }),
    error: (text, o) => show({ ...o, tone: "bad", text }),
    running: (key, text, o) => show({ ...o, key, tone: "run", text }),
    dismiss: (key) => { if (live.current.has(key)) remove(key); },
    isShown: (key) => live.current.has(key),
  }), [show, remove]);

  useEffect(() => () => { timers.current.forEach((t) => t.timer && clearTimeout(t.timer)); }, []);

  /** 鼠标停在一条上：暂停它的计时；移开：按剩下的时间接着计。 */
  const pause = (key: string) => {
    const t = timers.current.get(key);
    if (!t?.timer) return;
    clearTimeout(t.timer);
    timers.current.set(key, { timer: null, deadline: t.deadline, remaining: Math.max(0, t.deadline - Date.now()) });
  };
  const resume = (key: string) => {
    const t = timers.current.get(key);
    if (t && !t.timer) arm(key, Math.max(t.remaining, 1000));
  };

  const ordered = [...toasts].sort((a, b) => b.seq - a.seq);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="tw-toasts" aria-live="polite" data-testid="toasts">
        {ordered.map((t) => (
          <div key={t.key} className={`tw-toast ${t.tone}${t.leaving ? " leaving" : ""}`} role={t.tone === "bad" ? "alert" : "status"}
            data-testid={`toast-${t.tone}`} data-key={t.key} onMouseEnter={() => pause(t.key)} onMouseLeave={() => resume(t.key)}>
            <span className="ic" aria-label={TONE_NAME[t.tone]}>{ICON[t.tone]}</span>
            <div className="body">
              <span className="tx">{t.text}</span>
              {t.action && (
                <button type="button" className="act" onClick={() => { t.action!.onClick(); remove(t.key); }} data-testid="toast-action">{t.action.label}</button>
              )}
              {t.tone === "run" && t.progress != null && (
                <div className="bar"><i style={{ width: `${Math.round(Math.min(1, Math.max(0, t.progress)) * 100)}%` }} /></div>
              )}
              {t.note && <div className="note">{t.note}</div>}
            </div>
            <button type="button" className="x" aria-label="关掉这条提示" title="关掉这条提示" onClick={() => remove(t.key)} data-testid="toast-close">×</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
