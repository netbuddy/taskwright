// 直接操作被拒时提示条上的那句话：后端给了 message 就照它写；几种页面自己说的只在后端没给时补上。
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { errorText, rejectedText } from "../components/work/errors";

describe("被拒时的那句话", () => {
  it("等扩展命令的结果超时（busy_timeout）：照后端的说法，不改写成数据库忙", () => {
    const said = "这次操作没有在 10 秒内得到结果，请稍后看是否已经生效。";
    expect(errorText(new ApiError("busy_timeout", said, 503, { op_id: "op-1" }))).toBe(said);
    expect(rejectedText("修改 UC-002 的基本流程", new ApiError("busy_timeout", said, 503))).toBe(`修改 UC-002 的基本流程 没有完成：${said}`);
    expect(errorText(new ApiError("busy_timeout", "", 503))).toBe("这次操作没有及时得到结果，请稍后看是否已经生效。");
  });

  it("请求不对（bad_request）：后端给了说明就照它写，没给才用笼统的一句", () => {
    expect(errorText(new ApiError("bad_request", "这份 PDF 打不开。", 400))).toBe("这份 PDF 打不开。");
    expect(errorText(new ApiError("bad_request", "", 400))).toBe("出了一点问题，这次操作没有完成。");
  });
});
