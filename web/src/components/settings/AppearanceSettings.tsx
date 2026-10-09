// 设置页面的「外观」一栏：选界面风格。两种风格（暖纸、素白）各一张卡，卡上面是一小块预览、下面是名字与一句说明，
// 当前的打勾；点哪张就立刻换成哪一种，并存在这个浏览器里（model/theme.ts）。
// 预览那一块自己带 data-theme，所以它用的是那一种风格的颜色与字体，不随页面当前的风格变（styles.css 开头的两个令牌块）。

import { CheckOutlined } from "@ant-design/icons";
import { THEMES, saveTheme, useTheme } from "../../model/theme";

export function AppearanceSettings() {
  const current = useTheme();
  return (
    <div data-testid="appearance-settings">
      <div className="page-title"><h1>外观</h1></div>
      <p className="lede">
        界面风格只换颜色与标题的字体，页面上各样东西的位置与大小不变。选了哪一种存在这个浏览器里：换一个浏览器或者换一台电脑，要重新选一次。
      </p>

      <div className="section-title first">界面风格</div>
      <div className="style-cards" role="radiogroup" aria-label="界面风格">
        {THEMES.map((one) => {
          const on = one.key === current;
          return (
            <button type="button" key={one.key} role="radio" aria-checked={on} className={`style-card${on ? " on" : ""}`}
              data-testid={`style-${one.key}`} onClick={() => saveTheme(one.key)}>
              <span className="pv" data-theme={one.key} aria-hidden="true">
                <span className="pv-top">任务的名字</span>
                <span className="pv-body">
                  <span className="pv-text">正文是这个样子。</span>
                  <span className="pv-rule" />
                  <span className="pv-btn">主要的按钮</span>
                </span>
              </span>
              <span className="sc-name"><span className="nm">{one.label}</span>{on && <span className="ck" data-testid={`style-on-${one.key}`}><CheckOutlined />现在用的</span>}</span>
              <span className="sc-note">{one.note}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
