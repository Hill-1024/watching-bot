import { computed, onBeforeUnmount, onMounted, ref } from "/vendor/vue.esm-browser.prod.js";
import { api, postJSON } from "../api.js";
import { fetchStatus, notify, store } from "../store.js";
import { VAR_META } from "../meta.js";
import { DAY_MS, durationText, fmtFullDate, HOUR_MS } from "../utils.js";

const RANGES = [
  { value: "1h", label: "1 小时", ms: HOUR_MS },
  { value: "6h", label: "6 小时", ms: 6 * HOUR_MS },
  { value: "24h", label: "24 小时", ms: DAY_MS },
  { value: "3d", label: "3 天", ms: 3 * DAY_MS },
  { value: "7d", label: "7 天", ms: 7 * DAY_MS },
];

export const StatePage = {
  name: "StatePage",
  setup() {
    const rangeKey = ref("6h");
    const history = ref(null);
    const loading = ref(false);
    const error = ref("");
    const coffee = ref(null);
    const acting = ref("");

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
      if (!s) return "-";
      if (!s.sleepStartedSim) return "未在睡";
      return durationText(Math.max(0, s.simMs - s.sleepStartedSim));
    });

    const historyLabel = computed(() => {
      if (!history.value?.items?.length) return "";
      const first = history.value.items[0];
      const last = history.value.items[history.value.items.length - 1];
      return `${fmtFullDate(first.tsSim)} 至 ${fmtFullDate(last.tsSim)}`;
    });

    async function loadHistory() {
      const s = store.status;
      if (!s) return;
      loading.value = true;
      try {
        const until = s.simMs + 1;
        const since = s.simMs - range.value.ms;
        history.value = await api(`/api/history?since=${since}&until=${until}&points=420`);
        error.value = "";
      } catch (err) {
        error.value = err.message || "状态历史读取失败";
      } finally {
        loading.value = false;
      }
    }

    async function loadCoffee() {
      try {
        coffee.value = await api("/api/coffee");
      } catch {
        coffee.value = null;
      }
    }

    async function act(path, label) {
      if (acting.value) return;
      acting.value = path;
      try {
        await postJSON(path);
        notify("success", label);
        await fetchStatus();
        await loadCoffee();
      } catch (err) {
        notify("error", err.message || "操作失败");
      } finally {
        acting.value = "";
      }
    }

    async function claimCoffee(n) {
      try {
        const r = await postJSON("/api/coffee", { n });
        coffee.value = { remaining: r.remaining };
        notify("success", `已补 ${n} 杯,现存 ${r.remaining} 杯`);
      } catch (err) {
        notify("error", err.message || "补咖啡失败");
      }
    }

    async function commitTimescale(value) {
      try {
        const r = await postJSON("/api/timescale", { value });
        notify("success", `timeScale 已切换为 ×${r.timeScale}`);
        await fetchStatus();
      } catch (err) {
        notify("error", err.message || "timeScale 切换失败");
      }
    }

    async function consolidate() {
      if (acting.value) return;
      acting.value = "consolidate";
      notify("info", "开始整理记忆,模型完成前请稍候");
      try {
        await postJSON("/api/consolidate");
        notify("success", "记忆整理完成");
      } catch (err) {
        notify("error", err.message || "记忆整理失败");
      } finally {
        acting.value = "";
      }
    }

    let timer = null;
    onMounted(() => {
      void loadHistory();
      void loadCoffee();
      timer = setInterval(() => !document.hidden && loadHistory(), 8000);
    });
    onBeforeUnmount(() => clearInterval(timer));

    return {
      store,
      status,
      varList,
      rangeKey,
      range,
      RANGES,
      history,
      historyLabel,
      seriesByVar,
      loading,
      error,
      coffee,
      sleepText,
      acting,
      loadHistory,
      act,
      claimCoffee,
      commitTimescale,
      consolidate,
    };
  },
  template: `<div class="page">
    <header class="page-head">
      <div>
        <h1>状态与历史</h1>
        <p>五维状态直接调整立即生效,历史曲线按模拟时间采样。</p>
      </div>
      <div class="page-head-meta">
        <LiveDot :live="!error" :label="error ? '读取失败' : '每 8 秒同步'" />
      </div>
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
        <Panel class="span-7" title="状态历史" :subtitle="historyLabel || '按模拟时间记录'">
          <template #actions>
            <SegmentedControl v-model="rangeKey" :options="RANGES.map(r => ({ value: r.value, label: r.label }))" label="历史范围" @update:modelValue="loadHistory" />
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

        <Panel class="span-5" title="时间与睡眠" subtitle="timeScale 热调,不重启进程">
          <div class="kv-row">
            <span class="kv-key">当前阶段</span>
            <StatusPill :phase="status.phase" />
          </div>
          <div class="kv-row">
            <span class="kv-key">本段睡眠</span>
            <span class="kv-value">{{ sleepText }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">赖床次数</span>
            <span class="kv-value">{{ status.snoozeCount }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">待响闹钟</span>
            <span class="kv-value">{{ status.pendingAlarms }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">timeScale</span>
            <div class="kv-control">
              <NumberField :model-value="status.timeScale" :min="1" :max="100000" :step="1" suffix="×" label="timeScale" @commit="commitTimescale" />
            </div>
          </div>
          <div class="kv-row">
            <span class="kv-key">咖啡余量</span>
            <div class="kv-control">
              <span class="kv-value">{{ coffee ? coffee.remaining + ' 杯' : '模块未启用' }}</span>
              <button v-if="coffee" class="btn btn-sm" @click="claimCoffee(1)">补 1</button>
              <button v-if="coffee" class="btn btn-sm" @click="claimCoffee(3)">补 3</button>
            </div>
          </div>
          <div class="divider"></div>
          <div class="btn-row">
            <button class="btn" :disabled="acting === '/api/sleep'" @click="act('/api/sleep', '已请求入睡')"><Icon name="bed" :size="15" />强制入睡</button>
            <button class="btn" :disabled="acting === '/api/wake'" @click="act('/api/wake', '已强制唤醒')"><Icon name="sunrise" :size="15" />强制唤醒</button>
            <button class="btn btn-primary" :disabled="acting === 'consolidate'" @click="consolidate">
              <Spinner v-if="acting === 'consolidate'" :size="13" /><Icon v-else name="brain" :size="15" />整理记忆
            </button>
          </div>
          <p class="panel-note">睡眠中终止进程后重启,会以清醒状态继续,不保留睡眠段。</p>
        </Panel>
      </div>
    </template>
  </div>`,
};
