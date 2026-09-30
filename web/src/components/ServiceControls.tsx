// 与运行形态有关的三样界面：没有模型时页面顶部的白话提示（带「去配置模型」）、「本机用户」菜单里的「退出服务」、退出之后的整屏。
// 都按服务信息接口（GET /api/v1/service）的能力清单显示：capabilities.model 为 false 才出提示，capabilities.exit 为 true
// 才有「退出服务」（只有桌面形态有）。取不到服务信息时（例如开发时的假服务没有这个接口）两样都不显示，页面照旧。

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Button, Modal } from "antd";
import { api, ApiError } from "../api/client";
import type { ServiceInfo } from "../api/types";
import { openSettings } from "../router";
import { useToast } from "./Toasts";

type Mode = ServiceInfo["mode"];

interface ServiceState {
  info: ServiceInfo | null;
  exited: boolean;
  /** 服务已退出：本页点了「退出服务」，或者事件流收到了服务发来的 service_exiting。mode 是服务的运行形态，决定退出画面的文字。 */
  markExited: (mode?: Mode) => void;
  /** 重新取一次服务信息：在设置页面选定模型之后，无模型提示按新的 capabilities.model 显示或收起。 */
  refresh: () => void;
}

const ServiceContext = createContext<ServiceState>({ info: null, exited: false, markExited: () => {}, refresh: () => {} });

export function ServiceProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<ServiceInfo | null>(null);
  const [exited, setExited] = useState<Mode | null>(null);
  const toast = useToast();
  const refresh = useCallback(() => {
    api.serviceInfo().then(setInfo).catch(() => setInfo(null));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  // 退出画面出现之后，先前的断线提示、助手状态与操作失败的提示都不再显示，免得几句话同时出现、互相矛盾。
  const markExited = useCallback((mode?: Mode) => {
    setExited((was) => was ?? mode ?? info?.mode ?? "desktop");
    toast.clear();
  }, [info?.mode, toast]);
  return <ServiceContext.Provider value={{ info, exited: exited !== null, markExited, refresh }}>{exited ? <ExitedScreen mode={exited} /> : children}</ServiceContext.Provider>;
}

export function useService(): ServiceState {
  return useContext(ServiceContext);
}

/**
 * 服务退出之后换上的整屏：页面上别的东西都不再显示，也不再重连。桌面形态下这一屏是告诉用户服务停了的主要办法；
 * 服务器形态下停服务是有计划的事，用户事先已被告知，这一屏是补充，写明恢复之后刷新即可。
 */
export function ExitedScreen({ mode = "desktop" }: { mode?: Mode }) {
  return (
    <div className="svc-gone" data-testid="service-exited" data-mode={mode}>
      <div className="box">
        {mode === "server" ? <b>服务已停止。恢复之后刷新这个页面即可继续。</b> : <>
          <b>服务已退出，可以关闭此窗口</b>
          <span>要再用时，重新双击程序即可。</span>
        </>}
      </div>
    </div>
  );
}

/**
 * 助手没有可用的模型时（capabilities.model 为 false），任务列表页、任务页与工作视图顶部的一条提示，右边「去配置模型」进设置页面；
 * 「详情」展开后端给的一句原因（写明查过的两个文件在哪里）。在设置页面选定模型之后，服务信息重新取一次，提示随之收起。
 */
export function NoModelBanner() {
  const { info } = useService();
  const [open, setOpen] = useState(false);
  if (!info || info.capabilities.model !== false) return null;
  return (
    <div className={`svc-banner${open ? " open" : ""}`} data-testid="no-model-banner">
      还没有选定助手用的模型，助手现在不能工作。
      {info.model?.reason && <a role="button" onClick={() => setOpen(!open)} data-testid="no-model-detail">详情</a>}
      <span className="sp" />
      <Button size="small" onClick={openSettings} data-testid="go-model-settings">去配置模型</Button>
      {open && info.model?.reason && <div className="why">{info.model.reason}</div>}
    </div>
  );
}

/**
 * 「本机用户」菜单。where 是放的位置：sider 是任务列表页与任务页侧栏底部，topbar 是工作视图顶栏右端。
 * 服务有退出能力时才是可点的菜单（服务地址与「退出服务」）；没有时侧栏底部照旧只写「本机用户」，顶栏不放这个按钮。
 */
export function UserMenu({ where }: { where: "sider" | "topbar" }) {
  const { info, markExited } = useService();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".svc-menu, .svc-user")) setOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);

  const canExit = Boolean(info?.capabilities.exit);
  if (!canExit) return where === "sider" ? <>本机用户</> : null;

  const leave = async () => {
    setLeaving(true);
    try {
      await api.exitService();
      setConfirming(false);
      markExited("desktop");
    } catch (error) {
      toast.error(error instanceof ApiError ? `没能退出服务：${error.message}` : "没能退出服务。");
      setLeaving(false);
    }
  };

  return (
    <span className={`svc-user-wrap at-${where}`}>
      <span className={`svc-user at-${where}`} role="button" onClick={() => setOpen(!open)} data-testid="user-menu-button">本机用户 ▾</span>
      {open && (
        <div className={`svc-menu at-${where}`} data-testid="user-menu">
          <div className="svc-mh">服务在本机运行：{window.location.host}</div>
          <div className="svc-row danger" role="button" onClick={() => { setOpen(false); setConfirming(true); }} data-testid="exit-service">退出服务</div>
        </div>
      )}
      <Modal title="退出服务" open={confirming} onOk={() => void leave()} onCancel={() => setConfirming(false)} okText="退出" cancelText="取消"
        confirmLoading={leaving} destroyOnHidden>
        退出后页面将无法使用，确定退出？
      </Modal>
    </span>
  );
}
