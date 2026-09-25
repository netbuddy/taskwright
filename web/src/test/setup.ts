import "@testing-library/jest-dom/vitest";

// jsdom 没有这几样，antd 的组件会用到。
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
       addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as MediaQueryList;
}
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= ResizeObserverStub;
Element.prototype.scrollIntoView ??= function () {};
// docx-preview 画文本框时在下一帧量 SVG 的外框；jsdom 没有 getBBox，给一个全零的。
(Element.prototype as unknown as { getBBox?: () => DOMRect }).getBBox ??= () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
