import { computed, onBeforeUnmount, onMounted, ref, watch } from "/vendor/vue.esm-browser.prod.js";
import { onLive } from "../live.js";
import { api } from "../api.js";
import { SOURCE_LABEL, SOURCE_TONE, USAGE_COLORS } from "../meta.js";
import {
  addDays,
  bucketUnitLabel,
  debounce,
  compactNum,
  customRange,
  dateToIso,
  fmtDateTime,
  fmtFullDate,
  fmtNum,
  fmtPct,
  formatDelta,
  pctDelta,
  presetRange,
  RANGE_PRESETS,
  setIfChanged,
} from "../utils.js";

export const UsagePage = {
  name: "UsagePage",
  setup() {
    const preset = ref("today");
    const customStart = ref(dateToIso(addDays(Date.now(), -6)));
    const customEnd = ref(dateToIso(Date.now()));
    const nowTick = ref(Date.now());
    const data = ref(null);
    const loading = ref(false);
    const error = ref("");
    const loadedAt = ref(0);
    let requestId = 0;

    const todayIso = dateToIso(Date.now());
    const range = computed(() =>
      preset.value === "custom"
        ? customRange(customStart.value, customEnd.value, nowTick.value)
        : presetRange(preset.value, nowTick.value),
    );
    const customValid = computed(() => preset.value !== "custom" || Boolean(range.value));
    const rangeText = computed(() => {
      const r = range.value;
      if (!r) return "日期范围无效";
      return `${fmtFullDate(r.since)} 至 ${fmtFullDate(r.until)}`;
    });

    async function load() {
      const r = range.value;
      if (!r) {
        error.value = "起始日期不能晚于结束日期";
        data.value = null;
        return;
      }
      const id = ++requestId;
      loading.value = true;
      error.value = "";
      try {
        const d = await api(`/api/usage?since=${Math.floor(r.since)}&until=${Math.floor(r.until)}&bucket=auto`);
        if (id !== requestId) return;
        setIfChanged(data, d);
        loadedAt.value = Date.now();
      } catch (err) {
        if (id === requestId) error.value = err.message || "Token 统计读取失败";
      } finally {
        if (id === requestId) loading.value = false;
      }
    }

    watch([preset, customStart, customEnd], () => {
      if (customValid.value) void load();
      else {
        error.value = "起始日期不能晚于结束日期";
        data.value = null;
      }
    });

    const totals = computed(() => data.value?.totals || null);
    const previous = computed(() => data.value?.previous || null);
    const buckets = computed(() => data.value?.buckets || []);
    const labels = computed(() => buckets.value.map((b) => b.ts));

    const series = computed(() => {
      const b = buckets.value;
      return [
        { key: "total", label: "总 Token", color: USAGE_COLORS.total, values: b.map((x) => x.total) },
        { key: "input", label: "输入 Token", color: USAGE_COLORS.input, values: b.map((x) => x.input) },
        { key: "output", label: "输出 Token", color: USAGE_COLORS.output, values: b.map((x) => x.output) },
        { key: "cacheRead", label: "缓存命中 Token", color: USAGE_COLORS.cacheRead, values: b.map((x) => x.cacheRead) },
        {
          key: "rate",
          label: "缓存命中率",
          color: USAGE_COLORS.rate,
          values: b.map((x) => x.cacheHitRate),
          axis: "percent",
          dashed: true,
        },
      ];
    });

    const totalDelta = computed(() => pctDelta(totals.value?.total, previous.value?.total));
    const inputDelta = computed(() => pctDelta(totals.value?.input, previous.value?.input));
    const outputDelta = computed(() => pctDelta(totals.value?.output, previous.value?.output));
    const cacheDelta = computed(() => pctDelta(totals.value?.cacheRead, previous.value?.cacheRead));
    const requestDelta = computed(() => pctDelta(totals.value?.requests, previous.value?.requests));
    const rateDelta = computed(() => {
      if (!totals.value || !previous.value) return null;
      if (previous.value.requests === 0) return null;
      return totals.value.cacheHitRate - previous.value.cacheHitRate;
    });

    function deltaText(delta) {
      if (delta == null || (previous.value?.requests || 0) < 3) return "上一周期样本不足";
      if (delta > 9.99) return "较上一周期 > +999%";
      if (delta < -0.999) return "较上一周期 -100%";
      return `较上一周期 ${formatDelta(delta)}`;
    }
    function rateDeltaText() {
      if (rateDelta.value == null || (previous.value?.requests || 0) < 3) return "上一周期样本不足";
      const sign = rateDelta.value > 0 ? "+" : "";
      return `较上一周期 ${sign}${(rateDelta.value * 100).toFixed(1)} 个百分点`;
    }

    const metrics = computed(() => {
      const t = totals.value;
      if (!t) return [];
      return [
        { label: "总 Token", value: compactNum(t.total), hint: deltaText(totalDelta.value), tone: "is-accent" },
        { label: "输入 Token", value: compactNum(t.input), hint: deltaText(inputDelta.value) },
        { label: "输出 Token", value: compactNum(t.output), hint: deltaText(outputDelta.value) },
        { label: "缓存命中 Token", value: compactNum(t.cacheRead), hint: deltaText(cacheDelta.value) },
        { label: "缓存命中率", value: fmtPct(t.cacheHitRate), hint: rateDeltaText(), tone: "is-sage" },
        { label: "请求次数", value: fmtNum(t.requests), hint: deltaText(requestDelta.value) },
      ];
    });

    const sourceRows = computed(() => {
      const total = totals.value?.total || 0;
      return (data.value?.bySource || []).map((s) => ({
        ...s,
        label: s.label || SOURCE_LABEL[s.key] || s.key,
        tone: SOURCE_TONE[s.key] || "",
        percent: total > 0 ? s.total / total : 0,
      }));
    });

    const modelRows = computed(() => data.value?.byModel || []);
    const recentRows = computed(() => data.value?.recent || []);
    const hasData = computed(() => (totals.value?.requests || 0) > 0);

    // 只在这个页面挂载时订阅 usage;模型调用结束才会刷新
    let off = null;
    const scheduleLoad = debounce(() => {
      nowTick.value = Date.now();
      void load();
    }, 800);
    onMounted(() => {
      void load();
      off = onLive("usage", scheduleLoad);
    });
    onBeforeUnmount(() => off?.());

    return {
      preset,
      customStart,
      customEnd,
      todayIso,
      range,
      rangeText,
      customValid,
      data,
      loading,
      error,
      loadedAt,
      totals,
      previous,
      labels,
      series,
      metrics,
      sourceRows,
      modelRows,
      recentRows,
      hasData,
      RANGE_PRESETS,
      bucketUnitLabel,
      SOURCE_LABEL,
      SOURCE_TONE,
      load,
      compactNum,
      fmtNum,
      fmtPct,
      fmtDateTime,
      fmtFullDate,
    };
  },
  template: `<div class="page">
    <header class="page-head">
      <div>
        <h1>Token 统计</h1>
        <p>按真实时间统计每次模型调用的输入、输出、缓存与命中率。</p>
      </div>
      <div class="page-head-meta">
        <LiveDot :live="!error" :label="error ? '读取失败' : '每 30 秒刷新'" />
      </div>
    </header>

    <section class="range-panel">
      <div class="range-main">
        <span class="toolbar-label">时间范围</span>
        <SelectField v-model="preset" :options="RANGE_PRESETS" label="时间范围" />
        <template v-if="preset === 'custom'">
          <span class="range-sep">从</span>
          <DateField v-model="customStart" label="开始日期" :max="customEnd" />
          <span class="range-sep">至</span>
          <DateField v-model="customEnd" label="结束日期" :min="customStart" :max="todayIso" />
        </template>
      </div>
      <div class="range-extra">
        <span v-if="data" class="badge">{{ bucketUnitLabel(data.bucketUnit) }}</span>
        <button class="btn btn-sm" :disabled="loading" @click="load">
          <Spinner v-if="loading" :size="13" /><Icon v-else name="refresh" :size="14" />刷新
        </button>
      </div>
      <p class="range-text">{{ rangeText }}</p>
      <p v-if="!customValid" class="field-error">起始日期不能晚于结束日期。</p>
    </section>

    <div v-if="error" class="banner banner-error">{{ error }}</div>

    <template v-if="!data">
      <div class="metric-grid">
        <div v-for="i in 6" :key="i" class="metric-card"><div class="skeleton-line" style="width: 38%"></div><div class="skeleton-line" style="width: 68%; height: 26px"></div><div class="skeleton-line" style="width: 52%"></div></div>
      </div>
      <div class="panel"><LoadingBlock :rows="6" /></div>
    </template>

    <template v-else>
      <div v-if="!hasData" class="banner banner-info">
        <Icon name="sparkles" :size="16" />
        <span>当前区间还没有模型调用记录。Token 采集从本次版本启动后开始累计,历史旧数据不在统计内。</span>
      </div>

      <section class="metric-grid" aria-label="Token 汇总">
        <MetricCard v-for="m in metrics" :key="m.label" :label="m.label" :value="m.value" :hint="m.hint" :tone="m.tone" />
      </section>

      <Panel title="用量趋势" :subtitle="rangeText + ' · ' + bucketUnitLabel(data.bucketUnit)">
        <template #actions>
          <span class="chart-axis-note">左轴 Token · 右轴命中率</span>
        </template>
        <LineChart :series="series" :labels="labels" :bucket-unit="data.bucketUnit" :height="360" />
        <p class="panel-note">总 Token 含缓存读写。命中率 = 缓存读取 / (输入 + 缓存读取 + 缓存写入)。</p>
      </Panel>

      <div class="grid">
        <Panel class="span-5" title="来源构成" subtitle="按调用来源拆分 Token">
          <div v-if="!sourceRows.length" class="empty-inline">当前区间没有来源数据。</div>
          <div v-else class="source-list">
            <div v-for="s in sourceRows" :key="s.key" class="source-row">
              <div class="source-head">
                <span>{{ s.label }}</span>
                <span class="source-value">{{ compactNum(s.total) }} · {{ fmtPct(s.percent, 0) }}</span>
              </div>
              <div class="progress"><span class="progress-fill" :class="'tone-' + s.tone" :style="{ width: (s.percent * 100) + '%' }"></span></div>
              <div class="source-meta">{{ fmtNum(s.requests) }} 次调用 · 命中 {{ fmtPct(s.cacheHitRate) }}</div>
            </div>
          </div>
        </Panel>

        <Panel class="span-7" title="模型分布" subtitle="同一区间内按模型聚合">
          <div v-if="!modelRows.length" class="empty-inline">当前区间没有模型数据。</div>
          <div v-else class="table-wrap">
            <table class="data-table">
              <thead><tr><th>模型</th><th class="num">请求</th><th class="num">缓存命中</th><th class="num">命中率</th><th class="num">总 Token</th></tr></thead>
              <tbody>
                <tr v-for="m in modelRows" :key="m.key">
                  <td class="mono"><span class="ellipsis" :title="m.label">{{ m.label }}</span></td>
                  <td class="num">{{ fmtNum(m.requests) }}</td>
                  <td class="num">{{ compactNum(m.cacheRead) }}</td>
                  <td class="num">{{ fmtPct(m.cacheHitRate) }}</td>
                  <td class="num strong">{{ compactNum(m.total) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel class="span-12" title="最近请求" subtitle="区间内最近 50 次模型调用">
          <div v-if="!recentRows.length" class="empty-inline">当前区间没有请求明细。</div>
          <div v-else class="table-wrap table-scroll">
            <table class="data-table">
              <thead><tr><th>真实时间</th><th>来源</th><th>模型</th><th class="num">输入</th><th class="num">输出</th><th class="num">缓存读</th><th class="num">缓存写</th><th class="num">合计</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in recentRows" :key="r.tsReal + '-' + i">
                  <td class="mono">{{ fmtDateTime(r.tsReal) }}</td>
                  <td><span class="log-tag" :class="'tag-' + (SOURCE_TONE[r.source] || 'text')">{{ SOURCE_LABEL[r.source] || r.source }}</span></td>
                  <td class="mono">{{ (r.provider ? r.provider + '/' : '') + r.model }}</td>
                  <td class="num">{{ fmtNum(r.input) }}</td>
                  <td class="num">{{ fmtNum(r.output) }}</td>
                  <td class="num">{{ fmtNum(r.cacheRead) }}</td>
                  <td class="num">{{ fmtNum(r.cacheWrite) }}</td>
                  <td class="num strong">{{ fmtNum(r.total) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </template>
  </div>`,
};
