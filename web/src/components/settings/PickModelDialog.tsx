// 「更换」「选择」打开的对话框：只列用途对得上的模型服务（语言模型含手工登记的那一组），按模型服务分组列出勾选了的模型，选一个再点「用这个模型」。
// 在这里添加的模型服务里，还没有填上下文长度的语言模型不能选，旁边给「去填」；手工登记的那一组不受此限（后端也不拦）。
// 嵌入模型另有「不用嵌入模型」一项，「高级」里是查询前缀。选定时另一种模型原样传回。这一批不做测试。
// 选的嵌入模型与现在的不同（原来没有选也算）、而且知识库里已经有文档时，点「用这个模型」先问一句：这些文档要用新的模型换算。
// 确定之后先保存选择，再让后台开始换算。只改查询前缀、改成「不用嵌入模型」都不问：前一种不用重新换算，后一种没有可换算的。

import { useEffect, useState } from "react";
import { App as AntApp, Button, Input, Modal, Radio } from "antd";
import { RightOutlined } from "@ant-design/icons";
import { api, ApiError } from "../../api/client";
import type { ModelConfig, ModelSelection, ModelType } from "../../api/types";
import { useService } from "../ServiceControls";
import { useToast } from "../Toasts";
import { EMBEDDING_LABEL, LANGUAGE_LABEL, embedConfirmOk, embedConfirmText, embedConfirmTitle, embedStartedText, formatNumber } from "./text";

const NONE = "";
const keyOf = (providerId: string, modelId: string) => JSON.stringify([providerId, modelId]);

export function PickModelDialog({ config, type, onClose, onPicked, onGoFill }: {
  config: ModelConfig;
  type: ModelType;
  onClose: () => void;
  /** 选定成功：后端返回的新选择与那句生效说明。 */
  onPicked: (selection: ModelSelection, note: string) => void;
  /** 「去填」：关掉对话框，打开那个模型服务的详情。 */
  onGoFill: (providerId: string) => void;
}) {
  const toast = useToast();
  const { modal } = AntApp.useApp();
  const { info } = useService();
  const language = type === "language";
  const current = language ? config.selection.language : config.selection.embedding;
  const [pick, setPick] = useState<string>(current ? keyOf(current.provider_id, current.model_id) : NONE);
  const [prefix, setPrefix] = useState(config.selection.embedding?.query_prefix ?? "");
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // 知识库里文档的份数：选嵌入模型而且服务有知识库时取一次；没取到（null）就不问，也不替用户开始换算。
  const [documents, setDocuments] = useState<number | null>(null);
  const hasKnowledge = !language && info?.capabilities.knowledge === true;
  useEffect(() => {
    if (!hasKnowledge) return;
    let live = true;
    api.knowledgeOverview().then((got) => { if (live) setDocuments(got.embedding.total); }).catch(() => undefined);
    return () => { live = false; };
  }, [hasKnowledge]);

  // 只列提供这一类模型的模型服务；手工登记的那些都算语言模型，所以选嵌入模型时不会出现。
  const groups = config.providers
    .filter((p) => p.purpose === type)
    .map((p) => ({ provider: p, models: p.models.filter((m) => m.enabled) }))
    .filter((g) => g.models.length > 0);

  const unchanged = language ? pick === (current ? keyOf(current.provider_id, current.model_id) : NONE)
    : pick === (current ? keyOf(current.provider_id, current.model_id) : NONE) && prefix === (config.selection.embedding?.query_prefix ?? "");

  /** 保存选择。embed 为真时保存成功之后接着让后台开始换算知识库里的文档。 */
  const save = async (chosen: [string, string] | null, embed: boolean) => {
    const body: ModelSelection = language
      ? { language: chosen && { provider_id: chosen[0], model_id: chosen[1] }, embedding: config.selection.embedding }
      : { language: config.selection.language, embedding: chosen && { provider_id: chosen[0], model_id: chosen[1], query_prefix: prefix } };
    setSaving(true);
    setError("");
    try {
      const got = await api.selectModels(body);
      toast.success(chosen ? `${language ? LANGUAGE_LABEL : EMBEDDING_LABEL}已换成 ${chosen[1]}。` : "已不用嵌入模型。");
      if (embed) {
        // 选择已经保存了；换算没能开始时只提示一句，用户可以到知识库页面上点「开始换算」。
        try {
          await api.embedKnowledge();
          toast.success(embedStartedText(documents ?? 0));
        } catch (e) {
          toast.error(`没能开始换算知识库里的文档：${e instanceof ApiError ? e.message : "请到知识库页面上再试。"}`);
        }
      }
      onPicked(got.selection, got.note);
    } catch (e) {
      if (e instanceof ApiError && e.code === "rejected") setError(e.message);
      else toast.error(e instanceof ApiError ? e.message : "更换没有成功。");
    } finally {
      setSaving(false);
    }
  };

  const use = () => {
    const chosen = pick === NONE ? null : (JSON.parse(pick) as [string, string]);
    const another = !language && chosen !== null && (!current || current.provider_id !== chosen[0] || current.model_id !== chosen[1]);
    if (!another || !documents) return void save(chosen, false);
    modal.confirm({
      title: embedConfirmTitle(!!current), content: embedConfirmText(documents, !!current), okText: embedConfirmOk(!!current), cancelText: "取消",
      onOk: () => { void save(chosen, true); },
    });
  };

  const title = `${current ? "更换" : "选择"}${language ? LANGUAGE_LABEL : EMBEDDING_LABEL}`;
  return (
    <Modal open title={title} onCancel={onClose} destroyOnHidden width="34rem"
      footer={
        <div className="pick-foot">
          <span className="fnote">更换之后，下一次打开或者新建会话时生效。</span>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} disabled={unchanged} onClick={use} data-testid="use-model">用这个模型</Button>
        </div>
      }>
      <div className="settings-pick" data-testid={`pick-${type}`}>
        <div className="muted small">
          {language ? "下面按模型服务分组，列出各个模型服务里勾上的语言模型。"
            : "下面按模型服务分组，列出各个模型服务里勾上的嵌入模型。嵌入模型可以不选，不选时知识库只能按字面查找。"}
        </div>
        {groups.length === 0 && language && <div className="pempty">还没有可选的语言模型。请先在模型服务的清单里勾上模型。</div>}
        <Radio.Group value={pick} onChange={(e) => setPick(e.target.value)} className="pick">
          {groups.map(({ provider, models }) => (
            <div key={provider.id}>
              <div className="pg">{provider.name}</div>
              {models.map((m) => {
                const k = keyOf(provider.id, m.id);
                const unfilled = language && provider.managed && m.context_window === null;
                const isCurrent = current !== null && k === keyOf(current.provider_id, current.model_id);
                return (
                  <Radio key={m.id} value={k} disabled={unfilled} className={`po${unfilled ? " dis" : ""}${pick === k ? " on" : ""}`} data-testid={`pick-${provider.id}-${m.id}`}>
                    <span className="pb">
                      <span className="pn">{m.id}</span>
                      {unfilled ? (
                        <span className="pc">还没有填上下文长度。<a role="button" onClick={(e) => { e.preventDefault(); onGoFill(provider.id); }}>去填</a></span>
                      ) : (
                        <span className="pc">
                          {language && m.context_window !== null && `上下文长度 ${formatNumber(m.context_window)}`}
                          {isCurrent && `${language && m.context_window !== null ? " · " : ""}现在用的就是这个`}
                        </span>
                      )}
                    </span>
                  </Radio>
                );
              })}
            </div>
          ))}
          {!language && (
            <Radio value={NONE} className={`po${pick === NONE ? " on" : ""}`} data-testid="pick-no-embedding">
              <span className="pb"><span className="pn plain">不用嵌入模型</span><span className="pc">知识库只能按字面查找。</span></span>
            </Radio>
          )}
        </Radio.Group>
        {!language && (
          <div className={`fold${advanced ? " open" : ""}`}>
            <a role="button" className="fh" onClick={() => setAdvanced(!advanced)}><RightOutlined className="fic" />高级</a>
            {advanced && (
              <div className="fb">
                <div className="flabel">查询前缀</div>
                <Input.TextArea rows={2} value={prefix} disabled={pick === NONE} onChange={(e) => setPrefix(e.target.value)} data-testid="query-prefix" />
                <div className="fhelp">查找时加在查询前面的一句话。被查找的文档不加。不清楚就留空。</div>
              </div>
            )}
          </div>
        )}
        {error && <div className="ferr" data-testid="pick-error">{error}</div>}
      </div>
    </Modal>
  );
}
