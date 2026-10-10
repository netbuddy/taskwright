// 设置页面：左侧是栏目的清单，右边是选中那一栏的内容。现在有「模型」与「外观」两栏，「知识库」是灰色的占位；
// 服务开着调试模式（带 --debug 启动）时多一栏「调试」，里面是提示词目录。
// 进来时打开的是「模型」；当前是哪一栏只记在页面里，不写进地址。左上角「回到任务」回到进设置页面之前的页面。

import { useState } from "react";
import { BgColorsOutlined, BookOutlined, BugOutlined, DatabaseOutlined, LeftOutlined } from "@ant-design/icons";
import { useService } from "../components/ServiceControls";
import { AppearanceSettings } from "../components/settings/AppearanceSettings";
import { DebugSettings } from "../components/settings/DebugSettings";
import { ModelSettings } from "../components/settings/ModelSettings";
import { leaveSettingsHref } from "../router";
import "../styles/settings.css";

type Section = "model" | "appearance" | "debug";

export function SettingsPage() {
  const [section, setSection] = useState<Section>("model");
  const debug = useService().info?.debug === true;
  const item = (key: Section, label: string, icon: React.ReactNode) => (
    <div className={`nav-item${section === key ? " on" : ""}`} role="button" tabIndex={0} aria-current={section === key ? "page" : undefined}
      data-testid={`settings-nav-${key}`} onClick={() => setSection(key)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSection(key); } }}>
      {icon}{label}
    </div>
  );
  return (
    <div className="shell settings">
      <div className="shell-card">
        <aside className="sider">
          <a className="set-back" href={leaveSettingsHref()} data-testid="leave-settings"><LeftOutlined />回到任务</a>
          <div className="sider-head">设置</div>
          <nav className="set-nav">
            {item("model", "模型", <DatabaseOutlined className="nic" />)}
            {item("appearance", "外观", <BgColorsOutlined className="nic" />)}
            {debug && item("debug", "调试", <BugOutlined className="nic" />)}
            <div className="nav-item off" aria-disabled="true"><BookOutlined className="nic" />知识库<span className="later">还没有做</span></div>
          </nav>
        </aside>
        <main className="main">{section === "model" ? <ModelSettings /> : section === "debug" && debug ? <DebugSettings /> : <AppearanceSettings />}</main>
      </div>
    </div>
  );
}
