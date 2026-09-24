import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useRoute } from "./router";
import { TaskListPage } from "./pages/TaskListPage";
import { TaskPage } from "./pages/TaskPage";
import { WorkViewPage } from "./pages/WorkViewPage";

// Ant Design 的主题令牌对到 styles.css 里 :root 的同一套值：黑色主按钮，状态色只用在评审、确认几种标签上。
// 令牌不能写 CSS 变量，所以这里是同值的字面量；改配色时两处一起改，以 :root 为准。
// 字号按原型根字号 clamp(12.5px, 0.95vw, 15px) 下 .8rem 左右取 13px；圆角、控件高度对到原型 .btn 与输入框。
const theme = {
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
    borderRadius: 8,
    borderRadiusSM: 6,
    fontSize: 13,
    lineHeight: 1.65,
    controlHeight: 28,
    controlHeightSM: 22,
    fontFamily: '-apple-system, "SF Pro Text", "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif',
  },
};

export function App() {
  const route = useRoute();
  return (
    <ConfigProvider locale={zhCN} theme={theme} button={{ autoInsertSpace: false }}>
      <AntApp>
        {route.page === "tasks" && <TaskListPage />}
        {route.page === "task" && <TaskPage key={route.taskId} taskId={route.taskId} />}
        {route.page === "work" && <WorkViewPage key={`${route.taskId}/${route.sessionId}`} taskId={route.taskId} sessionId={route.sessionId} />}
      </AntApp>
    </ConfigProvider>
  );
}
