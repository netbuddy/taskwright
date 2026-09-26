import { useMemo } from "react";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useRoute } from "./router";
import { TaskListPage } from "./pages/TaskListPage";
import { TaskPage } from "./pages/TaskPage";
import { WorkViewPage } from "./pages/WorkViewPage";
import { useRootPx } from "./model/fontScale";
import { ToastProvider } from "./components/Toasts";

// Ant Design 的主题令牌对到 styles.css 里 :root 的同一套值：黑色主按钮，状态色只用在评审、确认几种标签上。
// 令牌不能写 CSS 变量，所以这里是同值的字面量；改配色时两处一起改，以 :root 为准。
// 令牌只能写像素数，而全站尺寸随根字号流动，所以字号与控件高度按根字号换算：
// 字号是 0.929rem（根字号最小的 14px 时正好是原来的 13px），控件高度 2rem 与 1.571rem（14px 时是原来的 28 与 22）。
// 根字号随窗口大小与「字号 小 中 大」三档变化，useRootPx 跟着它重算；主题对象每次都传，不会让 Ant Design 重新挂载。
const baseTheme = {
  token: {
    colorPrimary: "#0d0d0d",
    colorText: "#0d0d0d",
    colorTextSecondary: "#8f8f8f",
    colorTextTertiary: "#8f8f8f",
    colorBorder: "#dcdcdc",
    colorBorderSecondary: "#ececec",
    colorBgLayout: "#f3f3f3",
    colorBgContainer: "#ffffff",
    colorFillSecondary: "#f0f0f0",
    colorLink: "#2563eb",
    colorSuccess: "#15803d",
    colorWarning: "#b45309",
    colorError: "#b91c1c",
    colorInfo: "#2563eb",
    lineHeight: 1.65,
    fontFamily: '-apple-system, "SF Pro Text", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif',
  },
};

export function App() {
  const route = useRoute();
  const px = useRootPx();
  const theme = useMemo(() => ({
    token: { ...baseTheme.token, fontSize: Math.round(px * 0.929), controlHeight: Math.round(px * 2), controlHeightSM: Math.round(px * 1.571),
      borderRadius: Math.round(px * 0.571), borderRadiusSM: Math.round(px * 0.429) },
  }), [px]);
  return (
    <ConfigProvider locale={zhCN} theme={theme} button={{ autoInsertSpace: false }}>
      <AntApp>
        <ToastProvider>
          {route.page === "tasks" && <TaskListPage />}
          {route.page === "task" && <TaskPage key={route.taskId} taskId={route.taskId} />}
          {route.page === "work" && <WorkViewPage key={`${route.taskId}/${route.sessionId}`} taskId={route.taskId} sessionId={route.sessionId} />}
        </ToastProvider>
      </AntApp>
    </ConfigProvider>
  );
}
