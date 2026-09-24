/**
 * 用户 agent 的扩展入口：只登记两个工具，「看界面」（look）与「回应」（respond）。工具集就是这个角色的权限边界：
 * 它没有 read、没有写库的工具，看不到执行者的 skill、规矩文档与库，只能经后端接口看界面、回应。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLook } from "./tools/look.ts";
import { registerRespond } from "./tools/respond.ts";

export default function (pi: ExtensionAPI) {
  registerLook(pi);
  registerRespond(pi);
}
