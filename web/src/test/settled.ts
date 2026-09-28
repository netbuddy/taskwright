// 等一个被替换掉的接口（vi.spyOn 之后的 api 方法）返回的承诺全部落定，并让页面处理完它的结果，再往下断言。
//
// 用在「接口失败或给的内容不带可见标志时，页面应当照旧」的测试里。这种情形页面上不留痕迹：失败时页面把状态设回「没有」，
// 与还没取到时一模一样，所以不能靠等某个元素出现来确认。只等「接口被调用过」也不够：被调用不等于结果已经处理完，
// 这时断言「某样东西不存在」会在结果进页面之前就成立，页面真把事情做错了也照样通过。

import { act, waitFor } from "@testing-library/react";

interface Called { mock: { calls: unknown[][]; results: { value: unknown }[] } }

export async function settled(fn: Called): Promise<void> {
  await waitFor(() => { if (!fn.mock.calls.length) throw new Error("接口还没有被调用"); });
  await act(async () => {
    await Promise.allSettled(fn.mock.results.map((r) => r.value));
    // 页面对结果的处理挂在同一个承诺后面的几步里（.then 之后再 .catch）；隔一个宏任务，让这几步都跑完。
    await new Promise((ok) => setTimeout(ok, 0));
  });
}
