// 图表的渲染与导出：把一段 Mermaid 文本画成 SVG，把 SVG 导出成 PNG 文件。
//
// mermaid 很大，所以用到时才加载（import()），构建时它自己成为单独的文件，不进页面一打开就要取的那个脚本。
// 图上的文字照 mermaid 的缺省办法画（嵌在 SVG 里的 HTML），这样各种图的文字位置都是对的。
//
// 导出 PNG 分三步：给 SVG 写上明确的宽高（mermaid 输出的是 width="100%"，单独当图片用时没有固有大小）；把它经
// data 地址交给一个图片元素；画到放大了的白底画布上再取 PNG。必须经 data 地址：经 blob 地址时，SVG 里嵌着 HTML 的图
// 会让浏览器把画布判为不许导出。

type Mermaid = typeof import("mermaid").default;

/** 导出的 PNG 比页面上的图放大几倍。 */
export const PNG_SCALE = 2;
/** 画布的边长与面积上限（像素）：超过了浏览器画不出来，特别大的图按这两个数把倍数降下来。 */
export const CANVAS_MAX_SIDE = 16384;
export const CANVAS_MAX_AREA = 64_000_000;

let loading: Promise<Mermaid> | null = null;
let serial = 0;

/** 第一次用到时加载 mermaid 并设好；没有加载成时下一次再试。 */
export function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((module) => {
    // securityLevel 用 strict：文字里的 HTML 被清洗，图上的点击不执行脚本。suppressErrorRendering：画不出来时不往页面里塞它自己的报错图。
    module.default.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true });
    return module.default;
  });
  loading.catch(() => { loading = null; });
  return loading;
}

/** 把 Mermaid 文本画成 SVG 文本；语法不对或画不出来时抛出错误，message 是 mermaid 的原话。 */
export async function renderDiagram(text: string): Promise<string> {
  const mermaid = await loadMermaid();
  const id = `diagram-${++serial}`;
  try {
    return (await mermaid.render(id, text)).svg;
  } finally {
    // mermaid 画图时在页面里放过临时的元素，出错时不一定收走。
    for (const leftover of [document.getElementById(id), document.getElementById(`d${id}`)]) leftover?.remove();
  }
}

/** 给 SVG 写上明确的宽高（取 viewBox 的大小）。返回改过的 SVG 文本与宽高。 */
export function sizedSvg(svg: string): { text: string; width: number; height: number } {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const box = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const width = Math.ceil(box[2] > 0 ? box[2] : Number.parseFloat(root.getAttribute("width") ?? "") || 800);
  const height = Math.ceil(box[3] > 0 ? box[3] : Number.parseFloat(root.getAttribute("height") ?? "") || 600);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  // 去掉 mermaid 写在 style 里的 max-width（直接改属性的文字：没有写命名空间的 SVG 解析出来的元素没有 style 对象）。
  const style = (root.getAttribute("style") ?? "").replace(/max-width\s*:[^;]*;?/gi, "").trim();
  if (style) root.setAttribute("style", style);
  else root.removeAttribute("style");
  if (!root.getAttribute("xmlns")) root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return { text: new XMLSerializer().serializeToString(root), width, height };
}

/** 这么大的图导出时放大几倍：平常是 PNG_SCALE；放大后超过画布上限的，降到正好放得下。 */
export function pngScale(width: number, height: number): number {
  return Math.min(PNG_SCALE, CANVAS_MAX_SIDE / width, CANVAS_MAX_SIDE / height, Math.sqrt(CANVAS_MAX_AREA / (width * height)));
}

/** 文件名里不能有的字符换成下划线；空的时候叫「图」。 */
export function pngFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().replace(/^\.+/, "");
  return `${cleaned || "图"}.png`;
}

/** 把 SVG 画成 PNG。返回 PNG 数据、它的宽高（像素）与实际放大的倍数。 */
export async function svgToPng(svg: string): Promise<{ blob: Blob; width: number; height: number; scale: number }> {
  const { text, width, height } = sizedSvg(svg);
  const scale = pngScale(width, height);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("浏览器读不出这张图。"));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器没有给出画布。");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("浏览器没有给出 PNG。"))), "image/png");
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return { blob, width: canvas.width, height: canvas.height, scale };
}

/** 把 SVG 导出成 PNG 文件并让浏览器下载。name 是不带扩展名的文件名。返回实际放大的倍数。 */
export async function exportPng(svg: string, name: string): Promise<{ scale: number }> {
  const { blob, scale } = await svgToPng(svg);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = pngFileName(name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { scale };
}
