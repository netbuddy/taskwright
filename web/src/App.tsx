import { useMemo } from "react";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useRoute } from "./router";
import { TaskListPage } from "./pages/TaskListPage";
import { TaskPage } from "./pages/TaskPage";
import { StartInputPage } from "./pages/StartInputPage";
import { WorkViewPage } from "./pages/WorkViewPage";
import { KnowledgePage } from "./pages/KnowledgePage";
import { SettingsPage } from "./pages/SettingsPage";
import { useRootPx } from "./model/fontScale";
import { useTheme } from "./model/theme";
import { ToastProvider } from "./components/Toasts";
import { ServiceProvider } from "./components/ServiceControls";

// Ant Design 的主题令牌从当前界面风格的令牌块里读（styles.css 开头的两个块，当前是哪一个看 html 的 data-theme）：
// 黑色或墨色的主按钮，状态色只用在评审、确认几种标签上。Ant Design 的令牌不能写 CSS 变量，所以切换风格时读一遍算好的值；
// 颜色只在 styles.css 一处定义，这里不留字面量。读不到某一项（测试环境不加载样式表）就不传它，Ant Design 用自己的默认值。
// 令牌只能写像素数，而全站尺寸随根字号流动，所以字号与控件高度按根字号换算：
// 字号是 0.929rem（根字号最小的 14px 时正好是原来的 13px），控件高度 2rem 与 1.571rem（14px 时是原来的 28 与 22）。
// 根字号随窗口大小与「字号 小 中 大」三档变化，useRootPx 跟着它重算；主题对象每次都传，不会让 Ant Design 重新挂载。
const TOKEN_FROM: [string, string][] = [
  // 这两项是 Ant Design 推算其余中性色的起点：没有在下面单独对上的边线、停用的底与字、各级填充，都从它们算出来，
  // 所以停用的按钮、上传区这些地方的灰跟着界面风格走，不会留下一块与纸面不合的灰白
  ["colorTextBase", "--ink"],
  ["colorBgBase", "--card"],
  ["colorPrimary", "--ink"],
  // 主按钮这类实底上的字
  ["colorTextLightSolid", "--on-ink"],
  ["colorText", "--ink"],
  ["colorTextSecondary", "--mut"],
  ["colorTextTertiary", "--mut"],
  ["colorBorder", "--line2"],
  ["colorBorderSecondary", "--line"],
  ["colorBgLayout", "--paper"],
  ["colorBgContainer", "--card"],
  // 弹窗、下拉、提示这些浮层的底：不对到卡片色的话，暖纸里它们会比卡片白一块
  ["colorBgElevated", "--card"],
  ["colorFillSecondary", "--sel"],
  ["colorLink", "--blue"],
  ["colorSuccess", "--ok"],
  ["colorWarning", "--amber"],
  ["colorError", "--gap"],
  ["colorInfo", "--blue"],
  ["fontFamily", "--font-body"],
];

/** 当前界面风格下 Ant Design 的颜色与字体令牌。 */
export function themeTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const [token, variable] of TOKEN_FROM) {
    const value = style.getPropertyValue(variable).trim();
    if (value) tokens[token] = value;
  }
  return tokens;
}

export function App() {
  const route = useRoute();
  const px = useRootPx();
  const style = useTheme();
  // 分两层：颜色与字体只在切换界面风格时重读；字号与控件高度跟着根字号重算，不用再读一遍颜色。
  // style 不在计算里用到，它是「该重读了」的信号：themeTokens 读的是页面上此刻算好的值。
  const colours = useMemo(() => themeTokens(), [style]);
  const theme = useMemo(() => ({
    token: { ...colours, lineHeight: 1.65, fontSize: Math.round(px * 0.929), controlHeight: Math.round(px * 2), controlHeightSM: Math.round(px * 1.571),
      borderRadius: Math.round(px * 0.571), borderRadiusSM: Math.round(px * 0.429) },
  }), [colours, px]);
  return (
    <ConfigProvider locale={zhCN} theme={theme} button={{ autoInsertSpace: false }}>
      <AntApp>
        <ToastProvider>
          <ServiceProvider>
          {route.page === "tasks" && <TaskListPage />}
          {route.page === "task" && <TaskPage key={route.taskId} taskId={route.taskId} />}
          {route.page === "start" && <StartInputPage key={`${route.taskId}/${route.key}`} taskId={route.taskId} startKey={route.key} startCase={route.startCase} pick={route.pick ?? []} />}
          {route.page === "knowledge" && <KnowledgePage libraryId={route.libraryId} />}
          {route.page === "work" && <WorkViewPage key={`${route.taskId}/${route.sessionId}`} taskId={route.taskId} sessionId={route.sessionId} collection={route.collection}
            diagrams={route.diagrams} diagram={route.diagram} />}
          {route.page === "settings" && <SettingsPage />}
          </ServiceProvider>
        </ToastProvider>
      </AntApp>
    </ConfigProvider>
  );
}
