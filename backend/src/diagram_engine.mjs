/**
 * 图表的校验引擎：只做一件事，把 mermaid 的解析功能在没有浏览器环境的 Node 里接出来。
 *
 * mermaid 解析流程图、类图、状态图时要调清洗库 dompurify 过滤标签里的 HTML；没有浏览器环境时这个库不提供任何函数，
 * 一调就报错。校验只看语法、不产出图，用不着清洗，所以这里给它补上三个什么都不做的函数。这依赖 mermaid 与它用的是
 * 同一份 dompurify，因此 mermaid 的版本是钉死的；换版本前先跑 tests/diagram_validate.test.ts。
 *
 * 仓库里直接运行本文件，mermaid 与 dompurify 从仓根的 node_modules 来。安装包不带 node_modules：构建时把本文件连同
 * 它用到的 mermaid 打成一组文件放在 backend/vendor/mermaid/（release/build.mjs），校验时改从那里加载。
 */
import DOMPurify from "dompurify";
import mermaid from "mermaid";

if (typeof DOMPurify.sanitize !== "function") {
  DOMPurify.sanitize = (text) => String(text);
  DOMPurify.addHook = () => {};
  DOMPurify.removeHook = () => {};
}

/**
 * 看一段 Mermaid 文本。返回 { type, error }：type 是 mermaid 从开头认出的图类型（例如 flowchart-v2、classDiagram、
 * stateDiagram、sequence），认不出是 null；error 是解析没有通过时的 { message, line }（line 是 mermaid 给的行号，
 * 没有给是 null），通过时是 null。
 */
export async function inspect(text) {
  try {
    const { diagramType } = await mermaid.parse(text);
    return { type: diagramType, error: null };
  } catch (error) {
    // 没有通过：先分清是开头认不出图的类型，还是认出了类型而语法不对。mermaid 第一次解析时才登记各种图的识别规则，
    // 所以 detectType 要放在 parse 之后调；带上当前配置，认出的类型才与 parse 通过时给的叫法相同
    // （不带配置时类图叫 class，带了叫 classDiagram）。
    let type;
    try {
      type = mermaid.detectType(text, mermaid.mermaidAPI.getConfig());
    } catch {
      return { type: null, error: null };
    }
    const line = error?.hash?.loc?.first_line;
    return { type, error: { message: String(error?.message ?? error), line: Number.isInteger(line) ? line : null } };
  }
}
