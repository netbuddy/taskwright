// 现在的知识库清单，给条目详情的来源用：把出处里的知识库编号换成名字，并判断那份文档还在不在知识库里。
// 只有工作视图取到清单之后才提供；没有提供（null）时不判断，一律当作文档还在。服务没有知识库时提供空清单。

import { createContext } from "react";
import type { KnowledgeLibrary } from "../api/types";

export const KnowledgeContext = createContext<KnowledgeLibrary[] | null>(null);
