// 设置页面的「模型」一栏：上半部分「现在用的模型」两行，下半部分「模型服务」（左边清单，右边选中的那一个的详情）。
// 「添加模型服务」换成添加的画面；添加成功之后回到这里，右边打开新的那一个，并随即获取一次它的模型列表。
// editable 为假时整栏只读，顶上是后端给的那句说明。现在的后端 editable 恒为 true（从哪台电脑打开都能改），这条只读的路留着。
// 语言模型那一行有「测试」：后端起一次助手，让模型读一个小文件并回答一句；结果连同问与答写在这一行下面，换了模型或者刷新页面就清掉。

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App as AntApp, Button, Spin } from "antd";
import { CheckCircleFilled, LockOutlined, PlusOutlined, WarningFilled, WarningOutlined } from "@ant-design/icons";
import { api, ApiError } from "../../api/client";
import type { ModelConfig, ModelSelection, ModelTestResult, ModelType, Provider } from "../../api/types";
import { useService } from "../ServiceControls";
import { useToast } from "../Toasts";
import { AddProvider } from "./AddProvider";
import { PickModelDialog } from "./PickModelDialog";
import { ProviderDetail, type FetchNote } from "./ProviderDetail";
import {
  APPLIES_TEXT, EMBEDDING_LABEL, LANGUAGE_LABEL, formatNumber, kindName, selected, testConfirmText, testQuestionText, testReplyText, testResultText,
} from "./text";

export function ModelSettings() {
  const toast = useToast();
  const { modal } = AntApp.useApp();
  const { refresh, info } = useService();
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState<ModelType | null>(null);
  const [note, setNote] = useState(APPLIES_TEXT);
  const [fetching, setFetching] = useState<Set<string>>(new Set());
  const [fetchNotes, setFetchNotes] = useState<Record<string, FetchNote>>({});
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<ModelTestResult | null>(null);
  const dirty = useRef(false);
  const markDirty = useCallback((d: boolean) => { dirty.current = d; }, []);
  const detailRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.modelConfig();
      setConfig(next);
      setLoadError(null);
      return next;
    } catch (error) {
      setLoadError(error instanceof ApiError ? error.message : "读不到模型的配置。");
      return null;
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const replaceProvider = (p: Provider) =>
    setConfig((c) => c && { ...c, providers: c.providers.map((x) => (x.id === p.id ? p : x)) });

  const fetchModels = async (id: string) => {
    setFetching((s) => new Set(s).add(id));
    try {
      const got = await api.fetchModels(id);
      replaceProvider(got.provider);
      setFetchNotes((n) => {
        const next = { ...n };
        if (got.result === "listed") delete next[id]; else next[id] = { result: got.result, message: got.message };
        return next;
      });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "获取模型列表没有成功。");
    } finally {
      setFetching((s) => { const next = new Set(s); next.delete(id); return next; });
    }
  };

  /** 换一个模型服务看；清单里有没有保存的改动时先问一句。 */
  const choose = (id: string) => {
    if (id === chosen) return;
    if (!dirty.current) return setChosen(id);
    modal.confirm({
      title: "放弃清单里的改动？", content: "这个模型服务的模型清单改过了，还没有保存。换去看别的模型服务，这些改动就不要了。",
      okText: "放弃改动", cancelText: "留在这里", onOk: () => { dirty.current = false; setChosen(id); },
    });
  };

  const onAdded = async (p: Provider) => {
    setAdding(false);
    dirty.current = false;
    await load();
    setChosen(p.id);
    // 添加之后随即获取一次模型列表（Codex 订阅读的是本机的模型目录，不联网）。
    void fetchModels(p.id);
  };

  const runTest = async () => {
    setTesting(true);
    setTested(null);
    try {
      setTested(await api.testModel("language"));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "测试没有做成。");
    } finally {
      setTesting(false);
    }
  };

  /** 测试之前先问一句：会发一次真实的请求。model 是现在实际会用的那个语言模型的名字。 */
  const confirmTest = (model: string) => {
    modal.confirm({
      title: "测试语言模型", content: testConfirmText(model), okText: "开始测试", cancelText: "取消", onOk: () => { void runTest(); },
    });
  };

  const onPicked = async (_: ModelSelection, text: string) => {
    setPicking(null);
    setNote(text);
    setTested(null);
    await load();
    refresh();
  };

  const onDeleted = async () => {
    dirty.current = false;
    setChosen(null);
    await load();
  };

  if (loadError && !config) {
    return <Alert type="error" showIcon message={`读不到模型的配置：${loadError}`} action={<Button size="small" onClick={() => void load()}>重新读取</Button>} />;
  }
  if (!config) return <Spin />;
  if (adding) return <AddProvider onAdded={(p) => void onAdded(p)} onCancel={() => setAdding(false)} />;

  const editable = config.editable;
  const managed = config.providers.filter((p) => p.managed);
  const external = config.providers.filter((p) => !p.managed);
  const current = config.providers.find((p) => p.id === chosen) ?? managed[0] ?? external[0] ?? null;
  const candidates = (type: ModelType) =>
    config.providers.some((p) => (type === "language" || p.managed) && p.models.some((m) => m.enabled && m.type === type));

  const goFill = (id: string) => {
    setPicking(null);
    choose(id);
    setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  return (
    <div data-testid="model-settings">
      {!editable && config.notice && <div className="ro-note" data-testid="readonly-notice"><LockOutlined />{config.notice}</div>}
      <div className="page-title"><h1>模型</h1></div>
      <p className="lede">
        助手靠语言模型工作；知识库按意思查找时要用嵌入模型。{editable && "先在下面连接模型服务，再在上面选定用哪个模型。"}
      </p>

      <div className="section-title first">现在用的模型</div>
      <div className="card cur">
        <CurrentRow label={LANGUAGE_LABEL} type="language" config={config} editable={editable} canPick={candidates("language")} onPick={() => setPicking("language")}
          test={info?.capabilities.model_test ? { testing, result: tested, onTest: confirmTest } : undefined} />
        <CurrentRow label={EMBEDDING_LABEL} type="embedding" config={config} editable={editable} canPick={candidates("embedding")} onPick={() => setPicking("embedding")} />
        <div className="effect" data-testid="applies-note">{note}</div>
      </div>

      <div className="section-title">模型服务</div>
      {config.providers.length === 0 ? (
        <div className="card">
          <div className="empty-svcs">
            还没有连接任何模型服务。
            {editable && <div><Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)} data-testid="add-provider">添加模型服务</Button></div>}
          </div>
        </div>
      ) : (
        <div className="svcgrid">
          <div className="card svcs" data-testid="provider-list">
            {managed.length > 0 && <div className="cap">已经连接的模型服务</div>}
            {managed.map((p) => <ProviderItem key={p.id} provider={p} on={p.id === current?.id} onClick={() => choose(p.id)} />)}
            {external.length > 0 && <div className="cap" data-testid="external-group">配置文件里手工登记的</div>}
            {external.map((p) => <ProviderItem key={p.id} provider={p} on={p.id === current?.id} onClick={() => choose(p.id)} />)}
            {editable && (
              <div className="svc-add">
                <Button block icon={<PlusOutlined />} onClick={() => setAdding(true)} data-testid="add-provider">添加模型服务</Button>
              </div>
            )}
          </div>
          <div className="card" ref={detailRef}>
            {current && (
              <ProviderDetail key={current.id} config={config} provider={current} editable={editable}
                fetching={fetching.has(current.id)} fetchNote={fetchNotes[current.id] ?? null}
                onFetch={() => void fetchModels(current.id)} onChanged={replaceProvider} onDeleted={() => void onDeleted()}
                onDirty={markDirty} />
            )}
          </div>
        </div>
      )}

      {picking && <PickModelDialog config={config} type={picking} onClose={() => setPicking(null)} onPicked={(s, t) => void onPicked(s, t)} onGoFill={goFill} />}
    </div>
  );
}

function ProviderItem({ provider, on, onClick }: { provider: Provider; on: boolean; onClick: () => void }) {
  // 只有连不上（Codex 订阅是还没有登录）的那一个后面有提醒的记号，连得上的不加。
  const warn = provider.status !== null && !provider.status.ok;
  return (
    <div className={`svc${on ? " on" : ""}`} role="button" onClick={onClick} data-testid={`provider-${provider.id}`}>
      <div className="sb">
        <div className="sn">{provider.name}</div>
        {provider.managed && <div className="sk">{kindName(provider.kind, true)}</div>}
      </div>
      {warn && <WarningOutlined className="warn" title={provider.kind === "codex" ? "还没有登录" : "连不上"} data-testid={`warn-${provider.id}`} />}
    </div>
  );
}

/**
 * 「现在用的模型」的一行。右边「更换」或者「选择」；给了 test 的那一行（语言模型）再右边是「测试」，测的是现在实际会用的那个模型：
 * 选定的，没有选定时是后端说的那一个；两个都没有时按钮是灰的。测试当中不能再点，也不能更换。结果写在这一行下面。
 */
function CurrentRow({ label, type, config, editable, canPick, onPick, test }: {
  label: string; type: ModelType; config: ModelConfig; editable: boolean; canPick: boolean; onPick: () => void;
  test?: { testing: boolean; result: ModelTestResult | null; onTest: (model: string) => void };
}) {
  const ref = selected(config, type);
  const model = ref?.provider?.models.find((m) => m.id === ref.modelId) ?? null;
  let body;
  if (ref) {
    body = (
      <div>
        <span className="mname">{ref.modelId}</span>
        <span className="mmeta">{ref.provider?.name ?? ref.providerId}{type === "language" && model?.context_window != null && ` · 上下文长度 ${formatNumber(model.context_window)}`}</span>
      </div>
    );
  } else if (type === "language") {
    const fb = config.fallback;
    body = <div>还没有选。{fb && fb.model && `现在用的是：${fb.model}（来自${fb.from}）。`}</div>;
  } else {
    body = <div>还没有选。知识库只能按字面查找。</div>;
  }
  const testable = ref ? ref.modelId : config.fallback?.model || null;
  const passed = test?.result?.result === "passed";
  return (
    <div className="currow" data-testid={`current-${type}`}>
      <div className="cl">{label}</div>
      <div className="ci">{body}</div>
      <div className="ca">
        {editable && <Button size="small" disabled={!canPick || test?.testing} onClick={onPick} data-testid={`pick-${type}-button`}>{ref ? "更换" : "选择"}</Button>}
        {test && (
          <Button size="small" disabled={testable === null} loading={test.testing} onClick={() => test.onTest(testable!)} data-testid={`test-${type}-button`}>
            {test.testing ? "正在测试……" : "测试"}
          </Button>
        )}
      </div>
      {test?.result && (
        <div className={`tres ${passed ? "ok" : "bad"}`} data-testid={`test-${type}-result`}>
          <div className="th">{passed ? <CheckCircleFilled /> : <WarningFilled />}{testResultText(test.result)}</div>
          <div className="tq" data-testid={`test-${type}-question`}>{testQuestionText(test.result)}</div>
          <div className="tq" data-testid={`test-${type}-reply`}>{testReplyText(test.result)}</div>
        </div>
      )}
    </div>
  );
}
