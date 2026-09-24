// 页面各处都用的小工具：转义、取元素、缩写编号、取不到的事实怎么显示。
// 这里不认识任何具体的工具名、字段名与任务名。

export const $ = (selector, root = document) => root.querySelector(selector);

export function esc(value) {
  return String(value == null ? "" : value)
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** 把一长串编号缩成「前六位…后四位」，完整值放在悬停提示里。 */
export function shortId(value) {
  if (!value) return "";
  return value.length <= 11 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** 取不到的事实一律这样显示，不留空白让人以为是没有。 */
export function unknown(text) {
  return `<span class="unknown">${esc(text)}</span>`;
}

