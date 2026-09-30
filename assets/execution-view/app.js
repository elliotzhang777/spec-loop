const root = document.getElementById('execution-view');
const elements = {
  projectName: document.getElementById('project-name'), connectionLabel: document.getElementById('connection-label'),
  freshness: document.getElementById('freshness-text'),
  workflow: document.getElementById('workflow'),
  taskList: document.getElementById('task-list'),
  taskSummary: document.getElementById('task-summary'), projectDiagnostics: document.getElementById('project-diagnostics'),
  workflowHeading: document.getElementById('workflow-heading'),
  workflowCaption: document.getElementById('workflow-caption'), waveList: document.getElementById('wave-list'),
  waveSidebarCount: document.getElementById('wave-sidebar-count'), waveSidebarSummary: document.getElementById('wave-sidebar-summary'),
};

const workflowStages = [
  { key: 'intake', label: 'P 契约', hint: '冻结边界、AC 与权限', actor: 'agent', role: 'PLANNER · P', types: ['task.plan', 'acceptance.plan'], x: 480, y: 20 },
  { key: 'prepare', label: '准备执行', hint: '权限 / worktree / Plan', actor: 'system', role: 'SPEC-LOOP', types: ['harness.prepare'], x: 480, y: 120 },
  { key: 'maker', label: 'M 实现', hint: '唯一候选写角色', actor: 'agent', role: 'MAKER · M', types: ['round.work', 'work.reproduce', 'work.analyze', 'work.change', 'harness.execute', 'role.m'], x: 480, y: 220 },
  { key: 'collect', label: '收集候选', hint: 'HEAD / diff / artifacts', actor: 'system', role: 'SPEC-LOOP', types: ['harness.collect', 'harness.report'], x: 480, y: 320 },
  { key: 'command', label: '构建 / 测试 Gate', hint: '确定性命令', actor: 'system', role: 'SPEC-LOOP GATE', types: ['gate.command'], x: 180, y: 440 },
  { key: 'browser', label: '浏览器 Gate', hint: 'Playwright 路径', actor: 'system', role: 'SPEC-LOOP GATE', types: ['gate.playwright'], x: 780, y: 440 },
  { key: 'review', label: '人工效果确认', hint: '截图与主观验收', actor: 'human', role: 'HUMAN', types: ['review.visual', 'wait.user'], x: 780, y: 550 },
  { key: 'verify', label: 'V 验收', hint: '独立验证 AC / HEAD', actor: 'agent', role: 'VERIFIER · V', types: ['task.verify', 'role.v'], x: 480, y: 680 },
  { key: 'deliver', label: 'R 复核 / Candidate', hint: 'Evidence Guard 后进入候选', actor: 'agent', role: 'REVIEWER · R', types: ['role.r', 'acceptance.candidate', 'task.deliver'], x: 300, y: 810 },
  { key: 'triage', label: 'Triage 归因', hint: '区分失败类型', actor: 'agent', role: 'TRIAGE', types: [], x: 660, y: 810 },
  { key: 'revision', label: '新 Revision', hint: '生成下一张 DAG', actor: 'system', role: 'SPEC-LOOP', types: [], x: 660, y: 920 },
];

const workflowEdges = [
  { from: 'intake', to: 'prepare', path: 'M590 106 V120' },
  { from: 'prepare', to: 'maker', path: 'M590 206 V220' },
  { from: 'maker', to: 'collect', path: 'M590 306 V320' },
  { from: 'collect', to: 'command', path: 'M590 406 V422 H290 V440', label: '并行 Gate', lx: 350, ly: 415 },
  { from: 'collect', to: 'browser', path: 'M590 406 V422 H890 V440', label: '并行 Gate', lx: 765, ly: 415 },
  { from: 'command', to: 'verify', path: 'M290 526 V645 H590 V680', label: 'Evidence', lx: 360, ly: 638 },
  { from: 'browser', to: 'review', path: 'M890 526 V550' },
  { from: 'review', to: 'verify', path: 'M890 636 V655 H590 V680', label: 'Review', lx: 765, ly: 648 },
  { from: 'verify', to: 'deliver', path: 'M590 766 V788 H410 V810', label: 'PASS', lx: 455, ly: 785 },
  { from: 'verify', to: 'triage', path: 'M590 766 V788 H770 V810', failure: true, label: 'FAIL', lx: 700, ly: 785 },
  { from: 'command', to: 'triage', path: 'M400 483 H1050 V790 H880 V835', failure: true, label: 'Gate FAIL', lx: 955, ly: 780 },
  { from: 'browser', to: 'triage', path: 'M1000 483 H1050 V790 H880 V835', failure: true },
  { from: 'review', to: 'triage', path: 'M1000 593 H1030 V805 H880 V835', failure: true, label: '拒绝', lx: 985, ly: 800 },
  { from: 'triage', to: 'revision', path: 'M770 896 V920', failure: true },
];

const SVG_NS = 'http://www.w3.org/2000/svg';
const workflowNodeWidth = 220;
const workflowNodeHeight = 86;

let snapshot = null;
let selectedTaskId = null;
let etag = null;
let taskFilter = 'all';
let taskSort = 'default';
let taskWaveFilter = null;
let lastCheckedAt = 0;
let lastChangedAt = 0;
let lastPollChanged = false;
let workflowMode = 'portfolio';
let selectedWaveId = null;
let workflowSelectionInitialized = false;
let portfolioHasLocated = false;
let expandedTaskId = null;
let projectCatalog = [];
let selectedProjectKey = 'root';
const elkLayoutCache = new Map();
let elkInstance = null;
let workflowControlState = { options: [], value: '', backVisible: false, backLabel: '返回上一级', source: '从 .spec-loop 重建' };

function callAntd(method, args, fallback) {
  const operation = window.ExecutionAntd?.[method];
  if (typeof operation === 'function') {
    operation(...args);
    return true;
  }
  fallback?.();
  return false;
}

function updateWorkflowControls(patch = {}) {
  workflowControlState = { ...workflowControlState, ...patch };
  callAntd('updateWorkflow', [workflowControlState]);
}

function updateTaskControls() {
  callAntd('updateTasks', [{
    waveValue: taskWaveFilter ?? 'all',
    sortValue: taskSort,
    filterValue: taskFilter,
    locateDisabled: !snapshot?.active_task,
  }]);
}

function updateProjectControls(loading = false) {
  callAntd('updateProject', [{
    options: projectCatalog.map((project) => ({ value: project.key, label: project.name })),
    value: selectedProjectKey,
    loading,
  }]);
}

async function loadProjects() {
  updateProjectControls(true);
  try {
    const response = await fetch('/api/projects', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const catalog = await response.json();
    projectCatalog = Array.isArray(catalog.projects) ? catalog.projects : [];
    if (!projectCatalog.some((project) => project.key === selectedProjectKey)) selectedProjectKey = catalog.default_project || projectCatalog[0]?.key || 'root';
  } catch {
    if (!projectCatalog.length) projectCatalog = [{ key: 'root', project_id: 'LOCAL', name: '当前工程' }];
  }
  updateProjectControls(false);
}

function resetProjectSelection() {
  selectedTaskId = null; taskWaveFilter = null; selectedWaveId = null; expandedTaskId = null;
  workflowMode = 'portfolio'; workflowSelectionInitialized = false; portfolioHasLocated = false;
  elkLayoutCache.clear();
}

async function switchProject(projectKey) {
  if (!projectCatalog.some((project) => project.key === projectKey) || projectKey === selectedProjectKey) return;
  selectedProjectKey = projectKey; etag = null; snapshot = null; resetProjectSelection(); updateProjectControls(false);
  callAntd('updateLayout', [{ switching: true, error: null }]);
  root.classList.add('project-switching'); elements.connectionLabel.textContent = '正在切换工程'; elements.freshness.textContent = '保留上一帧直到新工程加载完成';
  await refresh();
}

function appendAntdEmpty(parent, description, detail = '', actionLabel = '', onAction) {
  const host = document.createElement('div');
  host.className = 'antd-empty-host';
  parent.append(host);
  callAntd('mountEmpty', [host, { description, detail, actionLabel }, onAction], () => {
    host.append(text('p', 'empty-description', description));
    if (detail) host.append(text('p', 'antd-empty-detail', detail));
    if (actionLabel) {
      const action = text('button', 'fallback-button', actionLabel);
      action.type = 'button'; action.addEventListener('click', onAction); host.append(action);
    }
  });
  return host;
}

function mountButton(host, props, onClick) {
  callAntd('mountButton', [host, props, onClick], () => {
    const button = text('button', 'fallback-button', props.label);
    button.type = 'button'; button.disabled = Boolean(props.disabled); button.addEventListener('click', onClick); host.append(button);
  });
}

function mountAlert(host, { message, descriptions, collapsible = false }) {
  callAntd('mountAlert', [host, { message, descriptions, collapsible }], () => {
    const detail = document.createElement('div'); detail.className = 'fallback-alert'; detail.append(text('strong', '', message));
    const items = Array.isArray(descriptions) ? descriptions : descriptions ? [descriptions] : [];
    if (items.length) {
      const list = document.createElement('ul');
      for (const item of collapsible ? items.slice(0, 3) : items) list.append(text('li', '', item));
      detail.append(list);
      if (collapsible && items.length > 3) {
        const more = document.createElement('details');
        more.append(text('summary', '', `查看其余 ${items.length - 3} 条`));
        const rest = document.createElement('ul');
        for (const item of items.slice(3)) rest.append(text('li', '', item));
        more.append(rest); detail.append(more);
      }
    }
    host.replaceChildren(detail);
  });
}

function duration(value) {
  if (value === null || value === undefined) return '未知';
  if (value < 1000) return `${value}ms`;
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60), minuteRemainder = minutes % 60;
  if (hours < 24) return `${hours}h ${String(minuteRemainder).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function totalTaskLabel(task) {
  if (task?.wall_clock_ms !== null && task?.wall_clock_ms !== undefined) return `生命周期 ${duration(task.wall_clock_ms)}`;
  if (task?.record_kind === 'historical_no_runtime') return '历史耗时未记录';
  if (task?.record_kind === 'never_started' || task?.record_kind === 'specification_only') return '尚未开始计时';
  return '生命周期未知';
}

function recordKindLabel(task) {
  return ({ current_run: '当前运行', historical_runtime: '历史运行', historical_no_runtime: '历史任务·无运行档案', never_started: '未启动', specification_only: '仅规格' })[task?.record_kind] ?? '状态未知';
}

function runtimeLabel(runtime) {
  if (!runtime) return '无活动角色';
  const state = runtime.state === 'awaiting_ingestion' ? '等待结果摄入' : runtime.state === 'running' ? '运行中' : '已准备';
  const heartbeat = runtime.heartbeat_age_ms === null ? '心跳未记录' : `心跳 ${duration(runtime.heartbeat_age_ms)} 前`;
  const progress = runtime.progress_age_ms === null ? '真实进展未记录' : `真实进展 ${duration(runtime.progress_age_ms)} 前${runtime.idle_timeout_ms ? `/${duration(runtime.idle_timeout_ms)} 熔断` : ''}`;
  const output = runtime.output_bytes === null ? '' : ` · 输出 ${runtime.output_bytes} B · 序号 ${runtime.progress_sequence}`;
  const remaining = runtime.remaining_ms === null ? '无截止时间' : `熔断剩余 ${duration(runtime.remaining_ms)}`;
  const usage = runtime.usage_total_tokens === null ? 'Token 未记录' : `Token ${runtime.usage_total_tokens}${runtime.token_limit ? `/${runtime.token_limit}` : ''}`;
  return `${runtime.role} ${state} · ${heartbeat} · ${progress}${output} · ${remaining} · ${usage}`;
}

function taskTimingBreakdownLabel(task) {
  return `主动 ${duration(task.active_ms)} · 等待 ${duration(task.waiting_ms)} · 未归因/空闲 ${duration(task.untracked_ms)}`;
}

function liveTaskTiming(task) {
  if (!task || !task.current || !snapshot?.active_task?.step_started_at) return task;
  const delta = Math.max(0, Date.now() - Date.parse(snapshot.generated_at));
  if (!delta) return task;
  const waiting = snapshot.active_task.step_status === 'waiting';
  return {
    ...task,
    wall_clock_ms: task.wall_clock_ms === null ? null : task.wall_clock_ms + delta,
    active_ms: task.active_ms + (waiting ? 0 : delta),
    waiting_ms: task.waiting_ms + (waiting ? delta : 0),
  };
}

function liveWaveTiming(wave) {
  if (!wave) return wave;
  const tasks = wave.task_ids.map((id) => snapshot.tasks.find((task) => task.task_id === id)).filter(Boolean).map(liveTaskTiming);
  const timed = tasks.filter((task) => task.wall_clock_ms !== null);
  return {
    ...wave,
    task_wall_clock_ms: timed.length ? timed.reduce((total, task) => total + task.wall_clock_ms, 0) : null,
    active_ms: tasks.reduce((total, task) => total + task.active_ms, 0),
    waiting_ms: tasks.reduce((total, task) => total + task.waiting_ms, 0),
  };
}

function clock(timestamp) {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(timestamp));
}

function timeRange(step) {
  if (!step.started_at) return '时间未知';
  return `${clock(step.started_at)} → ${step.ended_at ? clock(step.ended_at) : '进行中'}`;
}

function precisionName(value) {
  return value === 'exact' ? '精确' : value === 'derived' ? '推算' : '未知';
}

function statusName(value) {
  return ({ running: '运行中', waiting: '等待中', succeeded: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', awaiting_wave_review: '待波次验收', noted: '记录', unknown: '未知' })[value] ?? value;
}

function lifecycleName(value) {
  return ({ draft: '草稿', planned: '已计划', working: '实现中', verifying: '验证中', iterating: '迭代中', delivered: '已交付', cancelled: '已取消', awaiting_wave_review: '待波次验收' })[value] ?? value;
}

function taskLifecycleName(task) {
  return task?.blocked_by?.length ? '等待依赖' : lifecycleName(task?.status ?? task?.lifecycle);
}

function taskStateClass(task) {
  return task?.blocked_by?.length ? 'blocked' : task?.status === 'delivered' ? 'delivered' : '';
}

function waveName(wave) {
  return `${wave.wave_id}${wave.title && wave.title !== wave.wave_id ? ` · ${wave.title}` : ''}`;
}

function stepClass(step) {
  if (step.status === 'failed') return 'fail';
  if (step.status === 'interrupted' || step.status === 'cancelled') return 'interrupt';
  if (step.type === 'wait.user' || step.status === 'waiting') return 'wait';
  if (step.type.startsWith('gate.')) return 'gate';
  return 'work';
}

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function svgElement(tagName, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tagName);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function tag(value, className = 'meta-tag') {
  return text('span', className, value);
}

const globalTaskStatuses = {
  delivered: { label: '已交付', className: 'delivered' },
  working: { label: '实现中', className: 'working' },
  verifying: { label: '验证中', className: 'verifying' },
  iterating: { label: '返工中', className: 'iterating' },
  blocked: { label: '阻塞', className: 'blocked' },
  planned: { label: '已计划', className: 'planned' },
  awaiting_wave_review: { label: '待波次验收', className: 'waiting' },
  draft: { label: '草稿', className: 'draft' },
  cancelled: { label: '已取消', className: 'cancelled' },
};

function globalTaskStatus(task) {
  return task.blocked_by?.length ? 'blocked' : task.status ?? 'unknown';
}

function globalTaskStatusSummary() {
  const counts = new Map();
  for (const task of snapshot.tasks) {
    const status = globalTaskStatus(task);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const orderedKeys = [...Object.keys(globalTaskStatuses), ...[...counts.keys()].filter((key) => !globalTaskStatuses[key])]
    .filter((key) => counts.get(key));
  return orderedKeys.map((key) => ({ key, label: globalTaskStatuses[key]?.label ?? lifecycleName(key), count: counts.get(key) ?? 0 }));
}

function globalWaveStatusSummary() {
  const states = { done: 0, active: 0, waiting: 0, pending: 0 };
  for (const wave of snapshot.waves) states[waveState(wave)] += 1;
  return states;
}

function renderCurrent() {
  const active = snapshot.active_task;
  const delivered = snapshot.tasks.filter((task) => task.status === 'delivered').length;
  const inFlight = snapshot.tasks.filter((task) => ['working', 'verifying', 'iterating'].includes(task.status)).length;
  const activeWave = active ? waveForTask(active.task_id) : null;
  let status = { kind: 'success', label: '项目空闲' }, location = '等待任务进入执行', summary = '项目中还没有可展示的活动任务事实', nextAction = '下一动作：创建或启动一个 Task';
  if (active) {
    location = `${activeWave ? waveName(activeWave) : '未归属波次'} / ${active.task_id} / Round ${active.round}`;
    const concurrent = active.concurrent_task_ids?.length ? ` · 并行 ${active.concurrent_task_ids.join('、')}` : '';
    summary = (active.blocked_by?.length ? `${active.title} · 等待前置 Task ${active.blocked_by.join('、')}` : `${active.title} · ${taskLifecycleName(active)} · ${active.step_label ?? '当前执行器未上报步骤事件'}`) + concurrent;
    nextAction = `下一动作：${active.next_action}`;
    status = active.blocked_by?.length ? { kind: 'waiting', label: '依赖阻塞' } : active.step_status === 'running' ? { kind: 'processing', label: '正在运行' } : { kind: 'waiting', label: active.step_status === 'waiting' ? '等待用户' : '等待事件接入' };
  }
  callAntd('updateGlobalOverview', [{ projectName: `${snapshot.project.name} · ${snapshot.tasks.length} Task · ${snapshot.waves.length} 波次`, taskTotal: snapshot.tasks.length, waveTotal: snapshot.waves.length, delivered, inFlight, statuses: globalTaskStatusSummary(), waves: globalWaveStatusSummary(), status, location, summary, elapsed: currentElapsedLabel(), nextAction }]);
}

function currentElapsedLabel() {
  if (!snapshot?.active_task?.step_started_at) return '—';
  return duration(Math.max(0, Date.now() - Date.parse(snapshot.active_task.step_started_at)));
}

function tickElapsed() {
  if (!snapshot) return;
  callAntd('updateGlobalOverview', [{ elapsed: currentElapsedLabel() }]);
  const elapsed = currentElapsedLabel();
  const activeNodeDuration = elements.workflow.querySelector('[data-active-node-duration]');
  if (activeNodeDuration) activeNodeDuration.textContent = `已运行 ${elapsed}`;
}

function stageForType(type) {
  return workflowStages.find((stage) => stage.types.includes(type))?.key ?? null;
}

function workflowStageState(stage, activeTask, activeStage) {
  const related = activeTask?.steps.filter((step) => stage.types.includes(step.type)) ?? [];
  const isActive = stage.key === activeStage;
  const failed = related.some((step) => step.status === 'failed' || step.status === 'interrupted' || step.status === 'cancelled');
  if (isActive && failed) return { state: 'failed', related };
  if (isActive && related.some((step) => step.status === 'waiting')) return { state: 'waiting', related };
  if (isActive) return { state: 'active', related };
  if (related.some((step) => step.status === 'succeeded')) return { state: 'done', related };
  if (snapshot.active_task?.lifecycle === 'delivered' && stage.key === 'deliver') return { state: 'done', related };
  return { state: 'pending', related };
}

function stageDuration(stageState) {
  const measured = stageState.related.filter((step) => step.duration_ms !== null);
  if (measured.length) return duration(measured.reduce((sum, step) => sum + step.duration_ms, 0));
  if (stageState.state === 'done') return '耗时未知';
  if (stageState.state === 'failed') return '检查失败';
  if (stageState.state === 'waiting') return '等待中';
  if (stageState.state === 'active') return '已运行 0ms';
  return '未运行';
}

function appendDagText(group, className, x, y, value) {
  const label = svgElement('text', { class: className, x, y });
  label.textContent = value;
  group.append(label);
  return label;
}

function appendDagWrappedText(group, className, x, y, value, maxChars = 13) {
  const label = svgElement('text', { class: className, x, y });
  const characters = [...value], lines = characters.length > maxChars ? [characters.slice(0, maxChars).join(''), characters.slice(maxChars, maxChars * 2).join('')] : [value];
  if (characters.length > maxChars * 2) lines[1] = `${lines[1].slice(0, Math.max(1, maxChars - 1))}…`;
  lines.forEach((line, index) => {
    const part = svgElement('tspan', { x, dy: index === 0 ? '0' : '14' }); part.textContent = line; label.append(part);
  });
  group.append(label); return label;
}

function taskHasProblem(task) {
  return ['verifying', 'iterating'].includes(task.status)
    || task.steps.some((step) => ['failed', 'interrupted', 'waiting'].includes(step.status));
}

function taskIsSlow(task) {
  if (task.retry_count > 0 || task.waiting_ms > task.active_ms) return true;
  if (task.wall_clock_ms && (task.untracked_ms ?? 0) / task.wall_clock_ms > .2) return true;
  const bottleneck = task.steps.find((step) => step.id === task.bottleneck_step_id);
  return Boolean(task.wall_clock_ms && bottleneck?.duration_ms && bottleneck.duration_ms / task.wall_clock_ms > .5);
}

function taskMatchesFilter(task) {
  if (taskFilter === 'delivered') return task.status === 'delivered';
  if (taskFilter === 'active') return !['delivered', 'cancelled'].includes(task.status);
  if (taskFilter === 'problems') return taskHasProblem(task);
  if (taskFilter === 'slow') return taskIsSlow(task);
  return true;
}

function renderWaveSelector() {
  updateWorkflowControls({
    options: snapshot.waves.map((wave) => ({ value: wave.wave_id, label: waveName(wave) })),
    value: selectedWaveId ?? undefined,
  });
}

function waveForTask(taskId) {
  if (!taskId) return null;
  return snapshot.waves.find((wave) => wave.wave_id === selectedWaveId && wave.task_ids.includes(taskId))
    ?? snapshot.waves.find((wave) => wave.task_ids.includes(taskId)) ?? null;
}

function currentWave() {
  const activeId = snapshot.active_task?.task_id;
  if (activeId) return snapshot.waves.find((wave) => wave.task_ids.includes(activeId)) ?? null;
  return [...snapshot.waves].reverse().find((wave) => wave.status !== 'delivered')
    ?? snapshot.waves.at(-1) ?? null;
}

function defaultWave() {
  return currentWave()
    ?? snapshot.waves.find((wave) => ['working', 'verifying'].includes(wave.status))
    ?? [...snapshot.waves].reverse().find((wave) => wave.task_total > 0 && wave.status !== 'delivered')
    ?? [...snapshot.waves].reverse().find((wave) => wave.status !== 'delivered')
    ?? snapshot.waves.at(-1) ?? null;
}

function waveProgressLabel(wave) {
  if (wave.status === 'delivered') return '已完成';
  if (wave.status === 'verifying') return '验证中';
  if (wave.status === 'working') return '进行中';
  return '待开始';
}

function waveTimingLabel(wave) {
  const live = liveWaveTiming(wave);
  return live.task_wall_clock_ms === null ? '耗时未记录' : duration(live.task_wall_clock_ms);
}

function waveSidebarStatus(wave, activeWave) {
  const current = wave.wave_id === activeWave?.wave_id;
  return current ? '当前执行' : waveProgressLabel(wave);
}

function renderWaveSidebar() {
  const activeWave = currentWave(), completed = snapshot.waves.filter((wave) => wave.status === 'delivered').length;
  elements.waveSidebarCount.textContent = `${completed}/${snapshot.waves.length} 已收口`;
  elements.waveSidebarSummary.textContent = activeWave
    ? `当前运行到 ${activeWave.wave_id} · ${activeWave.title}`
    : snapshot.active_task ? `当前 ${snapshot.active_task.task_id} 尚未归属波次` : '当前没有活动 Task';
  callAntd('updateWaveMenu', [{
    selectedKey: selectedWaveId ?? undefined,
    items: snapshot.waves.map((wave) => {
      const state = waveState(wave);
      return {
        key: wave.wave_id,
        title: wave.title,
        current: wave.wave_id === activeWave?.wave_id,
        stateLabel: waveSidebarStatus(wave, activeWave),
        stateColor: state === 'done' ? 'success' : state === 'active' ? 'processing' : state === 'waiting' ? 'warning' : undefined,
        completed: wave.completed_tasks,
        total: wave.task_total,
        time: waveTimingLabel(wave),
        percent: wave.task_total ? Math.min(100, Math.round(wave.completed_tasks / wave.task_total * 100)) : 0,
      };
    }),
  }]);
}

function patchWaveSidebar() {
  renderWaveSidebar();
}

function goPortfolio() {
  const wave = defaultWave();
  if (wave) { openWave(wave.wave_id); return; }
  workflowSelectionInitialized = true; workflowMode = 'portfolio'; selectedWaveId = null; expandedTaskId = null; portfolioHasLocated = true; renderWorkflow(); renderMetrics(); patchWaveSidebar();
  requestAnimationFrame(() => elements.workflow.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function openWave(waveId) {
  const wave = snapshot.waves.find((item) => item.wave_id === waveId); if (!wave) return;
  workflowSelectionInitialized = true; selectedWaveId = waveId; expandedTaskId = null; workflowMode = 'wave'; portfolioHasLocated = true;
  selectedTaskId = snapshot.active_task && wave.task_ids.includes(snapshot.active_task.task_id) ? snapshot.active_task.task_id : wave.task_ids[0] ?? null;
  taskWaveFilter = waveId; renderTaskWaveSelector(); renderWorkflow(); renderTasks(); renderDetails(); renderMetrics(); patchWaveSidebar();
  requestAnimationFrame(() => elements.workflow.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function toggleWave(waveId) {
  openWave(waveId); renderMetrics();
}

function renderBreadcrumb(task = null) {
  const nav = document.createElement('nav'); nav.className = 'workflow-breadcrumb'; nav.setAttribute('aria-label', '工作流层级');
  const items = [];
  const wave = selectedWaveId ? snapshot.waves.find((item) => item.wave_id === selectedWaveId) : waveForTask(task?.task_id);
  elements.workflow.append(nav);
  if (wave) items.push({ label: `${wave.wave_id} · ${wave.title}`, current: !task, disabled: workflowMode === 'wave', onClick: () => openWave(wave.wave_id) });
  if (task) items.push({ label: task.task_id, current: true });
  callAntd('mountBreadcrumb', [nav, items], () => {
    items.forEach((item, index) => {
      if (index) nav.append(text('span', 'breadcrumb-separator', '/'));
      if (item.current) nav.append(text('strong', '', item.label));
      else {
        const button = text('button', 'fallback-link-button', item.label);
        button.type = 'button'; button.disabled = Boolean(item.disabled); button.addEventListener('click', item.onClick); nav.append(button);
      }
    });
  });
}

function appendArrowDefinition(svg, id) {
  const defs = svgElement('defs'), arrow = svgElement('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto' });
  arrow.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'dag-arrow-head' })); defs.append(arrow); svg.append(defs);
}

function appendLaneArrowDefinitions(svg, waveId) {
  const defs = svgElement('defs');
  for (const [state, className] of [['base', ''], ['done', ' done'], ['active', ' active']]) {
    const marker = svgElement('marker', { id: `lane-arrow-${waveId}-${state}`, viewBox: '0 0 12 12', refX: '10', refY: '6', markerWidth: '9', markerHeight: '9', orient: 'auto', markerUnits: 'userSpaceOnUse' });
    marker.append(svgElement('path', { d: 'M1 1 L11 6 L1 11 Z', class: `lane-arrow-head${className}` })); defs.append(marker);
  }
  svg.append(defs);
}

function waveState(wave) {
  if (wave.status === 'delivered') return 'done';
  if (wave.task_ids.includes(snapshot.active_task?.task_id)) return 'active';
  return wave.status === 'working' ? 'active' : ['verifying', 'planned'].includes(wave.status) ? 'waiting' : 'pending';
}

function reducedWaveGraph(wave) {
  const byId = new Map(snapshot.tasks.map((task) => [task.task_id, task]));
  const nodes = wave.task_ids.map((id) => byId.get(id)).filter(Boolean), nodeIds = new Set(nodes.map((task) => task.task_id));
  function isAncestor(candidateId, taskId, visiting = new Set()) {
    if (visiting.has(taskId)) return false;
    const task = byId.get(taskId); if (!task) return false;
    const dependencies = (task.depends_on ?? []).filter((id) => nodeIds.has(id));
    return dependencies.includes(candidateId) || dependencies.some((id) => isAncestor(candidateId, id, new Set(visiting).add(taskId)));
  }
  const dependencies = new Map();
  for (const task of nodes) {
    const declared = (task.depends_on ?? []).filter((id) => nodeIds.has(id));
    dependencies.set(task.task_id, declared.filter((candidate) => !declared.some((other) => other !== candidate && isAncestor(candidate, other))));
  }
  return { nodes, dependencies };
}

async function elkWaveLayout(wave) {
  const graph = reducedWaveGraph(wave), signature = `${wave.wave_id}|${graph.nodes.map((task) => `${task.task_id}:${(graph.dependencies.get(task.task_id) ?? []).join(',')}`).join('|')}`;
  if (elkLayoutCache.has(signature)) return { ...graph, ...await elkLayoutCache.get(signature) };
  if (!globalThis.ELK) throw new Error('ELK layout engine 未加载');
  elkInstance ??= new globalThis.ELK();
  const nodeWidth = 190, nodeHeight = 82, edges = [];
  for (const [taskId, dependencies] of graph.dependencies) for (const dependencyId of dependencies) edges.push({ id: `${dependencyId}__${taskId}`, sources: [dependencyId], targets: [taskId] });
  const promise = elkInstance.layout({
    id: `wave-${wave.wave_id}`,
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=24,left=24,bottom=24,right=24]', 'elk.spacing.nodeNode': '28',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72', 'elk.layered.spacing.edgeNodeBetweenLayers': '28',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP', 'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.unnecessaryBendpoints': 'true', 'elk.layered.mergeEdges': 'false',
    },
    children: graph.nodes.map((task) => ({ id: task.task_id, width: nodeWidth, height: nodeHeight })), edges,
  }).then((layout) => ({ layout, nodeWidth, nodeHeight }));
  elkLayoutCache.set(signature, promise); return { ...graph, ...await promise };
}

function roundedOrthogonalPath(rawPoints) {
  if (rawPoints.length < 2) return '';
  const points = rawPoints.map((point) => ({ ...point }));
  const firstVector = { x: points[1].x - points[0].x, y: points[1].y - points[0].y }, firstLength = Math.hypot(firstVector.x, firstVector.y) || 1;
  points[0].x += firstVector.x / firstLength * 3; points[0].y += firstVector.y / firstLength * 3;
  const lastIndex = points.length - 1, lastVector = { x: points[lastIndex].x - points[lastIndex - 1].x, y: points[lastIndex].y - points[lastIndex - 1].y }, lastLength = Math.hypot(lastVector.x, lastVector.y) || 1;
  points[lastIndex].x -= lastVector.x / lastLength * 10; points[lastIndex].y -= lastVector.y / lastLength * 10;
  let path = `M${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1], current = points[index], next = points[index + 1];
    const incomingLength = Math.hypot(current.x - previous.x, current.y - previous.y), outgoingLength = Math.hypot(next.x - current.x, next.y - current.y);
    const radius = Math.min(8, incomingLength / 2, outgoingLength / 2);
    const before = { x: current.x + (previous.x - current.x) / (incomingLength || 1) * radius, y: current.y + (previous.y - current.y) / (incomingLength || 1) * radius };
    const after = { x: current.x + (next.x - current.x) / (outgoingLength || 1) * radius, y: current.y + (next.y - current.y) / (outgoingLength || 1) * radius };
    path += ` L${before.x} ${before.y} Q${current.x} ${current.y} ${after.x} ${after.y}`;
  }
  path += ` L${points[lastIndex].x} ${points[lastIndex].y}`; return path;
}

function edgeVisualState(layout, fromId, toId) {
  const from = layout.nodes.find((task) => task.task_id === fromId), to = layout.nodes.find((task) => task.task_id === toId);
  const dependencies = layout.dependencies.get(toId) ?? [], allDependenciesDone = dependencies.every((id) => ['delivered', 'cancelled'].includes(layout.nodes.find((task) => task.task_id === id)?.status));
  if (to?.current || ['working', 'verifying', 'iterating'].includes(to?.status)) return allDependenciesDone ? 'active' : 'ready';
  if (from?.status === 'delivered' && to?.status === 'delivered') return 'done';
  if (allDependenciesDone && !['delivered', 'cancelled'].includes(to?.status)) return 'ready';
  return '';
}

function taskNodeState(task, wave) {
  const internalDependencies = (task.depends_on ?? []).map((id) => snapshot.tasks.find((item) => item.task_id === id)).filter((item) => item && wave.task_ids.includes(item.task_id));
  const dependencyIncomplete = task.blocked_by?.length || internalDependencies.some((dependency) => !['delivered', 'cancelled'].includes(dependency.status));
  return dependencyIncomplete ? 'waiting' : task.current ? 'active' : task.status === 'delivered' ? 'done'
    : task.status === 'working' ? 'active' : task.status === 'verifying' ? 'waiting' : 'pending';
}

function waveEdgeVisualState(wave, fromId, toId) {
  const byId = new Map(snapshot.tasks.map((task) => [task.task_id, task])), from = byId.get(fromId), to = byId.get(toId);
  const dependencies = (to?.depends_on ?? []).filter((id) => wave.task_ids.includes(id));
  const allDependenciesDone = dependencies.every((id) => ['delivered', 'cancelled'].includes(byId.get(id)?.status));
  if (to?.current || ['working', 'verifying', 'iterating'].includes(to?.status)) return allDependenciesDone ? 'active' : 'ready';
  if (from?.status === 'delivered' && to?.status === 'delivered') return 'done';
  if (allDependenciesDone && !['delivered', 'cancelled'].includes(to?.status)) return 'ready';
  return '';
}

async function renderElkWaveGraph(wave, canvas) {
  canvas.replaceChildren(text('div', 'graph-loading', '正在计算无穿透的 DAG 路由…'));
  try {
    const graph = await elkWaveLayout(wave);
    if (!canvas.isConnected || selectedWaveId !== wave.wave_id) return;
    const width = Math.max(560, graph.layout.width ?? 560), height = Math.max(94, graph.layout.height ?? 94);
    const svg = svgElement('svg', { class: 'wave-lane-dag elk-dag', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${wave.wave_id} ELK 分层避障 Task 依赖图` }); appendLaneArrowDefinitions(svg, wave.wave_id);
    const edges = svgElement('g', { class: 'dag-edges' }), outgoing = new Map();
    for (const [taskId, dependencies] of graph.dependencies) for (const dependencyId of dependencies) {
      if (!outgoing.has(dependencyId)) outgoing.set(dependencyId, []); outgoing.get(dependencyId).push(taskId);
    }
    for (const edge of graph.layout.edges ?? []) {
      const fromId = edge.sources?.[0], toId = edge.targets?.[0], state = edgeVisualState(graph, fromId, toId), markerState = state === 'done' ? 'done' : state === 'active' || state === 'ready' ? 'active' : 'base';
      for (const section of edge.sections ?? []) {
        const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint], path = svgElement('path', { d: roundedOrthogonalPath(points), class: `dag-edge lane-edge ${state}`, 'data-edge-from': fromId, 'data-edge-to': toId, 'data-marker-state': markerState, 'marker-end': `url(#lane-arrow-${wave.wave_id}-${markerState})` });
        const title = svgElement('title'); title.textContent = `${fromId} → ${toId}`; path.append(title); edges.append(path);
      }
    }
    svg.append(edges);
    const byId = new Map(graph.nodes.map((task) => [task.task_id, task])), nodes = svgElement('g', { class: 'lane-nodes' });
    for (const node of graph.layout.children ?? []) {
      const task = byId.get(node.id); if (!task) continue;
      const isHeavy = wave.heavy_task_ids.includes(task.task_id), state = taskNodeState(task, wave);
      const filterMuted = taskFilter !== 'all' && !taskMatchesFilter(task);
      const group = svgElement('g', { class: `dag-node lane-task-node ${state}${isHeavy ? ' heavy' : ''}${task.task_id === expandedTaskId ? ' selected' : ''}${filterMuted ? ' filter-muted' : ''}`, transform: `translate(${node.x ?? 0} ${node.y ?? 0})`, role: 'button', tabindex: '0', 'data-task-id': task.task_id, 'aria-label': `${task.task_id} ${task.title}，点击展开详情` });
      const fullTitle = svgElement('title'); fullTitle.textContent = `${task.task_id} · ${task.title}`; group.append(fullTitle);
      group.append(svgElement('rect', { class: 'dag-node-surface', width: graph.nodeWidth, height: graph.nodeHeight, rx: '8' }), svgElement('rect', { class: 'dag-node-accent', width: '3', height: graph.nodeHeight - 16, x: '0', y: '8', rx: '2' }));
      if ((graph.dependencies.get(task.task_id) ?? []).length) group.append(svgElement('circle', { class: 'dag-port input', cx: '0', cy: graph.nodeHeight / 2, r: '3.5' }));
      if (outgoing.has(task.task_id)) group.append(svgElement('circle', { class: 'dag-port output', cx: graph.nodeWidth, cy: graph.nodeHeight / 2, r: '3.5' }));
      appendDagText(group, 'dag-role', 9, 16, `${isHeavy ? 'HEAVY · ' : task.task_id.startsWith('WEB-') ? 'WEB · ' : ''}${task.task_id}`);
      appendDagWrappedText(group, 'dag-label', 9, 35, task.title, 14);
      appendDagText(group, 'dag-duration', 9, 70, `${taskLifecycleName(task)} · ${totalTaskLabel(task)}`);
      const connectedEdges = () => [...svg.querySelectorAll('.lane-edge')].filter((edge) => edge.dataset.edgeFrom === task.task_id || edge.dataset.edgeTo === task.task_id);
      group.addEventListener('mouseenter', () => { for (const edge of connectedEdges()) { edge.classList.add('highlight'); edge.setAttribute('marker-end', `url(#lane-arrow-${wave.wave_id}-active)`); } });
      group.addEventListener('mouseleave', () => { for (const edge of connectedEdges()) { edge.classList.remove('highlight'); edge.setAttribute('marker-end', `url(#lane-arrow-${wave.wave_id}-${edge.dataset.markerState})`); } });
      const activate = () => openTaskWorkflow(task.task_id); group.addEventListener('click', activate); group.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } }); nodes.append(group);
    }
    svg.append(nodes); canvas.replaceChildren(svg);
  } catch (error) {
    if (canvas.isConnected) canvas.replaceChildren(text('div', 'graph-error', `DAG 布局失败：${error.message}`));
  }
}

function percentage(value) {
  return value === null || value === undefined ? '未知' : `${Math.round(value)}%`;
}

function breakdownItems(task) {
  const value = task.duration_breakdown ?? {};
  return [
    ['复现', value.reproduce_ms ?? 0, 'reproduce'], ['分析', value.analyze_ms ?? 0, 'analyze'],
    ['修改', value.change_ms ?? 0, 'change'], ['测试', value.test_ms ?? 0, 'test'],
    ['等待', value.wait_ms ?? 0, 'wait'], ['其他执行', value.other_ms ?? 0, 'other'],
    ['未拆分', value.unattributed_ms ?? task.untracked_ms ?? 0, 'unattributed'],
  ];
}

function optimizationHints(task) {
  const hints = [];
  if (task.wall_clock_ms && (task.duration_breakdown?.unattributed_ms ?? 0) / task.wall_clock_ms > .2) hints.push('未拆分时间超过总跨度 20%，优先补充细粒度活动埋点。');
  const bottleneck = task.steps.find((step) => step.id === task.bottleneck_step_id);
  if (task.wall_clock_ms && bottleneck?.duration_ms && bottleneck.duration_ms / task.wall_clock_ms > .5) hints.push(`“${bottleneck.label}”占总跨度超过一半，适合继续拆分。`);
  if (task.retry_count > 0) hints.push(`发现 ${task.retry_count} 次失败或中断，建议检查重复失败指纹。`);
  if (task.waiting_ms > task.active_ms) hints.push('等待时间高于主动执行时间，优先优化人工确认或外部依赖。');
  if (!hints.length) hints.push(task.wall_clock_ms === null ? '历史执行缺少墙钟时间，暂时无法生成优化判断。' : '当前没有命中明确的耗时异常规则。');
  return hints;
}

function unionDuration(intervals) {
  const sorted = intervals.filter((item) => item.end > item.start).sort((left, right) => left.start - right.start || left.end - right.end), merged = [];
  for (const item of sorted) {
    const tail = merged.at(-1);
    if (!tail || item.start > tail.end) merged.push({ ...item }); else tail.end = Math.max(tail.end, item.end);
  }
  return merged.reduce((total, item) => total + item.end - item.start, 0);
}

function roundTimeline(task) {
  const groups = new Map();
  for (const step of task.steps) {
    const key = step.round === null || step.round === undefined ? 'other' : String(step.round);
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(step);
  }
  return [...groups.entries()].sort(([left], [right]) => left === 'other' ? 1 : right === 'other' ? -1 : Number(left) - Number(right)).map(([key, steps]) => {
    const parent = steps.filter((step) => step.type === 'round.work').sort((left, right) => (right.duration_ms ?? 0) - (left.duration_ms ?? 0))[0] ?? null;
    const children = steps.filter((step) => step.type !== 'round.work');
    const childIntervals = children.filter((step) => step.started_at && step.duration_ms !== null && step.status !== 'noted').map((step) => ({ start: Date.parse(step.started_at), end: step.ended_at ? Date.parse(step.ended_at) : Date.now() }));
    let unpartitioned = 0;
    if (parent?.started_at && parent.duration_ms !== null) {
      const parentStart = Date.parse(parent.started_at), parentEnd = parent.ended_at ? Date.parse(parent.ended_at) : Date.now();
      const clipped = childIntervals.map((item) => ({ start: Math.max(parentStart, item.start), end: Math.min(parentEnd, item.end) }));
      unpartitioned = Math.max(0, parent.duration_ms - unionDuration(clipped));
    }
    const measured = parent?.duration_ms ?? unionDuration(childIntervals);
    return { key, label: key === 'other' ? '其他记录' : Number(key) === 0 ? '准备阶段' : `第 ${key} 轮`, steps: children, duration_ms: measured, unpartitioned };
  });
}

function renderConclusion(task) {
  const section = document.createElement('section'); section.className = 'task-conclusion';
  const bottleneck = task.steps.find((step) => step.id === task.bottleneck_step_id);
  const issue = task.wall_clock_ms === null ? '历史执行没有墙钟时间' : (task.detail_coverage_pct ?? 0) < 80 ? '执行活动的细粒度记录不足' : task.retry_count > 0 ? '存在失败或中断重试' : '未发现明显执行异常';
  const values = [
    ['结果', taskLifecycleName(task)], ['总跨度', duration(task.wall_clock_ms)], ['有效执行', duration(task.active_ms)],
    ['最长步骤', bottleneck ? `${bottleneck.label} · ${duration(bottleneck.duration_ms)}` : '未知'],
    ['时间覆盖', percentage(task.recording_coverage_pct)], ['明细覆盖', percentage(task.detail_coverage_pct)],
  ];
  const header = document.createElement('div'); header.className = 'detail-section-heading'; header.append(text('strong', '', '执行结论'), text('span', '', issue)); section.append(header);
  const grid = document.createElement('div'); grid.className = 'conclusion-grid';
  for (const [label, value] of values) { const item = document.createElement('div'); item.append(text('span', '', label), text('strong', '', value)); grid.append(item); }
  section.append(grid); return section;
}

function renderComposition(task) {
  const section = document.createElement('section'); section.className = 'duration-composition';
  const items = breakdownItems(task), total = Math.max(0, items.reduce((sum, item) => sum + item[1], 0));
  const nonZero = items.filter((item) => item[1] > 0), longest = [...nonZero].sort((left, right) => right[1] - left[1])[0];
  const header = document.createElement('div'); header.className = 'detail-section-heading'; header.append(text('strong', '', '耗时构成'), text('span', '', longest ? `占比最高：${longest[0]} ${duration(longest[1])}` : '暂无可计算的耗时事实')); section.append(header);
  const bar = document.createElement('div'); bar.className = 'composition-bar'; bar.setAttribute('aria-label', '任务耗时构成');
  if (!total) bar.append(text('span', 'composition-empty', '耗时待采集'));
  for (const [label, value, key] of nonZero) { const part = document.createElement('span'); part.className = `composition-segment ${key}`; part.style.width = `${value / total * 100}%`; part.title = `${label} ${duration(value)} · ${Math.round(value / total * 100)}%`; bar.append(part); }
  const legend = document.createElement('div'); legend.className = 'composition-legend';
  for (const [label, value, key] of nonZero) { const item = document.createElement('span'); item.className = key; item.append(text('i', '', ''), document.createTextNode(`${label} ${Math.round(value / total * 100)}% · ${duration(value)}`)); legend.append(item); }
  const facts = document.createElement('div'); facts.className = 'optimization-facts';
  facts.append(tag(`失败/中断 ${task.retry_count} 次`, task.retry_count ? 'fact danger' : 'fact'), tag(`未拆分 ${duration(task.duration_breakdown?.unattributed_ms ?? 0)}`, 'fact'), tag(`明细覆盖 ${percentage(task.detail_coverage_pct)}`, 'fact'));
  const hints = document.createElement('ul'); hints.className = 'optimization-hints'; for (const hint of optimizationHints(task)) hints.append(text('li', '', hint));
  section.append(bar, legend, facts, hints); return section;
}

function renderLayeredTimeline(task) {
  const section = document.createElement('section'); section.className = 'layered-timeline';
  const header = document.createElement('div'); header.className = 'detail-section-heading'; header.append(text('strong', '', '分层时间线'), text('span', '', 'Task → Round → 活动步骤')); section.append(header);
  const groups = roundTimeline(task);
  if (!groups.length) { section.append(text('div', 'inline-empty', task.managed ? '暂无步骤事件' : '该历史任务只有规格与交付状态，尚未写入可重建的步骤耗时。')); return section; }
  for (const group of groups) {
    const round = document.createElement('article'); round.className = 'round-group';
    const roundHead = document.createElement('div'); roundHead.className = 'round-group-heading'; roundHead.append(text('strong', '', group.label), text('span', '', duration(group.duration_ms))); round.append(roundHead);
    const list = document.createElement('div'); list.className = 'round-step-list';
    for (const step of group.steps) {
      const item = document.createElement('div'); item.className = `round-step ${step.status}${step.id === task.bottleneck_step_id ? ' bottleneck' : ''}`;
      const main = document.createElement('div'); main.className = 'round-step-main'; main.append(text('strong', '', step.label), text('span', '', step.summary));
      const meta = document.createElement('div'); meta.className = 'round-step-meta'; meta.append(text('strong', '', duration(step.duration_ms)), text('span', '', `${statusName(step.status)} · ${timeRange(step)}`));
      item.append(main, meta); list.append(item);
    }
    if (group.unpartitioned > 0) {
      const missing = document.createElement('div'); missing.className = 'round-step unpartitioned';
      const main = document.createElement('div'); main.className = 'round-step-main'; main.append(text('strong', '', '未拆分时间'), text('span', '', '本轮实现已计时，但没有记录更细的复现、分析、修改或测试活动。'));
      const meta = document.createElement('div'); meta.className = 'round-step-meta'; meta.append(text('strong', '', duration(group.unpartitioned)), text('span', '', '建议补充活动埋点')); missing.append(main, meta); list.append(missing);
    }
    if (!group.steps.length && !group.unpartitioned) list.append(text('div', 'inline-empty', '本轮没有更细的活动记录。'));
    round.append(list); section.append(round);
  }
  return section;
}

function renderDataSources(task) {
  const sources = [...new Set(task.steps.map((step) => step.source))];
  const details = document.createElement('details'); details.className = 'task-data-sources';
  const summary = document.createElement('summary'); summary.textContent = `数据来源 · ${sources.length || 0} 项`;
  const content = document.createElement('div'); content.className = 'source-list';
  if (!sources.length) content.append(text('span', '', '没有执行事件来源'));
  else for (const source of sources) content.append(tag(source, 'source-tag'));
  details.append(summary, content); return details;
}

function renderInlineTaskDetail(task) {
  const detail = document.createElement('section'); detail.className = 'inline-task-detail'; detail.id = `inline-detail-${task.task_id}`;
  const heading = document.createElement('div'); heading.className = 'inline-task-heading';
  const identity = document.createElement('div'); identity.append(text('span', 'section-kicker', '任务详情'), text('strong', '', `${task.task_id} · ${task.title}`), text('p', '', `${taskLifecycleName(task)} · 第 ${task.round} 轮 · 每秒同步执行事实`));
  const close = document.createElement('span'); close.className = 'antd-inline-action';
  mountButton(close, { label: '收起', type: 'text', size: 'small' }, () => { expandedTaskId = null; renderWorkflow(); });
  heading.append(identity, close); detail.append(heading, renderConclusion(task), renderComposition(task), renderLayeredTimeline(task), renderDataSources(task)); return detail;
}

function renderWaveLane(wave, activeWave) {
  const expanded = selectedWaveId === wave.wave_id, current = wave.wave_id === activeWave?.wave_id;
  const section = document.createElement('section'); section.className = `wave-chain-item${current ? ' current' : ''}${expanded ? ' expanded' : ''}`; section.id = `wave-lane-${wave.wave_id}`;
  const header = document.createElement('button'); header.type = 'button'; header.className = 'wave-chain-card'; header.setAttribute('aria-expanded', String(expanded));
  const identity = document.createElement('span'); identity.className = 'wave-chain-identity';
  identity.append(text('span', 'wave-lane-id', wave.wave_id), text('strong', '', wave.title));
  const summary = document.createElement('span'); summary.className = 'wave-chain-summary';
  summary.append(text('span', '', wave.summary), text('small', '', `${wave.completed_tasks}/${wave.task_total} Task · ${wave.heavy_task_ids.length ? `收口 ${wave.heavy_task_ids.join(' / ')}` : '定向收口'} · ${wave.task_wall_clock_ms === null ? '耗时待采集' : duration(wave.task_wall_clock_ms)}`));
  const state = text('span', `wave-chain-state ${waveState(wave)}`, `${current ? '当前 · ' : ''}${waveProgressLabel(wave)}`);
  const disclosure = text('span', 'wave-chain-disclosure', expanded ? '收起任务 −' : '查看任务 +');
  header.append(identity, summary, state, disclosure); header.addEventListener('click', () => toggleWave(wave.wave_id));
  section.append(header);
  if (!expanded) return section;

  if (!wave.task_ids.length) {
    const activeTaskId = snapshot.active_task?.task_id;
    const activeTaskWave = waveForTask(activeTaskId);
    appendAntdEmpty(section, `${wave.wave_id} 暂无关联 Task`, activeTaskId
      ? `${activeTaskId} ${activeTaskWave ? `属于 ${activeTaskWave.wave_id}` : '尚未写入任何波次的规格关系'}。空白画布已隐藏，避免误以为工作流加载失败。`
      : '规格中尚未为这个波次声明 Task，因此没有可绘制的依赖工作流。', '查看未归属 Task', () => {
      taskWaveFilter = 'unassigned'; renderTaskWaveSelector(); renderTasks();
      requestAnimationFrame(() => elements.taskList.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    });
    return section;
  }

  const canvas = document.createElement('div'); canvas.className = 'wave-lane-canvas';
  const graphWrap = document.createElement('div'); graphWrap.className = 'wave-lane-graph';
  const graphHeading = document.createElement('div'); graphHeading.className = 'wave-lane-graph-heading';
  graphHeading.append(text('strong', '', `${wave.wave_id} 任务工作流`), text('span', 'workflow-direction', '执行方向 →　同列可并行　·　悬停节点高亮上下游'));
  graphWrap.append(graphHeading, canvas); section.append(graphWrap); renderElkWaveGraph(wave, canvas);
  const expandedTask = snapshot.tasks.find((task) => task.task_id === expandedTaskId && wave.task_ids.includes(task.task_id)); if (expandedTask) section.append(renderInlineTaskDetail(expandedTask));
  return section;
}

function renderPortfolioWorkflow() {
  elements.workflow.replaceChildren(); renderWaveSelector();
  const activeWave = currentWave();
  const completedWaves = snapshot.waves.filter((wave) => wave.status === 'delivered').length;
  const totalTasks = snapshot.waves.reduce((total, wave) => total + wave.task_total, 0), completedTasks = snapshot.waves.reduce((total, wave) => total + wave.completed_tasks, 0);
  const timedTasks = snapshot.waves.reduce((total, wave) => total + wave.timed_tasks, 0);
  const activeTaskId = snapshot.active_task?.task_id;
  const activeUnassigned = Boolean(activeTaskId && !activeWave);
  elements.workflowHeading.textContent = activeUnassigned ? '波次执行总览 · 当前 Task 未归属' : `波次执行总览 · 当前 ${activeWave?.wave_id ?? '无'}`;
  elements.workflowCaption.textContent = '左侧固定展示 H1→H15 完整明细 · 选择波次后在这里查看 Task 依赖';
  updateWorkflowControls({ backVisible: false, source: '左侧全局波次 · 右侧按需下钻' });
  if (!snapshot.waves.length) { appendAntdEmpty(elements.workflow, '规格中没有可展示的波次'); return; }
  const overview = document.createElement('section'); overview.className = 'portfolio-overview';
  const overviewLead = document.createElement('div'); overviewLead.className = 'portfolio-overview-lead';
  overviewLead.append(text('span', 'section-kicker', 'PROJECT OVERVIEW'), text('strong', '', `${completedWaves} / ${snapshot.waves.length} 个波次完成`), text('p', '', activeWave
    ? `当前位置：${activeWave.wave_id} · ${activeWave.title} · ${waveProgressLabel(activeWave)}；${activeWave.unfinished_task_ids.length ? `待处理 ${activeWave.unfinished_task_ids.join('、')}` : '波次已收口'}`
    : activeUnassigned ? `当前执行 ${activeTaskId}，但规格中没有它与波次的归属关系` : '当前没有活动 Task'));
  const activeBelongsToWave = activeWave?.task_ids.includes(snapshot.active_task?.task_id);
  overview.append(overviewLead, tag(`${completedTasks}/${totalTasks} Task 完成`, 'overview-stat'), tag(`${timedTasks}/${totalTasks} 有耗时事实`, 'overview-stat'), tag(snapshot.active_task ? `Agent CLI：${snapshot.active_task.task_id} · ${taskLifecycleName(snapshot.active_task)}${activeBelongsToWave ? ` · ${activeWave.wave_id}` : ' · 未归属波次'}` : 'Agent CLI：当前空闲', `overview-stat${activeUnassigned ? ' unassigned' : ''}`));
  elements.workflow.append(overview);
  appendAntdEmpty(elements.workflow, activeWave ? `选择 ${activeWave.wave_id} 查看当前波次` : '从左侧选择一个波次', '右侧只呈现所选波次的 Task 依赖、状态和耗时，避免重复铺开全部 H。', activeWave ? `打开 ${activeWave.wave_id}` : '', activeWave ? () => openWave(activeWave.wave_id) : undefined);
}

function renderFocusedWaveWorkflow() {
  elements.workflow.replaceChildren();
  const wave = snapshot.waves.find((item) => item.wave_id === selectedWaveId);
  if (!wave) { goPortfolio(); return; }
  renderWaveSelector(); renderBreadcrumb();
  const activeTask = snapshot.active_task && wave.task_ids.includes(snapshot.active_task.task_id) ? snapshot.active_task : null;
  elements.workflowHeading.textContent = `${waveName(wave)} · 波次执行图`;
  elements.workflowCaption.textContent = activeTask
    ? `当前 ${activeTask.task_id} · Round ${activeTask.round} · ${lifecycleName(activeTask.lifecycle)}；完整展示本波次 Task 依赖与并行关系`
    : `${wave.completed_tasks}/${wave.task_total} 个 Task 完成；完整展示本波次 Task 依赖与并行关系`;
  updateWorkflowControls({ backVisible: false, source: '波次 Task DAG · 左到右执行' });

  const overview = document.createElement('section'); overview.className = 'focused-wave-overview';
  const identity = document.createElement('div'); identity.className = 'focused-wave-identity';
  identity.append(text('span', 'section-kicker', 'CURRENT WAVE'), text('strong', '', waveName(wave)), text('p', '', wave.summary));
  overview.append(
    identity,
    tag(`${wave.completed_tasks}/${wave.task_total} Task 完成`, 'wave-fact'),
    tag(`${wave.managed_tasks}/${wave.task_total} 有运行档案`, 'wave-fact'),
    tag(wave.heavy_task_ids.length ? `Heavy：${wave.heavy_task_ids.join('、')}` : '无独立 Heavy', 'wave-fact'),
    tag(activeTask ? `当前：${activeTask.task_id}` : waveProgressLabel(wave), activeTask ? 'wave-fact current' : 'wave-fact'),
  );
  elements.workflow.append(overview);

  if (!wave.task_ids.length) {
    appendAntdEmpty(elements.workflow, `${wave.wave_id} 暂无关联 Task`, '规格中没有这个波次的 Task 关系，因此无法绘制波次执行图。'); return;
  }

  const graphWrap = document.createElement('section'); graphWrap.className = 'focused-wave-graph';
  const graphHeading = document.createElement('div'); graphHeading.className = 'wave-lane-graph-heading';
  const graphMeta = document.createElement('div'); graphMeta.className = 'wave-graph-meta';
  const legend = document.createElement('span'); legend.className = 'wave-status-legend';
  legend.append(
    text('i', 'running', ''), document.createTextNode('当前'),
    text('i', 'done', ''), document.createTextNode('完成'),
    text('i', 'waiting', ''), document.createTextNode('等待'),
    text('i', 'pending', ''), document.createTextNode('未开始'),
  );
  graphMeta.append(text('span', 'workflow-direction', '执行方向 →　同列可并行'), legend);
  graphHeading.append(
    text('strong', '', 'Task 执行依赖'),
    graphMeta,
  );
  const canvas = document.createElement('div'); canvas.className = 'wave-lane-canvas focused-wave-canvas';
  graphWrap.append(graphHeading, canvas); elements.workflow.append(graphWrap); renderElkWaveGraph(wave, canvas);
  const expandedTask = snapshot.tasks.find((task) => task.task_id === expandedTaskId && wave.task_ids.includes(task.task_id));
  if (expandedTask) elements.workflow.append(renderInlineTaskDetail(expandedTask));
}

function waveTaskGraphLayout(wave) {
  const byId = new Map(snapshot.tasks.map((task) => [task.task_id, task]));
  const nodes = wave.task_ids.map((id) => byId.get(id)).filter(Boolean), nodeIds = new Set(nodes.map((task) => task.task_id));
  const depthMemo = new Map();
  function depth(task, visiting = new Set()) {
    if (depthMemo.has(task.task_id)) return depthMemo.get(task.task_id);
    if (visiting.has(task.task_id)) return 0;
    const nextVisiting = new Set(visiting).add(task.task_id);
    const dependencies = (task.depends_on ?? []).filter((id) => nodeIds.has(id)).map((id) => nodes.find((item) => item.task_id === id));
    const value = dependencies.length ? Math.max(...dependencies.map((item) => depth(item, nextVisiting))) + 1 : 0;
    depthMemo.set(task.task_id, value); return value;
  }
  for (const task of nodes) depth(task);
  const levels = new Map();
  for (const task of nodes) {
    const level = depthMemo.get(task.task_id);
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(task);
  }
  const orderedLevels = [...levels.entries()].sort((a, b) => a[0] - b[0]);
  const order = new Map();
  for (const [, tasks] of orderedLevels) {
    tasks.sort((left, right) => {
      const leftParents = (left.depends_on ?? []).filter((id) => order.has(id)), rightParents = (right.depends_on ?? []).filter((id) => order.has(id));
      const leftCenter = leftParents.length ? leftParents.reduce((sum, id) => sum + order.get(id), 0) / leftParents.length : Number.POSITIVE_INFINITY;
      const rightCenter = rightParents.length ? rightParents.reduce((sum, id) => sum + order.get(id), 0) / rightParents.length : Number.POSITIVE_INFINITY;
      return leftCenter - rightCenter || left.task_id.localeCompare(right.task_id);
    });
    tasks.forEach((task, index) => order.set(task.task_id, index));
  }
  const nodeWidth = 232, nodeHeight = 88, horizontalGap = 34, levelGap = 72;
  const maxNodes = Math.max(1, ...orderedLevels.map(([, tasks]) => tasks.length));
  const width = Math.max(920, maxNodes * nodeWidth + (maxNodes - 1) * horizontalGap + 96), positions = new Map();
  orderedLevels.forEach(([, tasks], row) => {
    const rowWidth = tasks.length * nodeWidth + (tasks.length - 1) * horizontalGap, start = (width - rowWidth) / 2;
    tasks.forEach((task, index) => positions.set(task.task_id, { x: start + index * (nodeWidth + horizontalGap), y: 30 + row * (nodeHeight + levelGap) }));
  });
  return { nodes, positions, width, height: 30 + Math.max(1, orderedLevels.length) * (nodeHeight + levelGap), nodeWidth, nodeHeight };
}

function openTaskWorkflow(taskId) {
  const taskWave = waveForTask(taskId);
  workflowSelectionInitialized = true; selectedTaskId = taskId; expandedTaskId = taskId; selectedWaveId = taskWave?.wave_id ?? null; taskWaveFilter = taskWave?.wave_id ?? 'unassigned'; workflowMode = taskWave ? 'wave' : 'portfolio'; portfolioHasLocated = true;
  renderWorkflow(); renderMetrics(); renderTasks(); renderDetails();
  requestAnimationFrame(() => document.getElementById(`inline-detail-${taskId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}

function renderWaveWorkflow() {
  elements.workflow.replaceChildren();
  const wave = snapshot.waves.find((item) => item.wave_id === selectedWaveId);
  if (!wave) { goPortfolio(); return; }
  renderWaveSelector(); renderBreadcrumb();
  elements.workflowHeading.textContent = `${wave.wave_id} · ${wave.title}`;
  elements.workflowCaption.textContent = `${wave.summary} · 从上到下按真实依赖分层`;
  updateWorkflowControls({ backVisible: true, backLabel: '返回波次总览', source: '子 Task DAG · 从规格依赖重建' });
  const overview = document.createElement('div'); overview.className = 'wave-overview';
  const statusConflict = wave.declared_status === 'delivered' && wave.status !== 'delivered';
  const waveTaskIds = new Set(wave.task_ids), externalDependencies = [...new Set(wave.task_ids.flatMap((id) => snapshot.tasks.find((task) => task.task_id === id)?.depends_on ?? []).filter((id) => !waveTaskIds.has(id)))];
  overview.append(text('div', 'wave-overview-main', `本波次目标：${wave.summary}`), tag(`当前位置：${waveProgressLabel(wave)}`, `wave-fact ${statusConflict ? 'conflict' : ''}`), tag(`${wave.completed_tasks}/${wave.task_total} 个 Task 完成`, 'wave-fact'), tag(`${wave.managed_tasks} 个有运行档案`, 'wave-fact'), tag(wave.heavy_task_ids.length ? `Heavy 收口：${wave.heavy_task_ids.join('、')}` : '定向收口：无独立 Heavy', 'wave-fact'), tag(wave.task_wall_clock_ms === null ? '总耗时：待采集' : `Task 跨度合计：${duration(wave.task_wall_clock_ms)}`, 'wave-fact'));
  if (externalDependencies.length) overview.append(tag(`外部前置：${externalDependencies.join('、')}`, 'wave-fact'));
  if (statusConflict) overview.append(text('div', 'wave-status-conflict', `状态冲突：路线图写着已完成，但 ${wave.unfinished_task_ids.join('、')} 仍未完成，因此本波次不能显示为绿色。`));
  elements.workflow.append(overview);
  if (!wave.task_ids.length) { appendAntdEmpty(elements.workflow, '该波次尚未关联可展示的 Task 规格'); return; }
  const graph = waveTaskGraphLayout(wave), canvas = document.createElement('div'); canvas.className = 'workflow-canvas task-graph-canvas';
  const svg = svgElement('svg', { class: 'workflow-dag task-dag', viewBox: `0 0 ${graph.width} ${graph.height}`, role: 'img', 'aria-label': `${wave.wave_id} 子任务依赖图` }); appendArrowDefinition(svg, 'task-arrow');
  const edges = svgElement('g', { class: 'dag-edges' });
  const nodeIds = new Set(graph.nodes.map((task) => task.task_id)), outgoing = new Map();
  for (const task of graph.nodes) for (const dependencyId of task.depends_on ?? []) if (nodeIds.has(dependencyId)) {
    if (!outgoing.has(dependencyId)) outgoing.set(dependencyId, []);
    outgoing.get(dependencyId).push(task.task_id);
  }
  for (const task of graph.nodes) for (const dependencyId of task.depends_on ?? []) {
    const from = graph.positions.get(dependencyId), to = graph.positions.get(task.task_id); if (!from || !to) continue;
    const internalDependencies = (task.depends_on ?? []).filter((id) => nodeIds.has(id)).sort(), dependencyIndex = internalDependencies.indexOf(dependencyId);
    const dependents = [...(outgoing.get(dependencyId) ?? [])].sort(), dependentIndex = dependents.indexOf(task.task_id);
    const startX = from.x + graph.nodeWidth * (dependentIndex + 1) / (dependents.length + 1), startY = from.y + graph.nodeHeight;
    const endX = to.x + graph.nodeWidth * (dependencyIndex + 1) / (internalDependencies.length + 1), endY = to.y, middleY = (startY + endY) / 2;
    const dependency = graph.nodes.find((item) => item.task_id === dependencyId);
    const edgeState = dependency?.status === 'delivered' ? 'done' : dependency?.current ? 'active' : '';
    edges.append(svgElement('path', { d: `M${startX} ${startY} V${middleY} H${endX} V${endY}`, class: `dag-edge task-edge ${edgeState}`, 'marker-end': 'url(#task-arrow)' }));
  }
  svg.append(edges);
  const nodes = svgElement('g', { class: 'task-nodes' });
  for (const task of graph.nodes) {
    const internalDependencies = (task.depends_on ?? []).map((id) => graph.nodes.find((item) => item.task_id === id)).filter(Boolean);
    const dependencyIncomplete = task.blocked_by?.length || internalDependencies.some((dependency) => !['delivered', 'cancelled'].includes(dependency.status));
    const position = graph.positions.get(task.task_id), state = dependencyIncomplete ? 'waiting' : task.current ? 'active' : task.status === 'delivered' ? 'done' : task.status === 'working' ? 'active' : task.status === 'draft' ? 'pending' : 'waiting';
    const isWaveHeavy = wave.heavy_task_ids.includes(task.task_id);
    const group = svgElement('g', { class: `dag-node task-node ${state}${isWaveHeavy ? ' heavy' : ''}`, transform: `translate(${position.x} ${position.y})`, role: 'button', tabindex: '0', 'aria-label': `${task.task_id} ${task.title}，${taskLifecycleName(task)}，点击查看步骤` });
    group.append(svgElement('rect', { class: 'dag-node-surface', width: graph.nodeWidth, height: graph.nodeHeight, rx: '10' }));
    group.append(svgElement('rect', { class: 'dag-node-accent', width: '4', height: graph.nodeHeight - 20, x: '0', y: '10', rx: '2' }));
    appendDagText(group, 'dag-role', 12, 18, `${isWaveHeavy ? 'HEAVY 收口' : task.task_id.startsWith('WEB-') ? 'WEB TASK' : 'TASK'} · ${task.task_id}`);
    appendDagText(group, 'dag-label', 12, 39, task.title.length > 16 ? `${task.title.slice(0, 16)}…` : task.title);
    appendDagText(group, 'dag-hint', 12, 58, dependencyIncomplete ? `等待 ${task.blocked_by?.join('、') || '前置任务'}` : task.managed ? `${taskLifecycleName(task)} · Round ${task.round}` : `${taskLifecycleName(task)} · 仅规格记录`);
    appendDagText(group, 'dag-duration', 12, 77, task.managed ? `${totalTaskLabel(task)} · 主动 ${duration(task.active_ms)}` : '耗时待采集');
    const stateIcon = svgElement('g', { class: 'dag-state-icon', transform: `translate(${graph.nodeWidth - 16} 16)` }); stateIcon.append(svgElement('circle', { r: '8' }));
    const glyph = appendDagText(stateIcon, 'dag-state-glyph', 0, 3, state === 'done' ? '✓' : state === 'active' ? '●' : ''); glyph.setAttribute('text-anchor', 'middle'); group.append(stateIcon);
    group.addEventListener('click', () => openTaskWorkflow(task.task_id));
    group.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTaskWorkflow(task.task_id); } });
    nodes.append(group);
  }
  svg.append(nodes); canvas.append(svg); elements.workflow.append(canvas);
}

function renderTaskWorkflow() {
  elements.workflow.replaceChildren();
  const activeTask = snapshot.tasks.find((task) => task.task_id === selectedTaskId) ?? snapshot.tasks.find((task) => task.task_id === snapshot.active_task?.task_id) ?? null;
  if (!activeTask) { goPortfolio(); return; }
  selectedWaveId = waveForTask(activeTask.task_id)?.wave_id ?? selectedWaveId; renderWaveSelector(); renderBreadcrumb(activeTask);
  elements.workflowHeading.textContent = `${activeTask.task_id} · 步骤 DAG`;
  elements.workflowCaption.textContent = `${activeTask.title} · ${lifecycleName(activeTask.status)} · Round ${activeTask.round}`;
  updateWorkflowControls({ backVisible: true, backLabel: selectedWaveId ? `返回 ${selectedWaveId} 子 Task` : '返回波次总览' });
  const activeStep = activeTask.steps.filter((step) => step.status === 'running' || step.status === 'waiting').sort((left, right) => (right.started_at ?? '').localeCompare(left.started_at ?? ''))[0] ?? null;
  const fallbackStage = ({ draft: 'intake', planned: 'prepare', working: 'maker', verifying: 'verify', iterating: 'triage', delivered: 'deliver' })[activeTask.status];
  const activeStage = activeStep ? stageForType(activeStep.type) : fallbackStage;
  const hasLiveEvent = Boolean(activeStep);
  updateWorkflowControls({ source: hasLiveEvent ? '实时纵向 DAG · 每秒同步' : '纵向状态投影 · 等待步骤事件' });

  const inlineBack = document.createElement('div'); inlineBack.className = 'workflow-inline-back';
  mountButton(inlineBack, { label: selectedWaveId ? `返回 ${selectedWaveId} 子 Task 图` : '返回全部波次总览', icon: null }, () => { if (selectedWaveId) openWave(selectedWaveId); else goPortfolio(); });
  elements.workflow.append(inlineBack, renderInlineTaskDetail(activeTask));
  const hasWorkflowEvents = activeTask.steps.some((step) => step.source === 'EXECUTION_EVENTS.jsonl');
  if (!hasWorkflowEvents) {
    updateWorkflowControls({ source: activeTask.managed ? '历史状态·无原生执行事件' : '仅规格与交付状态' });
    const message = activeTask.status === 'delivered'
      ? '该 Task 已完成，但历史数据没有 Event Log / Run：耗时未记录，不生成虚构 Workflow。'
      : '该 Task 尚无 Event Log / Run：仅展示规格状态，不将其投影为已启动的 Workflow。';
    elements.workflow.append(text('div', 'inline-empty', message));
    return;
  }

  const legend = document.createElement('div');
  legend.className = 'workflow-legend';
  legend.append(tag('人 · 授权验收', 'dag-legend human'), tag('Spec-Loop · 确定性控制', 'dag-legend system'), tag('Agent CLI · 角色执行', 'dag-legend agent'), tag('虚线 · 失败分支', 'dag-legend failure'));
  const canvas = document.createElement('div');
  canvas.className = 'workflow-canvas';
  const svg = svgElement('svg', { class: 'workflow-dag', viewBox: '0 0 1180 1030', role: 'img', 'aria-labelledby': 'workflow-dag-title workflow-dag-desc' });
  const titleNode = svgElement('title', { id: 'workflow-dag-title' }); titleNode.textContent = 'Task 内部步骤有向无环执行图';
  const descNode = svgElement('desc', { id: 'workflow-dag-desc' }); descNode.textContent = '执行从上向下推进，在收集候选后左右分为命令 Gate 和浏览器 Gate，经过人工确认后在独立验证处汇合。验证通过进入交付，失败进入 Triage，并生成新的 revision。';
  const defs = svgElement('defs');
  const arrow = svgElement('marker', { id: 'dag-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
  arrow.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'dag-arrow-head' }));
  const failureArrow = svgElement('marker', { id: 'dag-arrow-failure', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' });
  failureArrow.append(svgElement('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'dag-arrow-head failure' }));
  defs.append(arrow, failureArrow); svg.append(titleNode, descNode, defs);

  const states = new Map(workflowStages.map((stage) => [stage.key, workflowStageState(stage, activeTask, activeStage)]));
  const edgeLayer = svgElement('g', { class: 'dag-edges' });
  for (const edge of workflowEdges) {
    const fromState = states.get(edge.from).state, toState = states.get(edge.to).state;
    const live = !edge.failure && (fromState === 'active' || toState === 'active' || toState === 'waiting');
    const done = !edge.failure && fromState === 'done' && toState === 'done';
    const failureLive = edge.failure && (fromState === 'failed' || toState === 'active');
    const path = svgElement('path', {
      d: edge.path,
      class: `dag-edge${edge.failure ? ' failure' : ''}${done ? ' done' : ''}${live ? ' active' : ''}${failureLive ? ' active-failure' : ''}`,
      'marker-end': `url(#${edge.failure ? 'dag-arrow-failure' : 'dag-arrow'})`,
    });
    edgeLayer.append(path);
    if (edge.label) appendDagText(edgeLayer, `dag-edge-label${edge.failure ? ' failure' : ''}`, edge.lx, edge.ly, edge.label);
  }
  svg.append(edgeLayer);

  const nodeLayer = svgElement('g', { class: 'dag-nodes' });
  for (const stage of workflowStages) {
    const stageState = states.get(stage.key);
    const group = svgElement('g', {
      class: `dag-node actor-${stage.actor} ${stageState.state}`,
      transform: `translate(${stage.x} ${stage.y})`,
      role: 'group',
      'aria-label': `${stage.role}，${stage.label}，${statusName(stageState.state === 'done' ? 'succeeded' : stageState.state === 'active' ? 'running' : stageState.state)}`,
    });
    group.append(svgElement('rect', { class: 'dag-node-surface', width: workflowNodeWidth, height: workflowNodeHeight, rx: '10' }));
    group.append(svgElement('rect', { class: 'dag-node-accent', width: '4', height: workflowNodeHeight - 20, x: '0', y: '10', rx: '2' }));
    appendDagText(group, 'dag-role', 14, 20, stage.role);
    appendDagText(group, 'dag-label', 14, 43, stage.label);
    appendDagText(group, 'dag-hint', 14, 60, stage.hint);
    const durationLabel = appendDagText(group, 'dag-duration', 14, 77, stageDuration(stageState));
    if (stageState.state === 'active' && activeTask.task_id === snapshot.active_task?.task_id && snapshot.active_task?.step_started_at) durationLabel.setAttribute('data-active-node-duration', '');
    const stateIcon = svgElement('g', { class: 'dag-state-icon', transform: 'translate(203 17)' });
    stateIcon.append(svgElement('circle', { r: '9' }));
    const stateGlyph = appendDagText(stateIcon, 'dag-state-glyph', 0, 3, stageState.state === 'done' ? '✓' : stageState.state === 'failed' ? '!' : stageState.state === 'waiting' ? 'Ⅱ' : stageState.state === 'active' ? '●' : '');
    stateGlyph.setAttribute('text-anchor', 'middle');
    group.append(stateIcon); nodeLayer.append(group);
  }
  svg.append(nodeLayer); canvas.append(svg); elements.workflow.append(legend, canvas);
  tickElapsed();
}

function renderWorkflow() {
  if (selectedWaveId) renderFocusedWaveWorkflow();
  else if (expandedTaskId) renderTaskWorkflow();
  else renderPortfolioWorkflow();
}

function renderMetrics() {
  const metricTaskId = expandedTaskId ?? snapshot.active_task?.task_id;
  const task = liveTaskTiming(metricTaskId ? snapshot.tasks.find((item) => item.task_id === metricTaskId) : null);
  const wave = liveWaveTiming(!expandedTaskId && selectedWaveId ? snapshot.waves.find((item) => item.wave_id === selectedWaveId) : null);
  const observedActive = wave ? (wave.timed_tasks ? wave.active_ms : null) : task && (task.active_ms > 0 || task.timing_precision !== 'unknown') ? task.active_ms : null;
  const observedWaiting = wave ? (wave.timed_tasks ? wave.waiting_ms : null) : task && (task.waiting_ms > 0 || task.timing_precision !== 'unknown') ? task.waiting_ms : null;
  const timingNote = wave ? `${wave.timed_tasks} / ${wave.task_total} 个 Task 有耗时事实；跨度可能重叠` : task ? 'Task 开始至今；可与其他 Task 重叠，不能相加为工时' : '无活动任务';
  const metrics = [
    { key: 'span', label: wave ? 'Task 生命周期跨度合计' : '生命周期跨度', value: duration(wave?.task_wall_clock_ms ?? task?.wall_clock_ms ?? null), note: timingNote, color: 'var(--primary)' },
    { key: 'active', label: '主动执行', value: duration(observedActive), note: '已扣除等待重叠', color: 'var(--success)' },
    { key: 'waiting', label: '等待时间', value: duration(observedWaiting), note: '用户 / Review / 授权', color: 'var(--warning)' },
    { key: 'coverage', label: wave ? '耗时覆盖' : '未归因 / 空闲', value: wave ? `${wave.timed_tasks}/${wave.task_total}` : duration(task?.untracked_ms ?? null), note: wave ? timingNote : '没有活动事件覆盖，可能是空闲或历史漏记', color: 'var(--danger)' },
  ];
  callAntd('updateWaveMetrics', [{ metrics }]);
}

function updateTrackSpace(space, task) {
  if (task.wall_clock_ms === null) {
    if (!space.querySelector('.unknown-track')) space.replaceChildren(text('span', 'unknown-track', '耗时未知'));
    return;
  }
  let track = space.querySelector('.duration-composition-track');
  if (!track) { track = document.createElement('span'); track.className = 'track duration-composition-track'; space.replaceChildren(track); }
  const total = Math.max(1, task.wall_clock_ms), pieces = [
    ['active', task.active_ms, '已记录主动执行'], ['waiting', task.waiting_ms, '已记录等待'], ['untracked', task.untracked_ms ?? 0, '未归因 / 空闲'],
  ];
  for (const [kind, value, label] of pieces) {
    let segment = track.querySelector(`[data-duration-kind="${kind}"]`);
    if (!segment) { segment = document.createElement('i'); segment.className = `duration-segment ${kind}`; segment.dataset.durationKind = kind; track.append(segment); }
    segment.hidden = !value; segment.style.width = value ? `${value / total * 100}%` : '0'; segment.title = `${label} · ${duration(value)}`;
  }
}

function renderTrack(task) {
  const space = document.createElement('span'); space.className = 'track-space';
  updateTrackSpace(space, task); return space;
}

function filteredTasks() {
  const waveTaskIds = taskWaveFilter && !['all', 'unassigned'].includes(taskWaveFilter)
    ? new Set(snapshot.waves.find((wave) => wave.wave_id === taskWaveFilter)?.task_ids ?? []) : null;
  const assignedIds = new Set(snapshot.waves.flatMap((wave) => wave.task_ids));
  const tasks = snapshot.tasks.filter((task) => taskMatchesFilter(task)
    && (taskWaveFilter === 'unassigned' ? !assignedIds.has(task.task_id) : waveTaskIds ? waveTaskIds.has(task.task_id) : true));
  if (taskSort === 'duration-desc') tasks.sort((left, right) => (right.wall_clock_ms ?? -1) - (left.wall_clock_ms ?? -1));
  return tasks;
}

function renderTaskWaveSelector() {
  const assignedIds = new Set(snapshot.waves.flatMap((wave) => wave.task_ids));
  const unassignedCount = snapshot.tasks.filter((task) => !assignedIds.has(task.task_id)).length;
  const activeWave = waveForTask(snapshot.active_task?.task_id);
  if (taskWaveFilter === null) taskWaveFilter = activeWave?.wave_id ?? (snapshot.active_task ? 'unassigned' : 'all');
  callAntd('updateTasks', [{
    waveOptions: [
      { value: 'all', label: `全部波次 · ${snapshot.tasks.length} Task（分组）` },
      ...snapshot.waves.map((wave) => ({
        value: wave.wave_id,
        label: `${waveName(wave)} · ${wave.task_total} Task${wave.wave_id === activeWave?.wave_id ? '（当前）' : ''}`,
      })),
      { value: 'unassigned', label: `未归属波次 · ${unassignedCount} Task${snapshot.active_task && !activeWave ? '（当前）' : ''}` },
    ],
    waveValue: taskWaveFilter,
    sortValue: taskSort,
    filterValue: taskFilter,
    locateDisabled: !snapshot.active_task,
  }]);
}

function taskGroups(tasks) {
  if (taskWaveFilter !== 'all') {
    const wave = snapshot.waves.find((item) => item.wave_id === taskWaveFilter);
    return [{ id: taskWaveFilter, label: wave ? waveName(wave) : '未归属波次', tasks }];
  }
  const taskSet = new Set(tasks.map((task) => task.task_id)), groups = snapshot.waves
    .map((wave) => ({ id: wave.wave_id, label: waveName(wave), tasks: tasks.filter((task) => wave.task_ids.includes(task.task_id)) }))
    .filter((group) => group.tasks.length);
  const assigned = new Set(snapshot.waves.flatMap((wave) => wave.task_ids));
  const unassigned = snapshot.tasks.filter((task) => taskSet.has(task.task_id) && !assigned.has(task.task_id));
  if (unassigned.length) groups.push({ id: 'unassigned', label: '未归属波次', tasks: unassigned });
  return groups;
}

function renderTasks() {
  elements.taskList.replaceChildren();
  renderTaskWaveSelector();
  const tasks = filteredTasks();
  const selectedWave = snapshot.waves.find((wave) => wave.wave_id === taskWaveFilter);
  const scopeLabel = selectedWave ? waveName(selectedWave) : taskWaveFilter === 'unassigned' ? '未归属波次' : '全部波次';
  elements.taskSummary.textContent = `${scopeLabel} · ${tasks.length} 个 Task · 点击查看步骤与证据`;
  if (!selectedTaskId || !snapshot.tasks.some((task) => task.task_id === selectedTaskId)) selectedTaskId = snapshot.active_task?.task_id ?? snapshot.tasks[0]?.task_id ?? null;
  if (!tasks.length) { appendAntdEmpty(elements.taskList, '这个筛选条件下没有 Task'); return; }
  for (const group of taskGroups(tasks)) {
    const wave = snapshot.waves.find((item) => item.wave_id === group.id);
    const heading = document.createElement('div'); heading.className = `task-wave-heading${group.id === 'unassigned' ? ' unassigned' : ''}`;
    heading.dataset.waveId = group.id;
    heading.append(text('strong', '', group.label), text('span', '', wave ? `${wave.completed_tasks}/${wave.task_total} 完成 · ${waveProgressLabel(wave)}` : `${group.tasks.length} 个 Task · 需要补充波次归属`));
    elements.taskList.append(heading);
    for (const task of group.tasks) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'task-row'; button.dataset.taskId = task.task_id;
      button.setAttribute('aria-selected', String(task.task_id === selectedTaskId));
      const identity = document.createElement('span'); identity.className = 'task-identity';
      const idLine = document.createElement('span'); idLine.className = 'task-id-line';
      idLine.append(text('span', 'task-id', task.task_id), text('span', `task-state ${taskStateClass(task)}`, taskLifecycleName(task)), text('span', 'task-wave-chip', task.protocol === 'v2' ? `v2 · ${task.acceptance?.stage ?? '未启动'}` : 'v1'), text('span', 'task-wave-chip', recordKindLabel(task)));
      if (taskWaveFilter === 'all') idLine.append(text('span', `task-wave-chip${group.id === 'unassigned' ? ' unassigned' : ''}`, group.id === 'unassigned' ? '未归属波次' : group.id));
      identity.append(idLine, text('span', 'task-title', task.title));
      const metrics = document.createElement('span'); metrics.className = 'task-metrics';
      metrics.append(text('strong', '', totalTaskLabel(task)), text('span', '', taskTimingBreakdownLabel(task)));
      button.append(identity, renderTrack(task), metrics);
      button.addEventListener('click', () => openTaskWorkflow(task.task_id));
      elements.taskList.append(button);
    }
  }
}

function renderDetails() {
  const task = snapshot.tasks.find((item) => item.task_id === selectedTaskId);
  if (!task) {
    callAntd('updateTaskInspector', [{ task: null }]); return;
  }
  callAntd('updateTaskInspector', [{ task: {
    title: `${task.task_id} · 第 ${task.round} 轮`, status: taskStateClass(task), statusLabel: taskLifecycleName(task),
    metrics: [
      { key: 'protocol', label: '执行协议', children: task.protocol === 'v2' ? `P/M/V/R v2 · ${task.acceptance?.stage ?? '未启动'}` : 'v1 兼容流程' },
      { key: 'fresh', label: 'v2 绑定新鲜度', children: task.acceptance ? (task.acceptance.fresh ? '当前有效' : '异常') : '不适用' },
      { key: 'head', label: '候选 HEAD', children: task.acceptance?.head?.slice(0, 12) ?? '未形成' },
      { key: 'roles', label: '角色 invocation', children: task.acceptance ? `M ${task.acceptance.last_m_invocation ? '✓' : '—'} / V ${task.acceptance.last_v_invocation ? '✓' : '—'} / R ${task.acceptance.last_r_invocation ? '✓' : '—'}` : '不适用' },
      { key: 'runtime', label: '实时角色进度', children: runtimeLabel(task.runtime) },
      { key: 'record', label: '运行档案口径', children: recordKindLabel(task) },
      { key: 'budget', label: '返工 / 基础设施预算', children: task.acceptance ? `${task.acceptance.semantic_reworks_used}/2 · V${task.acceptance.infrastructure_retries.V} R${task.acceptance.infrastructure_retries.R}` : '不适用' },
      { key: 'conflict', label: 'Conflict / Candidate', children: task.acceptance?.active_conflict_id ?? task.acceptance?.candidate_id ?? '无' },
      { key: 'span', label: '生命周期跨度', children: duration(task.wall_clock_ms) },
      { key: 'active', label: '主动执行', children: duration(task.active_ms) },
      { key: 'waiting', label: '等待', children: duration(task.waiting_ms) },
      { key: 'untracked', label: '未归因 / 空闲', children: duration(task.untracked_ms) },
      { key: 'round', label: '轮次未拆分', children: duration(task.round_unattributed_ms) },
      { key: 'overlap', label: '计时口径', children: '可与其他 Task 重叠' },
    ],
    steps: task.steps.map((step) => ({
      label: step.label, duration: duration(step.duration_ms), summary: step.summary, status: step.status,
      statusLabel: statusName(step.status), precision: precisionName(step.precision), timeRange: timeRange(step), source: step.source,
      bottleneck: step.id === task.bottleneck_step_id, refs: step.refs,
    })),
    diagnostics: task.diagnostics,
  } }]);
}

function renderDiagnostics() {
  elements.projectDiagnostics.hidden = snapshot.diagnostics.length === 0;
  if (snapshot.diagnostics.length) mountAlert(elements.projectDiagnostics, { message: `数据完整性提示 · ${snapshot.diagnostics.length} 条`, descriptions: snapshot.diagnostics, collapsible: true });
}

function snapshotStructureSignature(value) {
  return JSON.stringify({
    project: value.project,
    waves: value.waves.map((wave) => ({ id: wave.wave_id, title: wave.title, summary: wave.summary, task_ids: wave.task_ids, heavy: wave.heavy_task_ids })),
    tasks: value.tasks.map((task) => ({ id: task.task_id, title: task.title, level: task.level, protocol:task.protocol, managed: task.managed, depends_on: task.depends_on, blocked_by: task.blocked_by })),
  });
}

function taskDetailSignature(task) {
  if (!task) return '';
  return JSON.stringify({
    status: task.status, protocol:task.protocol, acceptance:task.acceptance, blocked_by: task.blocked_by, round: task.round, wall: task.wall_clock_ms, active: task.active_ms, waiting: task.waiting_ms,
    untracked: task.untracked_ms, retry: task.retry_count, bottleneck: task.bottleneck_step_id,
    steps: task.steps.map((step) => [step.id, step.status, step.ended_at, step.duration_ms, step.summary]),
  });
}

function patchTaskList() {
  renderTaskWaveSelector();
  const tasks = filteredTasks(), groups = taskGroups(tasks), expectedIds = groups.flatMap((group) => group.tasks.map((task) => task.task_id));
  const rows = [...elements.taskList.querySelectorAll('.task-row')], visibleIds = rows.map((row) => row.dataset.taskId);
  if (expectedIds.join('|') !== visibleIds.join('|')) { renderTasks(); return; }
  const selectedWave = snapshot.waves.find((wave) => wave.wave_id === taskWaveFilter);
  const scopeLabel = selectedWave ? waveName(selectedWave) : taskWaveFilter === 'unassigned' ? '未归属波次' : '全部波次';
  elements.taskSummary.textContent = `${scopeLabel} · ${tasks.length} 个 Task · 点击查看步骤与证据`;
  for (const heading of elements.taskList.querySelectorAll('.task-wave-heading')) {
    const wave = snapshot.waves.find((item) => item.wave_id === heading.dataset.waveId), group = groups.find((item) => item.id === heading.dataset.waveId);
    const summary = heading.querySelector('span');
    if (summary) summary.textContent = wave ? `${wave.completed_tasks}/${wave.task_total} 完成 · ${waveProgressLabel(wave)}` : `${group?.tasks.length ?? 0} 个 Task · 需要补充波次归属`;
  }
  for (const row of rows) {
    const task = liveTaskTiming(snapshot.tasks.find((item) => item.task_id === row.dataset.taskId)); if (!task) continue;
    row.setAttribute('aria-selected', String(task.task_id === selectedTaskId));
    const state = row.querySelector('.task-state'); state.className = `task-state ${taskStateClass(task)}`; state.textContent = taskLifecycleName(task);
    row.querySelector('.task-title').textContent = task.title;
    row.querySelector('.task-metrics strong').textContent = totalTaskLabel(task);
    row.querySelector('.task-metrics span').textContent = taskTimingBreakdownLabel(task);
    updateTrackSpace(row.querySelector('.track-space'), task);
  }
}

function patchFocusedWave() {
  if (!selectedWaveId) return;
  const wave = snapshot.waves.find((item) => item.wave_id === selectedWaveId); if (!wave) return;
  const activeTask = snapshot.active_task && wave.task_ids.includes(snapshot.active_task.task_id) ? snapshot.active_task : null;
  elements.workflowHeading.textContent = `${waveName(wave)} · 波次执行图`;
  elements.workflowCaption.textContent = activeTask
    ? `当前 ${activeTask.task_id} · Round ${activeTask.round} · ${taskLifecycleName(activeTask)}；完整展示本波次 Task 依赖与并行关系`
    : `${wave.completed_tasks}/${wave.task_total} 个 Task 完成；完整展示本波次 Task 依赖与并行关系`;
  const facts = elements.workflow.querySelectorAll('.focused-wave-overview .wave-fact');
  const values = [
    `${wave.completed_tasks}/${wave.task_total} Task 完成`, `${wave.managed_tasks}/${wave.task_total} 有运行档案`,
    wave.heavy_task_ids.length ? `Heavy：${wave.heavy_task_ids.join('、')}` : '无独立 Heavy', activeTask ? `当前：${activeTask.task_id}` : waveProgressLabel(wave),
  ];
  facts.forEach((fact, index) => { fact.textContent = values[index] ?? fact.textContent; fact.classList.toggle('current', index === 3 && Boolean(activeTask)); });
  for (const node of elements.workflow.querySelectorAll('.lane-task-node[data-task-id]')) {
    const task = liveTaskTiming(snapshot.tasks.find((item) => item.task_id === node.dataset.taskId)); if (!task) continue;
    const state = taskNodeState(task, wave), isHeavy = wave.heavy_task_ids.includes(task.task_id), filterMuted = taskFilter !== 'all' && !taskMatchesFilter(task);
    node.setAttribute('class', `dag-node lane-task-node ${state}${isHeavy ? ' heavy' : ''}${task.task_id === expandedTaskId ? ' selected' : ''}${filterMuted ? ' filter-muted' : ''}`);
    const durationLabel = node.querySelector('.dag-duration');
    if (durationLabel) durationLabel.textContent = `${taskLifecycleName(task)} · ${totalTaskLabel(task)}`;
  }
  for (const edge of elements.workflow.querySelectorAll('.lane-edge[data-edge-from][data-edge-to]')) {
    const state = waveEdgeVisualState(wave, edge.dataset.edgeFrom, edge.dataset.edgeTo), markerState = state === 'done' ? 'done' : state === 'active' || state === 'ready' ? 'active' : 'base';
    edge.setAttribute('class', `dag-edge lane-edge ${state}`); edge.dataset.markerState = markerState; edge.setAttribute('marker-end', `url(#lane-arrow-${wave.wave_id}-${markerState})`);
  }
}

function patchLiveView(previousSnapshot) {
  elements.projectName.textContent = snapshot.project.name; root.classList.remove('error-state');
  renderCurrent(); renderMetrics(); patchWaveSidebar(); patchTaskList(); patchFocusedWave();
  const previousTask = previousSnapshot.tasks.find((task) => task.task_id === selectedTaskId), nextTask = snapshot.tasks.find((task) => task.task_id === selectedTaskId);
  if (taskDetailSignature(previousTask) !== taskDetailSignature(nextTask)) {
    renderDetails();
    const inline = nextTask && document.getElementById(`inline-detail-${nextTask.task_id}`);
    if (inline) inline.replaceWith(renderInlineTaskDetail(nextTask));
  }
  if (JSON.stringify(previousSnapshot.diagnostics) !== JSON.stringify(snapshot.diagnostics)) renderDiagnostics();
  updateFreshness(); callAntd('updateLayout', [{ error: null }]);
}

function tickLiveNumbers() {
  if (!snapshot) return;
  renderMetrics(); patchWaveSidebar();
  for (const row of elements.taskList.querySelectorAll('.task-row[data-task-id]')) {
    const task = liveTaskTiming(snapshot.tasks.find((item) => item.task_id === row.dataset.taskId)); if (!task) continue;
    const total = row.querySelector('.task-metrics strong'), detail = row.querySelector('.task-metrics span'), track = row.querySelector('.track-space');
    if (total) total.textContent = totalTaskLabel(task);
    if (detail) detail.textContent = taskTimingBreakdownLabel(task);
    if (track) updateTrackSpace(track, task);
  }
  for (const node of elements.workflow.querySelectorAll('.lane-task-node[data-task-id]')) {
    const task = liveTaskTiming(snapshot.tasks.find((item) => item.task_id === node.dataset.taskId)); if (!task) continue;
    const label = node.querySelector('.dag-duration'); if (label) label.textContent = `${taskLifecycleName(task)} · ${totalTaskLabel(task)}`;
  }
}

function render() {
  elements.projectName.textContent = snapshot.project.name;
  root.classList.remove('error-state');
  if (!workflowSelectionInitialized) {
    const activeWave = defaultWave();
    if (activeWave) { selectedWaveId = activeWave.wave_id; workflowMode = 'wave'; taskWaveFilter = activeWave.wave_id; }
    workflowSelectionInitialized = true;
  }
  renderCurrent(); renderWaveSidebar(); renderWorkflow(); renderMetrics(); renderTasks(); renderDetails(); renderDiagnostics(); updateFreshness();
  callAntd('updateLayout', [{ error: null }]);
}

function relativeTime(timestamp) {
  if (!timestamp) return '尚未检查';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return seconds < 2 ? '刚刚' : seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
}

function updateFreshness() {
  if (!lastCheckedAt) return;
  elements.connectionLabel.textContent = '本地实时连接';
  elements.freshness.textContent = lastPollChanged
    ? `${relativeTime(lastChangedAt)}更新 · ${relativeTime(lastCheckedAt)}检查`
    : `${relativeTime(lastCheckedAt)}检查 · 事实无变化`;
}

async function refresh() {
  const requestedProjectKey = selectedProjectKey;
  try {
    const headers = etag ? { 'If-None-Match': etag } : {};
    const response = await fetch(`/api/snapshot?project=${encodeURIComponent(requestedProjectKey)}`, { headers, cache: 'no-store' });
    if (requestedProjectKey !== selectedProjectKey) return;
    lastCheckedAt = Date.now();
    if (response.status === 304) { lastPollChanged = false; root.classList.remove('error-state', 'project-switching'); callAntd('updateLayout', [{ switching: false, error: null }]); updateFreshness(); return; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const nextEtag = response.headers.get('etag');
    const nextSnapshot = await response.json(), previousSnapshot = snapshot;
    if (previousSnapshot && nextSnapshot.revision === previousSnapshot.revision) {
      etag = nextEtag ?? etag; lastPollChanged = false; root.classList.remove('error-state', 'project-switching'); callAntd('updateLayout', [{ switching: false, error: null }]); updateFreshness(); return;
    }
    lastPollChanged = true; etag = nextEtag ?? nextSnapshot.revision;
    lastChangedAt = lastCheckedAt;
    snapshot = nextSnapshot; root.classList.remove('project-switching'); callAntd('updateLayout', [{ switching: false, error: null }]);
    try {
      if (previousSnapshot && snapshotStructureSignature(previousSnapshot) === snapshotStructureSignature(nextSnapshot)) patchLiveView(previousSnapshot);
      else render();
    }
    catch (renderError) {
      snapshot = previousSnapshot;
      if (previousSnapshot) render();
      throw renderError;
    }
  } catch (error) {
    if (requestedProjectKey !== selectedProjectKey) return;
    callAntd('updateLayout', [{ switching: false, error: error.message }]);
    root.classList.add('error-state'); elements.connectionLabel.textContent = '连接异常'; elements.freshness.textContent = '本次刷新失败 · 页面保留上一帧';
  }
}

window.addEventListener('spec-loop:task-filter-change', (event) => {
  taskFilter = event.detail.value; updateTaskControls(); renderTasks(); renderWorkflow();
});
window.addEventListener('spec-loop:task-wave-change', (event) => { taskWaveFilter = event.detail.value; updateTaskControls(); renderTasks(); });
window.addEventListener('spec-loop:task-sort-change', (event) => { taskSort = event.detail.value; updateTaskControls(); renderTasks(); });
window.addEventListener('spec-loop:project-change', (event) => { switchProject(event.detail.value); });
window.addEventListener('spec-loop:locate-current', () => {
  const currentId = snapshot?.active_task?.task_id;
  if (!currentId) return;
  const activeWave = waveForTask(currentId);
  taskWaveFilter = activeWave?.wave_id ?? 'unassigned'; selectedWaveId = activeWave?.wave_id ?? null; workflowMode = activeWave ? 'wave' : 'portfolio';
  selectedTaskId = currentId; expandedTaskId = null; renderWorkflow(); renderMetrics(); renderTasks(); renderDetails(); patchWaveSidebar();
  requestAnimationFrame(() => elements.taskList.querySelector(`[data-task-id="${CSS.escape(currentId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
});

window.addEventListener('spec-loop:wave-change', (event) => { if (event.detail.value) openWave(event.detail.value); else goPortfolio(); });
window.addEventListener('spec-loop:workflow-back', goPortfolio);
window.addEventListener('spec-loop:antd-ready', () => {
  updateProjectControls(false);
  updateWorkflowControls();
  updateTaskControls();
  if (!snapshot) return;
  render();
});

setInterval(refresh, 2000);
setInterval(loadProjects, 10_000);
setInterval(() => { tickElapsed(); tickLiveNumbers(); updateFreshness(); }, 1000);
loadProjects().then(refresh);
