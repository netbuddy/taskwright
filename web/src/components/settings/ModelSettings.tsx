// 设置页面的「模型」一栏：上半部分「现在用的模型」两行，下半部分「模型服务」（左边清单按用途分组，右边选中的那一个的详情）。
// 「添加模型服务」换成添加的画面；添加成功之后回到这里，右边打开新的那一个，并随即获取一次它的模型列表。
// editable 为假时整栏只读，顶上是后端给的那句说明。现在的后端 editable 恒为 true（从哪台电脑打开都能改），这条只读的路留着。
// 两行各有「测试」。语言模型：后端起一次助手，让模型读一个小文件并回答一句，结果连同问与答写在这一行下面。嵌入模型：后端把一句话送去换算，
// 结果写送去的那句话与算出来的数字串有多长。同一时间只测一种；更换了哪一种模型就清掉哪一种的结果，刷新页面两种都清掉。

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
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
  APPLIES_TEXT, EMBEDDING_LABEL, LANGUAGE_LABEL, PURPOSES, PURPOSE_ORDER, formatNumber, kindName, selected, testConfirmText, testConfirmTitle, testDimensionsText,
  testQuestionText, testReplyText, testResultText, testSentText,
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
  const [testing, setTesting] = useState<ModelType | null>(null);
  const [tested, setTested] = useState<Partial<Record<ModelType, ModelTestResult>>>({});
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

  /** 去掉某一种模型上一次测试的结果。 */
  const clearTested = (type: ModelType) => setTested((t) => { const next = { ...t }; delete next[type]; return next; });

  const runTest = async (type: ModelType) => {
    setTesting(type);
    clearTested(type);
    try {
      const result = await api.testModel(type);
      setTested((t) => ({ ...t, [type]: result }));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "测试没有做成。");
    } finally {
      setTesting(null);
    }
  };

  /** 测试之前先问一句：会发一次真实的请求。model 是要测的那个模型的名字（语言模型是现在实际会用的那一个）。 */
  const confirmTest = (type: ModelType, model: string) => {
    modal.confirm({
      title: testConfirmTitle(type), content: testConfirmText(type, model), okText: "开始测试", cancelText: "取消", onOk: () => { void runTest(type); },
    });
  };
  const testOf = (type: ModelType) => info?.capabilities.model_test
    ? { testing: testing === type, busy: testing !== null, result: tested[type] ?? null, onTest: (model: string) => confirmTest(type, model) }
    : undefined;

  const onPicked = async (_: ModelSelection, text: string) => {
    // 更换的是哪一种（只改了嵌入模型的查询前缀也算更换），就清掉哪一种的测试结果。
    if (picking) clearTested(picking);
    setPicking(null);
    setNote(text);
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
  // 在这里添加的模型服务按用途分组，每组里照后端给的先后；手工登记的另成一组，排在最后。
  const groups = PURPOSE_ORDER.map((purpose) => ({ purpose, providers: config.providers.filter((p) => p.managed && p.purpose === purpose) })).filter((g) => g.providers.length > 0);
  const external = config.providers.filter((p) => !p.managed);
  const current = config.providers.find((p) => p.id === chosen) ?? groups[0]?.providers[0] ?? external[0] ?? null;
  const candidates = (type: ModelType) => config.providers.some((p) => p.purpose === type && p.models.some((m) => m.enabled));

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
        助手靠语言模型工作；知识库按意思查找时要用嵌入模型。{editable && "两类模型各自添加模型服务：先在下面添加，再在上面选定用哪个模型。"}
      </p>

      <div className="section-title first">现在用的模型</div>
      <div className="card cur">
        <CurrentRow label={LANGUAGE_LABEL} type="language" config={config} editable={editable} canPick={candidates("language")} onPick={() => setPicking("language")}
          test={testOf("language")} />
        <CurrentRow label={EMBEDDING_LABEL} type="embedding" config={config} editable={editable} canPick={candidates("embedding")} onPick={() => setPicking("embedding")}
          test={testOf("embedding")} />
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
            {groups.map((g) => (
              <Fragment key={g.purpose}>
                <div className="cap" data-testid={`group-${g.purpose}`}>{PURPOSES[g.purpose].name}</div>
                {g.providers.map((p) => <ProviderItem key={p.id} provider={p} on={p.id === current?.id} onClick={() => choose(p.id)} />)}
              </Fragment>
            ))}
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
 * 「现在用的模型」的一行。右边「更换」或者「选择」；给了 test 时再右边是「测试」。语言模型测的是现在实际会用的那个模型：选定的，
 * 没有选定时是后端说的那一个；嵌入模型测的是选定的那一个。没有模型可测时按钮是灰的。test.testing 是这一行正在测，test.busy 是
 * 两行里有一行正在测：这时两行的「测试」都不能再点，也都不能更换。结果写在这一行下面。
 */
function CurrentRow({ label, type, config, editable, canPick, onPick, test }: {
  label: string; type: ModelType; config: ModelConfig; editable: boolean; canPick: boolean; onPick: () => void;
  test?: { testing: boolean; busy: boolean; result: ModelTestResult | null; onTest: (model: string) => void };
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
    body = <div>还没有选。助手查知识库只按字面找，用词不同的找不到。</div>;
  }
  const testable = ref ? ref.modelId : type === "language" ? config.fallback?.model || null : null;
  const passed = test?.result?.result === "passed";
  return (
    <div className="currow" data-testid={`current-${type}`}>
      <div className="cl">{label}</div>
      <div className="ci">{body}</div>
      <div className="ca">
        {editable && <Button size="small" disabled={!canPick || test?.busy} onClick={onPick} data-testid={`pick-${type}-button`}>{ref ? "更换" : "选择"}</Button>}
        {test && (
          <Button size="small" disabled={testable === null || (test.busy && !test.testing)} loading={test.testing} onClick={() => test.onTest(testable!)} data-testid={`test-${type}-button`}>
            {test.testing ? "正在测试……" : "测试"}
          </Button>
        )}
      </div>
      {test?.result && (
        <div className={`tres ${passed ? "ok" : "bad"}`} data-testid={`test-${type}-result`}>
          <div className="th">{passed ? <CheckCircleFilled /> : <WarningFilled />}{testResultText(test.result)}</div>
          {type === "language" ? (
            <>
              <div className="tq" data-testid="test-language-question">{testQuestionText(test.result)}</div>
              <div className="tq" data-testid="test-language-reply">{testReplyText(test.result)}</div>
            </>
          ) : passed && (
            <>
              <div className="tq sent" data-testid="test-embedding-question">{testSentText(test.result)}</div>
              <div className="tq" data-testid="test-embedding-dimensions">{testDimensionsText(test.result)}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
