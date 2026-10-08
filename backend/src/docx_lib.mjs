/**
 * 写 Word 文件用的 docx 包里用到的那几样。导出条目（src/export_docx.ts）只从这里取，不直接写包名：
 * 仓库里本文件从仓根的 node_modules 取 docx；安装包不带 node_modules，构建时把本文件连同 docx 打成文件放在
 * backend/vendor/docx/（release/build.mjs），导出时改从那里加载。这里列得少，打出来的文件也就小。
 */
export { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
