/**
 * Panel SDK v1:插件页面与主面板共享同一个 Vue 实例、同一套视觉组件与鉴权。
 *
 * 契约稳定性:这里导出的名字是插件可依赖的 API。新增只做加法,破坏性变更必须提升
 * manifest.schemaVersion。插件页面不要直接 import 主面板内部文件,只用这里。
 */
export {
  computed,
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch,
} from "/vendor/vue.esm-browser.prod.js";

import { api } from "./api.js";
export { api, ApiError, getJSON, postJSON, query } from "./api.js";
export { fetchStatus, notify, store } from "./store.js";
export { onLive, publishLive } from "./live.js";
export { Panel, StatusPill, LiveDot, EmptyState, LoadingBlock, Spinner, MetricCard, ToggleSwitch, CopyButton, Field, Icon } from "./components/ui.js";
export { NumberField, SelectField, SegmentedControl } from "./components/controls.js";
export { fmtDateTime, fmtFullDate, fmtNum, relativeTime, durationText } from "./utils.js";

/** 插件动作的统一入口:自动带鉴权头,错误已经是可展示的字符串 */
export async function pluginAction(pluginId, action = "", { method = "GET", body } = {}) {
  const path = `/api/plugins/${encodeURIComponent(pluginId)}/actions/${action}`;
  return api(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
