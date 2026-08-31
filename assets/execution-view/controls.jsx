import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert,
  Badge,
  Breadcrumb,
  Button,
  ConfigProvider,
  Empty,
  Segmented,
  Select,
  Space,
  Tag,
  Tooltip,
  theme,
} from 'antd';
import { AimOutlined, ApartmentOutlined, LeftOutlined } from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';

const nonce = document.querySelector('meta[name="csp-nonce"]')?.content;
const roots = new Map();
const latestControlState = new Map();
const controlListeners = new Map();

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
        token: { colorPrimary: '#1677ff', borderRadius: 7, controlHeight: 30, fontSize: 12 },
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
    options: [{ label: '全部波次总览', value: '' }],
    value: '',
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

function renderInto(host, node) {
  let mounted = roots.get(host);
  if (!mounted) {
    mounted = createRoot(host);
    roots.set(host, mounted);
  }
  mounted.render(<AntdShell>{node}</AntdShell>);
}

function mountStatic(id, node) {
  const host = document.getElementById(id);
  if (host) renderInto(host, node);
}

window.ExecutionAntd = {
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
  mountAlert(host, { message, descriptions, type = 'warning' }) {
    const description = Array.isArray(descriptions)
      ? <ul>{descriptions.map((item) => <li key={item}>{item}</li>)}</ul>
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

// Publish the bridge before mounting static controls. The data view can still
// render through the bridge if one of the toolbar roots fails to initialize.
mountStatic('workflow-controls', <WorkflowControls />);
mountStatic('task-controls', <TaskControls />);

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
