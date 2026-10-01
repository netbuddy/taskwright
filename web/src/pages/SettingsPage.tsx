// 设置页面：左侧是栏目的清单，这一次只有「模型」一栏；「知识库」是灰色的占位。左上角「回到任务」回到进设置页面之前的页面。

import { BookOutlined, DatabaseOutlined, LeftOutlined } from "@ant-design/icons";
import { ModelSettings } from "../components/settings/ModelSettings";
import { leaveSettingsHref } from "../router";
import "../styles/settings.css";

export function SettingsPage() {
  return (
    <div className="shell settings">
      <div className="shell-card">
        <aside className="sider">
          <a className="set-back" href={leaveSettingsHref()} data-testid="leave-settings"><LeftOutlined />回到任务</a>
          <div className="sider-head">设置</div>
          <nav className="set-nav">
            <div className="nav-item on"><DatabaseOutlined className="nic" />模型</div>
            <div className="nav-item off" aria-disabled="true"><BookOutlined className="nic" />知识库<span className="later">还没有做</span></div>
          </nav>
        </aside>
        <main className="main"><ModelSettings /></main>
      </div>
    </div>
  );
}
