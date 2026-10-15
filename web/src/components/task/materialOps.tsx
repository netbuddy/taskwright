// 材料的三样操作：上传、替换、删除。任务起点页与活动输入页的材料卡（MaterialsCard.tsx）、工作台「材料与证据」页签
// （components/work/MaterialsPane.tsx）共用。替换要先选文件、再弹确认框；删除先弹确认框。两个确认框与替换用的文件选择框
// 由调用方放进页面（elements）。材料一旦进入了对话就不能替换、不能删除，后端在任务详情里给每份材料标了 deletable，调用方只按它决定按钮。

import { useRef, useState, type ReactNode } from "react";
import { Modal } from "antd";
import type { UploadProps } from "antd";
import { api, ApiError } from "../../api/client";
import type { ServiceInfo } from "../../api/types";
import { pdfUploadingText, tooLargeText, unsupportedTypeText, uploadAccept } from "../../model/upload";
import { forgetDocx } from "../../state/docxStore";
import { forgetPdf } from "../../state/pdfStore";
import { useToast } from "../Toasts";

export const fileName = (path: string) => path.split("/").pop() ?? path;

export interface MaterialOps {
  /** 给 antd 的 Upload 用的上传函数：类型与大小先查，PDF 先说一句要等一会儿。 */
  upload: UploadProps["customRequest"];
  /** 点「替换」：打开文件选择框，选好了弹确认框。 */
  replace: (path: string) => void;
  /** 点「删除」：弹确认框。 */
  remove: (path: string) => void;
  /** 替换用的文件选择框与两个确认框。 */
  elements: ReactNode;
}

export function useMaterialOps(taskId: string, info: ServiceInfo | null, onChanged: () => void): MaterialOps {
  const toast = useToast();
  const [deleting, setDeleting] = useState<string | null>(null);
  // 删除请求发出去、还没有回来：确认框的「删除」转圈、「取消」不可点，再点不会发第二次。
  const [removing, setRemoving] = useState(false);

  const doRemove = async () => {
    const path = deleting;
    if (!path || removing) return;
    setRemoving(true);
    try {
      await api.deleteMaterial(taskId, path);
      forgetDocx(taskId, path);
      forgetPdf(taskId, path);
      toast.success(`已删除材料《${fileName(path)}》。`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "删除没有成功。");
      // 被拒绝多半是它刚进入了对话：重读一次，让「删除」按新的情况显示。
      onChanged();
    } finally {
      setRemoving(false);
      setDeleting(null);
    }
  };

  // 替换：点「替换」先记下是哪份材料、打开文件选择框；选好文件（类型与大小照上传的规矩先查）才弹确认框。
  const picker = useRef<HTMLInputElement>(null);
  const pickFor = useRef<string | null>(null);
  const [replacing, setReplacing] = useState<{ path: string; file: File } | null>(null);
  // 替换请求发出去、还没有回来：确认框的「替换」转圈、「取消」不可点，再点不会发第二次。
  const [swapping, setSwapping] = useState(false);

  const pick = (path: string) => {
    pickFor.current = path;
    if (picker.current) {
      picker.current.value = ""; // 连着两次选同一个文件也要触发
      picker.current.click();
    }
  };
  const picked = (file: File | undefined) => {
    const path = pickFor.current;
    pickFor.current = null;
    if (!file || !path) return;
    const refused = unsupportedTypeText(info, file) ?? tooLargeText(info, file);
    if (refused) toast.error(refused);
    else setReplacing({ path, file });
  };
  const doReplace = async () => {
    if (!replacing || swapping) return;
    const { path, file } = replacing;
    setSwapping(true);
    try {
      const r = await api.replaceMaterial(taskId, path, file);
      forgetDocx(taskId, path);
      forgetDocx(taskId, r.path);
      forgetPdf(taskId, path);
      forgetPdf(taskId, r.path);
      const [was, now] = [fileName(path), fileName(r.path)];
      toast.success(was === now ? `已替换材料《${was}》。` : `已把材料《${was}》替换成《${now}》。`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "替换没有成功。");
      // 被拒绝多半是它刚进入了对话：重读一次，让「替换」按新的情况显示。
      onChanged();
    } finally {
      setSwapping(false);
      setReplacing(null);
    }
  };


  const upload: UploadProps["customRequest"] = async ({ file, onSuccess, onError }) => {
    // 类型不符或超过上限的文件不发请求，直接报后端给的那句话（先查类型，与后端的先后相同）。
    // 拖进来的文件与在选择框里选了「所有文件」时选中的文件都不经过滤，所以类型也要在这里查。
    const refused = unsupportedTypeText(info, file as File) ?? tooLargeText(info, file as File);
    if (refused) {
      toast.error(refused);
      onError?.(new Error(refused));
      return;
    }
    // PDF 要等一会儿：先说一句，结果出来时原地换成结果（同一个 key）。
    const waiting = pdfUploadingText((file as File).name);
    const same = waiting ? { key: `upload:${(file as File).name}` } : undefined;
    if (waiting && same) toast.running(same.key, waiting);
    try {
      const r = await api.uploadMaterial(taskId, file as File);
      toast.success(`已上传：${r.path}`, same);
      onSuccess?.({});
      onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "上传没有成功。", same);
      onError?.(e as Error);
    }
  };

  const elements = (
    <>
      {/* 替换用的文件选择框：看不见，由「替换」打开。 */}
      <input ref={picker} type="file" accept={uploadAccept(info)} hidden onChange={(e) => picked(e.target.files?.[0])} data-testid="material-replace-input" />
      <Modal title={replacing ? `用《${replacing.file.name}》替换材料《${fileName(replacing.path)}》？` : ""} open={!!replacing}
        onCancel={() => { if (!swapping) setReplacing(null); }} onOk={() => void doReplace()} okText="替换" cancelText="取消" confirmLoading={swapping}
        cancelButtonProps={{ disabled: swapping }} closable={!swapping} maskClosable={!swapping} keyboard={!swapping} destroyOnHidden>
        <p>用新文件替换这份材料，旧文件就没有了；助手下次开始会话时看到的是新文件。</p>
      </Modal>
      <Modal title={deleting ? `删除材料《${fileName(deleting)}》？` : ""} open={!!deleting} onCancel={() => { if (!removing) setDeleting(null); }}
        onOk={() => void doRemove()} okText="删除" cancelText="取消" confirmLoading={removing} cancelButtonProps={{ disabled: removing }}
        closable={!removing} maskClosable={!removing} keyboard={!removing} destroyOnHidden>
        <p>删除之后这份材料就没有了，助手下次开始会话时不会再看到它。</p>
      </Modal>
    </>
  );
  return { upload, replace: pick, remove: setDeleting, elements };
}
