import { computed, onBeforeUnmount, onMounted, ref, watch } from "/vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { debounce, DAY_MS, durationText, fmtFullDate, HOUR_MS, setIfChanged, simNowMs } from "../utils.js";
import { onLive } from "../live.js";
import { store } from "../store.js";
import { VAR_META } from "../meta.js";

const RANGES = [
  { value: "1h", label: "1 小时", ms: HOUR_MS },
  { value: "6h", label: "6 小时", ms: 6 * HOUR_MS },
  { value: "24h", label: "24 小时", ms: DAY_MS },
  { value: "3d", label: "3 天", ms: 3 * DAY_MS },
  { value: "7d", label: "7 天", ms: 7 * DAY_MS },
];

/**
 * 状态与历史:只订阅 state/status 两个 topic。
 * 活动日志、注入、Token 的变化不会触发本页任何更新。
 */
export const StatePage = {
  name: "StatePage",
  setup() {
    const rangeKey = ref("6h");
    const history = ref(null);
    const loading = ref(false);
    const error = ref("");
    const now = ref(Date.now());

    const status = computed(() => store.status);
    const varList = computed(() =>
      Object.entries(status.value?.defs || {}).map(([name, def]) => ({
        name,
        min: def.min,
        max: def.max,
        ...(VAR_META[name] || { label: name, hint: "", color: "var(--accent)" }),
      })),
    );
    const range = computed(() => RANGES.find((r) => r.value === rangeKey.value) || RANGES[1]);
    const simMs = computed(() => simNowMs(status.value, now.value));

    const seriesByVar = computed(() => {
      const out = {};
      const items = history.value?.items || [];
      for (const v of varList.value) {
        const pts = items.map((r) => r.vars?.[v.name]).filter((n) => typeof n === "number");
        out[v.name] = {
          values: pts,
          current: pts.length ? pts[pts.length - 1] : status.value?.vars?.[v.name],
          first: pts.length ? pts[0] : null,
          count: pts.length,
        };
      }
      return out;
    });

    const sleepText = computed(() => {
      const s = status.value;
      if (!s || !s.sleepStartedSim || simMs.value == null) return "未在睡";
      return durationText(Math.max(0, simMs.value - s.sleepStartedSim));
    });

    const historyLabel = computed(() => {
      if (!history.value?.items?.length) return "";
      const items = history.value.items;
      return `${fmtFullDate(items[0].tsSim)} 至 ${fmtFullDate(items[items.length - 1].tsSim)}`;
    });

    async function loadHistory() {
      const s = store.status;
      const anchor = simNowMs(s, Date.now());
      if (!s || anchor == null) return;
      loading.value = true;
      try {
        const until = anchor + 1;
        const since = anchor - range.value.ms;
        setIfChanged(history, await api(`/api/history?since=${since}&until=${until}&points=420`));
        error.value = "";
      } catch (err) {
        error.value = err.message || "状态历史读取失败";
      } finally {
        loading.value = false;
      }
    }

    const scheduleHistory = debounce(() => void loadHistory(), 900);
    const offs = [];
    let ticker = null;

    onMounted(() => {
      void loadHistory();
      // 状态变化(4s 合并)才重拉历史;status 推送只更新内存里的数值
      offs.push(onLive("state", scheduleHistory));
      ticker = setInterval(() => (now.value = Date.now()), 5000);
    });
    onBeforeUnmount(() => {
      for (const off of offs) off();
      clearInterval(ticker);
    });

    watch(rangeKey, () => void loadHistory());

    return {
      store, status, varList, rangeKey, range, RANGES, history, historyLabel,
      seriesByVar, loading, error, sleepText, loadHistory,
    };
  },
  template: `<div class="page">
    <header class="page-head">
      <div>
        <span class="eyebrow">监控</span>
        <h1>状态与历史</h1>
        <p class="page-sub">五维状态由事件流驱动更新;曲线按模拟时间采样,变化时才刷新。</p>
      </div>
      <div class="page-actions"><span class="chip chip-muted">模拟 <SimClock /></span></div>
    </header>

    <div v-if="!status" class="panel"><LoadingBlock :rows="5" /></div>

    <template v-else>
      <section class="var-grid" aria-label="状态变量">
        <div v-for="v in varList" :key="v.name" class="var-card">
          <VariableControl :name="v.name" :label="v.label" :value="status.vars[v.name] ?? 0"
            :min="v.min" :max="v.max" :step="1" :hint="v.hint" />
        </div>
      </section>

      <div class="grid">
        <Panel class="span-8" title="状态历史" :subtitle="historyLabel || '按模拟时间记录'">
          <template #actions>
            <SegmentedControl :model-value="rangeKey" :options="RANGES.map(r => ({ value: r.value, label: r.label }))"
              label="历史范围" @update:model-value="rangeKey = $event; loadHistory()" />
          </template>
          <div v-if="error" class="banner banner-error">{{ error }}</div>
          <div v-if="!history" class="loading-block"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
          <div v-else class="state-rows">
            <div v-for="v in varList" :key="v.name" class="state-row">
              <div class="state-row-head">
                <span class="state-name">{{ v.label }}</span>
                <span class="state-current">{{ (seriesByVar[v.name].current ?? 0).toFixed(1) }}</span>
                <span class="state-delta">{{ seriesByVar[v.name].count }} 个采样</span>
              </div>
              <Sparkline :values="seriesByVar[v.name].values" :min="v.min" :max="v.max" :color="v.color" :height="42" />
              <div class="state-bounds"><span>{{ v.min }}</span><span>{{ v.max }}</span></div>
            </div>
          </div>
        </Panel>

        <Panel class="span-4" title="睡眠" subtitle="由状态事件与 phase 变化驱动">
          <div class="kv-row"><span class="kv-key">当前阶段</span><StatusPill :phase="status.phase" /></div>
          <div class="kv-row"><span class="kv-key">本段睡眠</span><span class="kv-value">{{ sleepText }}</span></div>
          <div class="kv-row"><span class="kv-key">赖床次数</span><span class="kv-value">{{ status.snoozeCount }}</span></div>
          <div class="kv-row"><span class="kv-key">待响闹钟</span><span class="kv-value">{{ status.pendingAlarms }}</span></div>
          <div class="divider"></div>
          <p class="panel-note">状态数值只在面板与日志里出现,永远不会进入提示词。</p>
        </Panel>
      </div>
    </template>
  </div>`,
};
