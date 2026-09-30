// 任务现在的材料清单，给条目详情的来源用：出处文件不在清单里，就是那份材料已经删除了。
// 只有工作视图拿到整份数据之后才提供；没有提供（null）时一律当作材料还在，不写「已经删除」。

import { createContext } from "react";
import type { Material } from "../api/types";
import { ownMaterials } from "../model/docx";

export const MaterialsContext = createContext<Material[] | null>(null);

/** 出处的文件路径（Word 材料的出处先去掉段落号）在不在材料清单里。出处只写了文件名时按文件名对。 */
export function hasMaterial(materials: Material[], path: string): boolean {
  return ownMaterials(materials).some((m) => m.path === path || m.path.endsWith(`/${path}`));
}
