// 页面的类型检查不带 Node 的类型定义（tsconfig 的 types 只有 vitest 与 jest-dom）。测试里要读仓库里的文件（例如样式表）时，
// 只用 node:fs 的这两个函数（读一个文件、列一个目录），在这里声明它们，不为此引入新的依赖。
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf-8"): string;
  export function readdirSync(path: string): string[];
}
