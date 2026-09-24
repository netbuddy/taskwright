// 几样全页面都要用的东西：总览（工具中文名、Langfuse 链接底座）与顶栏的链接。

import { $ } from "./util.js";

export const state = {
  overview: null,
};

/** 换顶栏右上角那条到 Langfuse 的链接。没有地址就把它藏起来。 */
export function setLangfuse(href, text) {
  const link = $("#lfTop");
  if (!href) {
    link.hidden = true;
    return;
  }
  link.hidden = false;
  link.href = href;
  link.textContent = text || "到 Langfuse 看原始记录";
}

export function setCrumb(html) {
  $("#crumb").innerHTML = html || "";
}

/** 每次渲染都换一个干净的容器，免得上一页挂的事件监听还留着。 */
export function freshView() {
  const old = $("#view");
  const box = document.createElement("div");
  box.id = "view";
  old.replaceWith(box);
  return box;
}
