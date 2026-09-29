import React, { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  Alert,
  Badge,
  Breadcrumb,
  Button,
  Card,
  Collapse,
  ConfigProvider,
  Descriptions,
  Empty,
  Layout,
  Menu,
  Progress,
  Segmented,
  Select,
  Space,
  Statistic,
  Spin,
  Tag,
  Timeline,
  Tooltip,
  Table,
  Input,
  Checkbox,
  Image,
  theme,
} from 'antd';
import { AimOutlined, ApartmentOutlined, LeftOutlined } from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';

const nonce = document.querySelector('meta[name="csp-nonce"]')?.content;
const roots = new Map();
const latestControlState = new Map();
const controlListeners = new Map();
const { Header, Sider, Content } = Layout;

function useDarkMode() {
  const [media] = useState(() => window.matchMedia('(prefers-color-scheme: dark)'));
  const [dark, setDark] = useState(media.matches);
  useEffect(() => {
    const update = (event) => setDark(event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [media]);
  return dark;
}

function AntdShell({ children }) {
  const dark = useDarkMode();
  return (
    <ConfigProvider
      locale={zhCN}
      componentSize="small"
      csp={nonce ? { nonce } : undefined}
      theme={{
        algorithm: [dark ? theme.darkAlgorithm : theme.defaultAlgorithm, theme.compactAlgorithm],
        token: { colorPrimary: '#1677ff', borderRadius: 8, controlHeight: 32, fontSize: 12 },
        components: { Select: { optionHeight: 38, optionFontSize: 13 } },
      }}
    >
      {children}
    </ConfigProvider>
  );
}

function emit(name, detail = {}) {
  window.dispatchEvent(new CustomEvent(`spec-loop:${name}`, { detail }));
}

function useControlState(name, initial) {
  const [value, setValue] = useState(() => ({ ...initial, ...latestControlState.get(name) }));
  useEffect(() => {
    if (!controlListeners.has(name)) controlListeners.set(name, new Set());
    const listeners = controlListeners.get(name);
    const update = (detail) => setValue((current) => ({ ...current, ...detail }));
    listeners.add(update);
    update(latestControlState.get(name) ?? {});
    return () => listeners.delete(update);
  }, [name]);
  return value;
}

function updateControlState(name, detail) {
  latestControlState.set(name, { ...latestControlState.get(name), ...detail });
  for (const listener of controlListeners.get(name) ?? []) listener(detail);
}

function WorkflowControls() {
  const state = useControlState('workflow-controls', {
    options: [],
    value: undefined,
    backVisible: false,
    backLabel: '返回上一级',
    source: '从 .spec-loop 重建',
  });
  return (
    <Space size={8} wrap className="antd-workflow-controls">
      <span className="control-label">波次</span>
      <Select
        className="wave-select-control"
        aria-label="选择波次"
        value={state.value}
        options={state.options}
        placeholder="选择波次"
        onChange={(value) => emit('wave-change', { value })}
        popupMatchSelectWidth={false}
      />
      {state.backVisible && (
        <Button icon={<LeftOutlined />} onClick={() => emit('workflow-back')}>
          {state.backLabel}
        </Button>
      )}
      <Tag bordered icon={<ApartmentOutlined />}>{state.source}</Tag>
    </Space>
  );
}

function ProjectControls() {
  const state = useControlState('project-controls', { options: [], value: undefined, loading: true });
  return (
    <Space size={7} className="antd-project-controls">
      <span className="project-control-label">工程</span>
      <Select
        className="project-select-control"
        aria-label="切换工程"
        size="middle"
        value={state.value}
        options={state.options}
        loading={state.loading}
        placeholder="选择工程"
        showSearch
        optionFilterProp="label"
        onChange={(value) => emit('project-change', { value })}
        popupMatchSelectWidth={240}
      />
    </Space>
  );
}

const statusColors = { delivered: 'success', working: 'processing', verifying: 'purple', iterating: 'warning', blocked: 'error', planned: 'default', draft: 'default' };

function GlobalOverview() {
  const state = useControlState('global-overview-control', {
    projectName: '正在读取工程', taskTotal: 0, waveTotal: 0, delivered: 0, inFlight: 0,
    status: { kind: 'processing', label: '正在连接' }, location: '正在定位', summary: '正在读取执行事实', elapsed: '—', nextAction: '等待状态加载', statuses: [], waves: { done: 0, active: 0, waiting: 0, pending: 0 },
  });
  const deliveredPct = state.taskTotal ? Math.round(state.delivered / state.taskTotal * 100) : 0;
  return (
    <Card
      className="antd-global-overview"
      title={<div><span className="antd-kicker">AIRFLOW OVERVIEW</span><strong>{state.projectName}</strong><Space size={4} wrap><Tag color="success">已交付 {state.delivered}</Tag><Tag color="processing">执行/验证 {state.inFlight}</Tag></Space></div>}
      extra={<Badge status={state.status.kind === 'success' ? 'success' : state.status.kind === 'waiting' ? 'warning' : 'processing'} text={state.status.label} />}
    >
      <div className="antd-global-grid">
        <Card size="small" type="inner" title="当前执行位置" className="antd-current-card">
          <strong>{state.location}</strong><p>{state.summary}</p><div><Tag color="blue">已运行 {state.elapsed}</Tag><span>{state.nextAction}</span></div>
        </Card>
        <Card size="small" type="inner" title="Task 状态" extra={`${state.taskTotal} 总计`}>
          <Progress percent={deliveredPct} size="small" strokeColor="#52c41a" format={() => `交付 ${deliveredPct}%`} />
          <Space size={[4, 5]} wrap className="antd-status-tags">{state.statuses.map((item) => <Tag key={item.key} color={statusColors[item.key]}>{item.label} {item.count}</Tag>)}</Space>
        </Card>
        <Card size="small" type="inner" title="波次进度">
          <Statistic value={state.waves.done} suffix={`/ ${state.waveTotal}`} />
          <p>进行中 {state.waves.active} · 等待 {state.waves.waiting} · 待开始 {state.waves.pending}</p>
        </Card>
      </div>
    </Card>
  );
}

function WaveMenu() {
  const state = useControlState('wave-list', { items: [], selectedKey: undefined });
  useEffect(() => {
    if (!state.selectedKey) return;
    requestAnimationFrame(() => document.querySelector('#wave-list .ant-menu-item-selected')?.scrollIntoView({ block: 'nearest' }));
  }, [state.selectedKey]);
  const items = state.items.map((item) => ({
    key: item.key,
    label: <div className="antd-wave-item"><div><strong>{item.key}</strong><span title={item.title}>{item.title}</span>{item.current && <Badge status="processing" />}</div><div><Tag color={item.stateColor}>{item.stateLabel}</Tag><span>Task {item.completed}/{item.total}</span><span>{item.time}</span></div><Progress percent={item.percent} showInfo={false} size="small" /></div>,
  }));
  return <Menu theme="dark" mode="inline" selectedKeys={state.selectedKey ? [state.selectedKey] : []} items={items} onClick={({ key }) => emit('wave-change', { value: key })} />;
}

function LiveMetricCard({ metric }) {
  const previous = useRef(metric.value);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (previous.current === metric.value) return;
    previous.current = metric.value;
    setChanged(true);
    const timer = window.setTimeout(() => setChanged(false), 420);
    return () => window.clearTimeout(timer);
  }, [metric.value]);
  return (
    <Card size="small" className={`antd-wave-metric${changed ? ' value-changed' : ''}`}>
      <Statistic title={metric.label} value={metric.value} valueStyle={{ color: metric.color }} />
      <p>{metric.note}</p>
    </Card>
  );
}

function WaveMetrics() {
  const state = useControlState('wave-metrics', { metrics: [] });
  return <>{state.metrics.map((metric) => <LiveMetricCard key={metric.key} metric={metric} />)}</>;
}

const stepStatusColors = { succeeded: 'green', running: 'blue', waiting: 'orange', failed: 'red', interrupted: 'red' };

function TaskInspector() {
  const state = useControlState('task-inspector', { task: null });
  const task = state.task;
  if (!task) {
    return (
      <Card className="antd-inspector" title={<div><span className="antd-kicker">TASK INSPECTOR</span><strong>步骤活动</strong></div>}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择一个 Task 查看明细" />
      </Card>
    );
  }
  const timelineItems = task.steps.map((step) => ({
    color: stepStatusColors[step.status] ?? 'gray',
    children: (
      <div className={`antd-step-item${step.bottleneck ? ' bottleneck' : ''}`}>
        <div className="antd-step-heading"><strong>{step.label}</strong><Statistic value={step.duration} /></div>
        <p>{step.summary}</p>
        <Space size={[4, 5]} wrap>
          {step.bottleneck && <Tag color="warning">耗时最长</Tag>}
          <Tag>{step.timeRange}</Tag><Tag>{step.precision}</Tag><Tag color={stepStatusColors[step.status]}>{step.statusLabel}</Tag><Tag>{step.source}</Tag>
        </Space>
        {step.refs.length > 0 && <Collapse ghost size="small" items={[{ key: 'evidence', label: `证据与产物 ${step.refs.length}`, children: <Space size={[4, 5]} wrap>{step.refs.map((ref) => <Tag key={ref}>↗ {ref}</Tag>)}</Space> }]} />}
      </div>
    ),
  }));
  return (
    <Card
      className="antd-inspector"
      title={<div><span className="antd-kicker">TASK INSPECTOR</span><strong>{task.title}</strong></div>}
      extra={<Tag color={statusColors[task.status]}>{task.statusLabel}</Tag>}
    >
      <Descriptions size="small" layout="vertical" column={1} items={task.metrics} />
      {timelineItems.length ? <Timeline className="antd-step-timeline" items={timelineItems} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无步骤事件" />}
      {task.diagnostics.length > 0 && <Alert showIcon type="warning" message="Task 数据提示" description={<ul>{task.diagnostics.map((item) => <li key={item}>{item}</li>)}</ul>} />}
    </Card>
  );
}

function TaskControls() {
  const state = useControlState('task-controls', {
    waveOptions: [],
    waveValue: 'all',
    sortValue: 'default',
    filterValue: 'all',
    locateDisabled: true,
  });
  const filterOptions = [
    { label: '进行中', value: 'active' },
    { label: '失败/等待', value: 'problems' },
    { label: '耗时异常', value: 'slow' },
    { label: '已交付', value: 'delivered' },
    { label: '全部', value: 'all' },
  ];
  return (
    <Space size={8} wrap className="antd-task-controls">
      <Tooltip title={state.locateDisabled ? '当前没有正在执行的 Task' : '定位当前 Task 及所属波次'}>
        <Button
          type="primary"
          ghost
          icon={<AimOutlined />}
          disabled={state.locateDisabled}
          onClick={() => emit('locate-current')}
        >
          定位当前
        </Button>
      </Tooltip>
      <Select
        className="task-wave-select-control"
        aria-label="按波次筛选任务"
        value={state.waveValue}
        options={state.waveOptions}
        onChange={(value) => emit('task-wave-change', { value })}
        popupMatchSelectWidth={false}
      />
      <Select
        className="task-sort-control"
        aria-label="任务排序"
        value={state.sortValue}
        options={[
          { value: 'default', label: '默认顺序' },
          { value: 'duration-desc', label: '按生命周期跨度排序' },
        ]}
        onChange={(value) => emit('task-sort-change', { value })}
      />
      <Segmented
        aria-label="筛选任务"
        value={state.filterValue}
        options={filterOptions}
        onChange={(value) => emit('task-filter-change', { value })}
      />
    </Space>
  );
}

function WaveReview() {
  const project = useControlState('project-controls', { value: 'root' }).value ?? 'root';
  const [items, setItems] = useState([]), [selected, setSelected] = useState(null), [record, setRecord] = useState(null);
  const [reload, setReload] = useState(0), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(null), [message, setMessage] = useState(null);
  const [actor, setActor] = useState(''), [note, setNote] = useState(''), [choices, setChoices] = useState({}), [next, setNext] = useState(false);
  const query = (extra = {}) => new URLSearchParams({ project, ...extra }).toString();
  const readResponse = async (response) => { const value = await response.json(); if (!response.ok) throw new Error(value.error ?? '请求失败'); return value; };
  useEffect(() => {
    const abort = new AbortController(); setItems([]); setRecord(null); setSelected(null); setError(null); setMessage(null); setLoading(true);
    fetch(`/api/wave-reviews?${query()}`, { signal: abort.signal }).then(readResponse).then((values) => {
      setItems(values); setSelected(values.find(item => ['awaiting_wave_review', 'applying'].includes(item.status))?.wave_id ?? values.find(item => item.status === 'reviewed')?.wave_id ?? null);
    }).catch(err => { if (!abort.signal.aborted) setError(err.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [project, reload]);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController(); setRecord(null); setChoices({}); setNext(false); setLoading(true);
    fetch(`/api/wave-review?${query({ wave: selected })}`, { signal: abort.signal }).then(readResponse).then(value => { setRecord(value); if(value.decision){ setActor(value.decision.actor);setNote(value.decision.note);setNext(value.decision.authorize_next);setChoices(Object.fromEntries(value.decision.choices.map(choice => [choice.task_id, {...choice, visual_accepted: choice.visual.some(item => item.result === 'approved')}]))); } })
      .catch(err => { if (!abort.signal.aborted) setError(err.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [project, selected, reload]);
  const change = (id, value) => setChoices(current => ({ ...current, [id]: { ...current[id], ...value } }));
  const mutation = async (route, body) => readResponse(await fetch(`/api/wave-review/${route}?${query()}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Spec-Loop-Review-Token': document.querySelector('meta[name="review-token"]')?.content ?? '' }, body: JSON.stringify(body),
  }));
  const refresh = async () => {
    setBusy(true); setError(null);
    try { const value = await mutation('refresh', { wave_id: selected }); const values = await readResponse(await fetch(`/api/wave-reviews?${query()}`)); setItems(values); setSelected(value.bundle.wave_id); }
    catch(err) { setError(err.message); } finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const selectedChoices = record.bundle.tasks.map(item => {
        const choice = choices[item.task_id] ?? { action: 'defer' };
        return { task_id: item.task_id, action: choice.action ?? 'defer', reauthorize_budget: Boolean(choice.reauthorize_budget), heavy_accepted: Boolean(choice.heavy_accepted),
          visual: choice.visual_accepted ? item.facts.visual.filter(review => review.status === 'pending').map(review => ({ review_id: review.review_id, request_hash: review.request_hash, result: 'approved' })) : [] };
      });
      const boundDecision = record.decision ? Object.fromEntries(['bundle_hash', 'request_id', 'actor', 'note', 'choices', 'authorize_next', 'next_plan_hash'].filter(key => record.decision[key] !== undefined).map(key => [key, record.decision[key]])) : {
        bundle_hash: record.bundle.bundle_hash, request_id: record.decision?.request_id ?? crypto.randomUUID(), actor, note, choices: selectedChoices,
        authorize_next: next && hasReturned, ...(next && hasReturned ? { next_plan_hash: record.bundle.next_plan.plan_hash } : {}),
      };
      const value = await mutation('decision', { wave_id: selected, start_next: boundDecision.authorize_next, decision: boundDecision });
      setRecord(value.review); setItems(current => current.map(item => item.wave_id === selected ? { ...item, status: value.review.status } : item)); setMessage(value.next ? '统一决定已记录，下一波已启动。' : '统一决定已记录；候选尚未合并或发布。');
    } catch(err) { setError(err.message); } finally { setBusy(false); }
  };
  const expired = record && record.status !== 'applying' && Date.parse(record.bundle.expires_at) <= Date.now();
  const tasks = record?.bundle.tasks ?? [], locked = record?.status === 'applying', editable = record?.status !== 'reviewed';
  const hasReturned = tasks.some(item => ['return_to_m', 'continue'].includes(choices[item.task_id]?.action));
  const recordedDecision = id => record?.status === 'reviewed' ? ({ accept: '已接受候选', return_to_m: '已退回修复', continue: '已批准继续', defer: '已暂缓' })[record.decision?.choices.find(choice => choice.task_id === id)?.action] : null;
  const columns = [
    { title: '任务与候选', key: 'task', width: 210, render: (_, item) => <Space direction="vertical" size={2}><strong>{item.task_id}</strong><span>{item.facts?.title ?? '事实尚未就绪'}</span><code>{item.facts?.head?.slice(0, 12) ?? '尚无稳定提交'}</code></Space> },
    { title: '验证与待决事项', key: 'status', width: 210, render: (_, item) => <Space direction="vertical" size={2}>
      <Tag color={recordedDecision(item.task_id) ? 'blue' : item.outcome === 'candidate' ? 'green' : item.outcome === 'invalid' ? 'red' : 'orange'}>{recordedDecision(item.task_id) ?? ({ candidate: 'V/R 已通过，待统一验收', needs_user: '需要最终决定', invalid: '事实失配，需重新绑定', unfinished: '尚未完成' })[item.outcome]}</Tag>
      <span>{item.facts?.records.map(result => `${result.role}: ${result.verdict === 'pass' ? '通过' : '未通过'}`).join(' · ') || '暂无完整 V/R 结论'}</span>
      {item.failures.length > 0 && <span>本波失败 / 修复记录：{item.failures.length}</span>}
    </Space> },
    { title: '耗时与费用', key: 'usage', width: 140, render: (_, item) => <Space direction="vertical" size={2}><span>{item.elapsed_ms == null ? '耗时未记录' : `${(item.elapsed_ms / 1000).toFixed(1)} 秒`}</span><span>{item.usage.tokens.toLocaleString()} Token</span><span>{item.usage.recorded ? `$${item.usage.cost_usd.toFixed(4)}` : '费用未核实'}</span></Space> },
    { title: '最终决定', key: 'decision', width: 240, render: (_, item) => {
      const choice = choices[item.task_id] ?? { action: 'defer' };
      return <Space direction="vertical" size={6}><Select aria-label={`${item.task_id} 最终决定`} style={{ width: 220 }} value={choice.action ?? 'defer'} disabled={!editable || locked || busy} onChange={action => change(item.task_id, { action, reauthorize_budget: false, heavy_accepted: false, visual_accepted: false })} options={[
        { value: 'defer', label: '暂缓确认' }, { value: 'accept', label: '接受候选（暂不合并）', disabled: item.outcome !== 'candidate' }, { value: 'continue', label: '按原范围继续 / 复验', disabled: !item.facts || !['m_working', 'm_submitted', 'plan_compiled', 'v_passed'].includes(item.facts.stage) }, { value: 'return_to_m', label: '退回修复', disabled: !item.facts || !['candidate', 'waiting_human_review', 'plan_compiled', 'v_passed', 'm_working'].includes(item.facts.stage) },
      ]} />
        {choice.action === 'return_to_m' && <Checkbox checked={choice.reauthorize_budget} disabled={!editable || locked || busy} onChange={e => change(item.task_id, { reauthorize_budget: e.target.checked })}>重新批准原返工预算</Checkbox>}
        {choice.action === 'accept' && item.facts.risk === 'heavy' && <Checkbox checked={choice.heavy_accepted} disabled={!editable || locked || busy} onChange={e => change(item.task_id, { heavy_accepted: e.target.checked })}>我已完成本任务 Heavy 人工验收</Checkbox>}
        {choice.action === 'accept' && item.facts.visual.some(review => review.status === 'pending') && <Checkbox checked={choice.visual_accepted} disabled={!editable || locked || busy} onChange={e => change(item.task_id, { visual_accepted: e.target.checked })}>我已查看截图并接受视觉效果</Checkbox>}
      </Space>;
    } },
  ];
  return <Card title="波次末统一验收" className="wave-review-panel" extra={<Button disabled={busy} onClick={() => setReload(value => value + 1)}>刷新列表</Button>}>
    <p>范围内的实现、修复和 V/R 连续推进；最终在这里一起审阅候选与待决事项。</p>
    {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
    {message && <Alert type="success" showIcon message={message} style={{ marginBottom: 12 }} />}
    {loading && <Spin />}
    {items.some(item => item.status === 'invalid') && <Alert type="warning" showIcon message="部分验收记录损坏，已单独标记；其余波次可继续验收。" />}
    {items.length > 0 && <Space wrap style={{ marginBottom: 12 }}><Select aria-label="选择待验收执行波次" style={{ width: 330 }} value={selected} onChange={setSelected} options={items.map(item => ({ value: item.wave_id, disabled: item.status === 'invalid', label: `${item.status === 'invalid' ? '记录损坏' : new Date(item.created_at).toLocaleString()} · ${item.task_total} 项 · ${item.status === 'invalid' ? item.wave_id : item.status === 'reviewed' ? '已记录决定' : '待验收'}` }))} /><Button disabled={busy || !record || record.status === 'applying'} onClick={refresh}>重新绑定当前候选</Button></Space>}
    {!loading && !items.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有执行结束的待验收波次" />}
    {record && <>
      {expired && <Alert type="warning" message="清单已过期，请重新绑定当前候选后再提交。" />}
      {record.bundle.execution_mode === 'batch_two_rounds' && <Alert type={record.bundle.execution_status === 'completed' ? 'info' : 'warning'} showIcon style={{ marginBottom: 12 }} message={`整波验证 ${record.bundle.verification_round ?? 0}/${record.bundle.max_verification_rounds ?? 2} 轮 · ${record.bundle.execution_status === 'completed' ? '已通过' : '仍有待处理'}`} description={record.bundle.block_reason ?? '请查看任务行中的候选、待确认事项和证据。'} />}
      <p>本波 {tasks.length} 项 · 原执行结果：{({ completed: '已结束', completed_with_failures: '已结束，包含失败记录', usage_unknown: '费用或用量未核实', budget_stopped: '已达预算上限', stop_incomplete: '停止尚未核实' })[record.bundle.execution_status] ?? record.bundle.execution_status} · 清单有效至 {new Date(record.bundle.expires_at).toLocaleString()}</p>
      <Table rowKey="task_id" dataSource={tasks} columns={columns} pagination={false} scroll={{ x: 800 }} expandable={{ expandedRowRender: item => <Space direction="vertical" style={{ width: '100%' }}>
        {item.diagnostics.map((text, index) => <Alert key={index} type="warning" message={text} />)}
        <strong>验收标准与证据</strong>
        {item.facts?.criteria.map(criterion => <div key={criterion.id}>{criterion.id}：{criterion.text}</div>)}
        {item.facts?.records.map(result => <div key={result.role}>{result.role} 证据：{result.evidence.map(evidence => evidence.file).join('、')}</div>)}
        {item.failures.map((text, index) => <div key={index}>失败 / 修复：{text}</div>)}
        {item.facts?.visual.flatMap(review => review.artifacts.map(artifact => <figure key={artifact.sha256}><Image width={260} src={`/api/review-artifact?${query({ wave: selected, task: item.task_id, hash: artifact.sha256 })}`} alt={`${item.task_id} ${review.review_id} 验收截图`} /><figcaption>{review.review_id} · {review.status === 'approved' ? '已接受视觉效果' : '待视觉审阅'}</figcaption></figure>))}
      </Space> }} />
      {editable && <Space direction="vertical" style={{ width: '100%', marginTop: 16 }}>
        <Space wrap><Input aria-label="验收人" placeholder="验收人" value={actor} onChange={e => setActor(e.target.value)} disabled={locked || busy} style={{ width: 180 }} /><Input aria-label="统一验收说明" placeholder="统一验收说明（至少 3 个字）" value={note} onChange={e => setNote(e.target.value)} disabled={locked || busy} style={{ width: 400, maxWidth: '100%' }} /></Space>
        {hasReturned && <p>下一波仅执行：{tasks.filter(item => ['return_to_m', 'continue'].includes(choices[item.task_id]?.action)).map(item => item.task_id).join('、')}。上限：{record.bundle.next_plan.budget.max_parallel} 路并发、{record.bundle.next_plan.budget.max_elapsed_seconds} 秒、{record.bundle.next_plan.budget.max_tokens.toLocaleString()} Token、${record.bundle.next_plan.budget.max_cost_usd}。</p>}
        {hasReturned && record.bundle.next_plan.gate_plan && <Collapse style={{ width: '100%' }} items={[{ key: 'next-gates', label: '下一波自动验证计划', children: <Space direction="vertical"><span>覆盖范围：{record.bundle.next_plan.gate_plan.coverage === 'targeted' ? '任务定向验证' : '全量验证'}</span>{record.bundle.next_plan.gate_plan.gates.map(gate => <div key={gate.id}><strong>{gate.id}</strong> · {gate.timeout_seconds} 秒 · <code>{gate.command?.join(' ') ?? `Playwright ${(gate.tests ?? []).join(' ')}`}</code></div>)}</Space> }]} />}
        <Checkbox checked={next && hasReturned} disabled={locked || !hasReturned || busy} onChange={e => setNext(e.target.checked)}>批准待执行任务的下一波计划并恢复调度（沿用当前范围和预算）</Checkbox>
        <Button type="primary" disabled={busy || expired || actor.trim().length < 2 || note.trim().length < 3} loading={busy} onClick={submit}>{next && hasReturned ? '提交统一验收并继续下一波' : '提交统一验收'}</Button>
      </Space>}
      {!editable && <Space direction="vertical" style={{ marginTop: 12 }}><Alert type="info" message={`决定已由 ${record.decision.actor} 记录。未接受项仍保留现场；合并和发布需另行明确决定。`} />{record.decision.authorize_next && <Button disabled={busy} loading={busy} onClick={submit}>启动已批准的下一波</Button>}</Space>}
    </>}
  </Card>;
}

function ExecutionLayout() {
  const state = useControlState('execution-layout', { switching: false, error: null });
  return (
    <AntdShell>
      <Layout className="execution-layout">
        <Header className="app-bar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
            <div><strong id="project-name">Spec-Loop</strong><span className="crumb">Execution Console</span></div>
          </div>
          <div className="app-actions">
            <div id="project-controls" className="project-switcher" aria-label="切换工程"><ProjectControls /></div>
            <div className="connection-status" aria-live="polite">
              <span className="live-beacon" aria-hidden="true" />
              <div><strong id="connection-label">正在连接</strong><span id="freshness-text">等待第一次数据同步</span></div>
            </div>
          </div>
        </Header>

        <div id="runtime-error" className="runtime-error" role="status" aria-live="polite" hidden={!state.error}>
          <strong>本次刷新失败，已保留上一帧</strong><span id="runtime-error-message">{state.error}</span>
        </div>

        <Layout hasSider className="execution-shell">
          <Sider width={272} className="wave-sidebar" aria-labelledby="wave-sidebar-title">
            <div className="wave-sidebar-heading">
              <div><span className="section-kicker">PROJECT WAVES</span><h2 id="wave-sidebar-title">完整波次明细</h2></div>
              <span id="wave-sidebar-count">正在重建</span>
            </div>
            <p id="wave-sidebar-summary">按 H 顺序读取状态、Task 完成度与耗时</p>
            <div id="wave-list" className="wave-sidebar-list" aria-label="H 波次顺序列表"><WaveMenu /></div>
          </Sider>

          <Content className="execution-content">
            <section id="global-overview-control" aria-label="AIRFLOW OVERVIEW 全局执行总览"><GlobalOverview /></section>
            <section aria-label="波次统一验收"><WaveReview /></section>

            <section className="workflow-wrap" aria-labelledby="workflow-heading">
              <div className="subsection-heading">
                <div><span className="section-kicker">SELECTED WAVE</span><h2 id="workflow-heading">正在定位当前波次</h2><p id="workflow-caption" className="workflow-caption">默认展示当前波次，可从左侧切换查看</p></div>
                <div id="workflow-controls" className="workflow-actions" aria-label="波次执行操作"><WorkflowControls /></div>
              </div>
              <section id="current-metrics" className="metric-grid antd-wave-metrics" aria-label="当前波次或任务耗时"><WaveMetrics /></section>
              <div id="workflow" className="workflow" aria-label="当前波次 Task 执行图" />
            </section>

            <div className="content-grid">
              <section className="panel timeline-panel" aria-labelledby="timeline-heading">
                <div className="panel-heading">
                  <div><span className="section-kicker">WAVE TASKS</span><h2 id="timeline-heading">波次子 Task</h2><p id="task-summary">从项目事实重建</p></div>
                  <div id="task-controls" className="task-toolbar" aria-label="任务筛选与排序"><TaskControls /></div>
                </div>
                <div className="task-table-head" aria-hidden="true"><span>任务</span><span>生命周期构成 <small>Task 之间可重叠，不能相加为工时</small></span><span>生命周期跨度</span></div>
                <div className="duration-legend" aria-label="耗时构成图例"><span><i className="active" />已记录主动执行</span><span><i className="waiting" />已记录等待</span><span><i className="untracked" />未归因 / 空闲</span></div>
                <div id="task-list" className="task-list" />
              </section>

              <aside id="task-inspector-control" className="detail-panel" aria-label="Task 步骤检查器"><TaskInspector /></aside>
            </div>

            <section id="project-diagnostics" className="project-diagnostics" hidden aria-label="数据完整性提示" />
          </Content>
        </Layout>

        {state.switching && <div className="project-switch-mask" role="status" aria-live="polite"><Spin size="large" tip="正在切换工程"><div className="project-switch-spin-space" /></Spin></div>}
      </Layout>
    </AntdShell>
  );
}

function renderInto(host, node) {
  let mounted = roots.get(host);
  if (!mounted) {
    mounted = createRoot(host);
    roots.set(host, mounted);
  }
  mounted.render(<AntdShell>{node}</AntdShell>);
}

window.ExecutionAntd = {
  updateLayout(detail) {
    updateControlState('execution-layout', detail);
  },
  updateWaveMetrics(detail) {
    updateControlState('wave-metrics', detail);
  },
  updateTaskInspector(detail) {
    updateControlState('task-inspector', detail);
  },
  updateGlobalOverview(detail) {
    updateControlState('global-overview-control', detail);
  },
  updateWaveMenu(detail) {
    updateControlState('wave-list', detail);
  },
  updateProject(detail) {
    updateControlState('project-controls', detail);
  },
  updateWorkflow(detail) {
    updateControlState('workflow-controls', detail);
  },
  updateTasks(detail) {
    updateControlState('task-controls', detail);
  },
  mountButton(host, props, onClick) {
    const { label, ...buttonProps } = props;
    renderInto(host, <Button {...buttonProps} onClick={onClick}>{label}</Button>);
  },
  mountBreadcrumb(host, items) {
    renderInto(host, <Breadcrumb items={items.map((item) => ({
      title: item.current
        ? <strong>{item.label}</strong>
        : <Button type="link" size="small" disabled={item.disabled} onClick={item.onClick}>{item.label}</Button>,
    }))} />);
  },
  mountEmpty(host, { description, detail, actionLabel }, onAction) {
    renderInto(host, (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description}>
        {detail && <p className="antd-empty-detail">{detail}</p>}
        {actionLabel && <Button type="primary" onClick={onAction}>{actionLabel}</Button>}
      </Empty>
    ));
  },
  mountAlert(host, { message, descriptions, type = 'warning', collapsible = false }) {
    const description = Array.isArray(descriptions)
      ? collapsible && descriptions.length > 3
        ? <><ul>{descriptions.slice(0, 3).map((item, index) => <li key={index}>{item}</li>)}</ul>
          <Collapse ghost size="small" items={[{ key: 'remaining', label: `查看其余 ${descriptions.length - 3} 条`, children: <ul>{descriptions.slice(3).map((item, index) => <li key={index}>{item}</li>)}</ul> }]} /></>
        : <ul>{descriptions.map((item, index) => <li key={index}>{item}</li>)}</ul>
      : descriptions;
    renderInto(host, <Alert showIcon type={type} message={message} description={description} />);
  },
  mountTags(host, labels) {
    renderInto(host, <Space size={4} wrap>{labels.map((label) => <Tag key={label}>{label}</Tag>)}</Space>);
  },
  mountStatus(host, kind, label) {
    const status = kind === 'success' ? 'success' : kind === 'waiting' ? 'warning' : 'processing';
    renderInto(host, <Tag><Badge status={status} text={label} /></Tag>);
  },
};

// Render the page shell synchronously so app.js can bind its projection nodes
// immediately after this deferred bundle finishes.
const executionViewHost = document.getElementById('execution-view');
if (executionViewHost) {
  const executionViewRoot = createRoot(executionViewHost);
  roots.set(executionViewHost, executionViewRoot);
  flushSync(() => executionViewRoot.render(<ExecutionLayout />));
}

new MutationObserver(() => {
  queueMicrotask(() => {
    for (const [host, mounted] of roots) {
      if (host.isConnected) continue;
      mounted.unmount();
      roots.delete(host);
    }
  });
}).observe(document.documentElement, { childList: true, subtree: true });

window.dispatchEvent(new Event('spec-loop:antd-ready'));
