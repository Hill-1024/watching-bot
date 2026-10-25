import { computed, onBeforeUnmount, onMounted, ref, watch } from "/vendor/vue.esm-browser.prod.js";
import { bucketLabel, compactNum, fmtDateTime, fmtNum, fmtPct } from "../utils.js";

let gradientSeq = 0;

export const Sparkline = {
  name: "Sparkline",
  props: {
    values: { type: Array, default: () => [] },
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    color: { type: String, default: "var(--accent)" },
    height: { type: Number, default: 40 },
  },
  setup(props) {
    const gid = `spark-${++gradientSeq}`;
    const W = 320;
    const H = computed(() => props.height);
    const normalized = computed(() => {
      const span = props.max - props.min || 1;
      return props.values.map((v) => Math.min(1, Math.max(0, (v - props.min) / span)));
    });
    const line = computed(() => {
      const pts = normalized.value;
      if (!pts.length) return "";
      if (pts.length === 1) return `M0,${H.value - pts[0] * H.value} L${W},${H.value - pts[0] * H.value}`;
      return pts
        .map((p, i) => `${i === 0 ? "M" : "L"}${((i / (pts.length - 1)) * W).toFixed(2)},${(H.value - p * (H.value - 4) - 2).toFixed(2)}`)
        .join(" ");
    });
    const area = computed(() => (line.value ? `${line.value} L${W},${H.value} L0,${H.value} Z` : ""));
    return { gid, W, H, line, area };
  },
  template: `<svg class="sparkline" :viewBox="'0 0 ' + W + ' ' + H" preserveAspectRatio="none" :style="{ height: H + 'px', color }" aria-hidden="true">
    <defs>
      <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1" style="color: inherit">
        <stop offset="0%" stop-color="currentColor" stop-opacity=".20" />
        <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path v-if="area" :d="area" :fill="'url(#' + gid + ')'" />
    <path v-if="line" :d="line" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`,
};

function niceCeil(v) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const frac = v / exp;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return nice * exp;
}

export const LineChart = {
  name: "LineChart",
  props: {
    series: { type: Array, default: () => [] },
    labels: { type: Array, default: () => [] },
    bucketUnit: { type: String, default: "hour" },
    height: { type: Number, default: 340 },
    emptyText: { type: String, default: "当前区间还没有用量记录" },
  },
  setup(props) {
    const root = ref(null);
    const svgEl = ref(null);
    const width = ref(0);
    const hover = ref(null);
    const hidden = ref([]);
    const gid = `chart-area-${++gradientSeq}`;

    let ro = null;
    onMounted(() => {
      if (!root.value) return;
      const measure = () => {
        width.value = Math.floor(root.value?.clientWidth || 0);
      };
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(root.value);
    });
    onBeforeUnmount(() => {
      if (ro) ro.disconnect();
    });

    watch(
      () => props.labels.length,
      (n) => {
        if (hover.value != null && hover.value >= n) hover.value = n ? n - 1 : null;
      },
    );

    const pad = { l: 54, r: 54, t: 20, b: 36 };
    const plotW = computed(() => Math.max(10, width.value - pad.l - pad.r));
    const plotH = computed(() => Math.max(10, props.height - pad.t - pad.b));
    const visible = computed(() => props.series.filter((s) => !hidden.value.includes(s.key)));
    const tokenSeries = computed(() => visible.value.filter((s) => s.axis !== "percent"));
    const rateSeries = computed(() => visible.value.filter((s) => s.axis === "percent"));
    const tokenMax = computed(() => {
      let max = 0;
      for (const s of tokenSeries.value) for (const v of s.values || []) max = Math.max(max, Number(v) || 0);
      return niceCeil(max);
    });
    const allZero = computed(() => {
      for (const s of props.series) for (const v of s.values || []) if ((Number(v) || 0) > 0) return false;
      return true;
    });

    const xAt = (i) => {
      const n = props.labels.length;
      if (n <= 1) return pad.l + plotW.value / 2;
      return pad.l + (i / (n - 1)) * plotW.value;
    };
    const yTokenAt = (v) => pad.t + plotH.value - Math.min(1, Math.max(0, (Number(v) || 0) / tokenMax.value)) * plotH.value;
    const yRateAt = (v) => pad.t + plotH.value - Math.min(1, Math.max(0, Number(v) || 0)) * plotH.value;

    const seriesPath = (s) => {
      const vals = s.values || [];
      if (!vals.length) return "";
      const yFn = s.axis === "percent" ? yRateAt : yTokenAt;
      if (vals.length === 1) {
        const y = yFn(vals[0]);
        return `M${pad.l},${y} L${pad.l + plotW.value},${y}`;
      }
      return vals.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(2)},${yFn(v).toFixed(2)}`).join(" ");
    };

    const totalSeries = computed(() => tokenSeries.value.find((s) => s.key === "total") || null);
    const areaPath = computed(() => {
      const s = totalSeries.value;
      if (!s || !s.values?.length) return "";
      const top = seriesPath(s);
      if (!top) return "";
      return `${top} L${xAt(s.values.length - 1).toFixed(2)},${(pad.t + plotH.value).toFixed(2)} L${xAt(0).toFixed(2)},${(pad.t + plotH.value).toFixed(2)} Z`;
    });

    const tokenTicks = computed(() =>
      [0, 0.25, 0.5, 0.75, 1].map((f) => ({
        f,
        y: pad.t + plotH.value - f * plotH.value,
        label: tokenMax.value >= 100_000 ? compactNum(tokenMax.value * f) : fmtNum(tokenMax.value * f),
      })),
    );
    const rateTicks = computed(() =>
      [0, 0.25, 0.5, 0.75, 1].map((f) => ({ f, y: pad.t + plotH.value - f * plotH.value, label: `${Math.round(f * 100)}%` })),
    );

    const xTicks = computed(() => {
      const n = props.labels.length;
      if (!n) return [];
      const target = width.value < 560 ? 4 : width.value < 900 ? 5 : 7;
      const step = Math.max(1, Math.ceil((n - 1) / Math.max(1, target - 1)));
      const idx = [];
      for (let i = 0; i < n; i += step) idx.push(i);
      if (idx.at(-1) !== n - 1) idx.push(n - 1);
      return idx.map((i) => ({ i, x: xAt(i), label: bucketLabel(props.labels[i], props.bucketUnit) }));
    });

    const hoverX = computed(() => (hover.value == null ? 0 : xAt(hover.value)));
    const hoverLabel = computed(() => {
      if (hover.value == null || !props.labels[hover.value]) return "";
      return fmtDateTime(props.labels[hover.value]);
    });
    const hoverRows = computed(() => {
      if (hover.value == null) return [];
      return visible.value.map((s) => {
        const raw = Number(s.values?.[hover.value] || 0);
        return {
          key: s.key,
          label: s.label,
          color: s.color,
          value: s.axis === "percent" ? fmtPct(raw) : fmtNum(raw),
          dashed: s.dashed,
        };
      });
    });
    const tooltipStyle = computed(() => {
      const x = hoverX.value;
      const tipW = 210;
      const left = x + 16 + tipW > width.value ? x - 16 - tipW : x + 16;
      return { left: `${Math.max(8, left)}px`, top: `${pad.t + 4}px`, width: `${tipW}px` };
    });

    const onPointerMove = (e) => {
      if (!svgEl.value) return;
      const rect = svgEl.value.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const n = props.labels.length;
      if (!n) return;
      if (x < pad.l - 8 || x > pad.l + plotW.value + 8) {
        hover.value = null;
        return;
      }
      const rel = Math.min(1, Math.max(0, (x - pad.l) / plotW.value));
      hover.value = Math.round(rel * (n - 1));
    };
    const clearHover = () => {
      hover.value = null;
    };
    const onKeydown = (e) => {
      const n = props.labels.length;
      if (!n) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        if (hover.value == null) hover.value = n - 1;
        else hover.value = Math.min(n - 1, Math.max(0, hover.value + (e.key === "ArrowRight" ? 1 : -1)));
      } else if (e.key === "Escape") {
        hover.value = null;
      }
    };
    const isHidden = (key) => hidden.value.includes(key);
    const toggle = (key) => {
      const next = isHidden(key) ? hidden.value.filter((k) => k !== key) : [...hidden.value, key];
      hidden.value = next;
    };

    return {
      root,
      svgEl,
      width,
      pad,
      plotW,
      plotH,
      visible,
      tokenSeries,
      rateSeries,
      tokenMax,
      tokenTicks,
      rateTicks,
      xTicks,
      seriesPath,
      areaPath,
      hover,
      hoverX,
      hoverLabel,
      hoverRows,
      tooltipStyle,
      onPointerMove,
      clearHover,
      onKeydown,
      isHidden,
      toggle,
      allZero,
      gid,
      fmtPct,
    };
  },
  template: `<div class="line-chart" ref="root">
    <div class="chart-legend" role="group" aria-label="图表图例,点击切换显示">
      <button v-for="s in series" :key="s.key" type="button" class="legend-chip" :class="{ 'is-off': isHidden(s.key) }"
        :aria-pressed="!isHidden(s.key)" @click="toggle(s.key)">
        <span class="legend-swatch" :class="{ 'is-dashed': s.dashed }" :style="{ background: s.color, borderColor: s.color }"></span>
        <span>{{ s.label }}</span>
      </button>
    </div>
    <div class="chart-canvas" :style="{ height: height + 'px' }" tabindex="0" role="img"
      :aria-label="'Token 用量折线图,共 ' + labels.length + ' 个时间点。使用左右方向键查看数值。'"
      @pointermove="onPointerMove" @pointerleave="clearHover" @blur="clearHover" @keydown="onKeydown">
      <svg v-if="width > 0" ref="svgEl" :width="width" :height="height" :viewBox="'0 0 ' + width + ' ' + height" aria-hidden="true">
        <defs>
          <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1" style="color: var(--chart-total)">
            <stop offset="0%" stop-color="currentColor" stop-opacity=".18" />
            <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
          </linearGradient>
        </defs>
        <g class="chart-grid">
          <line v-for="t in tokenTicks" :key="'g' + t.f" :x1="pad.l" :x2="pad.l + plotW" :y1="t.y" :y2="t.y" />
        </g>
        <g class="chart-axis">
          <text v-for="t in tokenTicks" :key="'l' + t.f" :x="pad.l - 10" :y="t.y + 4" text-anchor="end">{{ t.label }}</text>
          <text v-for="t in rateTicks" :key="'r' + t.f" :x="pad.l + plotW + 10" :y="t.y + 4" text-anchor="start">{{ t.label }}</text>
          <text v-for="t in xTicks" :key="'x' + t.i" :x="t.x" :y="height - 12"
            :text-anchor="t.i === 0 ? 'start' : t.i === labels.length - 1 ? 'end' : 'middle'">{{ t.label }}</text>
        </g>
        <path v-if="areaPath" :d="areaPath" :fill="'url(#' + gid + ')'" />
        <path v-for="s in visible" :key="s.key" :d="seriesPath(s)" fill="none" :stroke="s.color"
          :stroke-width="s.key === 'total' ? 2.2 : s.axis === 'percent' ? 1.9 : 1.6" :stroke-dasharray="s.dashed ? '5 4' : undefined"
          stroke-linecap="round" stroke-linejoin="round" class="chart-line" />
        <line v-if="hover != null" class="chart-crosshair" :x1="hoverX" :x2="hoverX" :y1="pad.t" :y2="pad.t + plotH" />
        <g v-if="hover != null">
          <circle v-for="s in visible" :key="'d' + s.key" :cx="hoverX"
            :cy="s.axis === 'percent' ? pad.t + plotH - Math.min(1, Math.max(0, Number(s.values?.[hover] || 0))) * plotH : pad.t + plotH - Math.min(1, Math.max(0, Number(s.values?.[hover] || 0) / tokenMax)) * plotH"
            r="3.2" :fill="s.color" stroke="var(--surface)" stroke-width="1.5" />
        </g>
      </svg>
      <div v-if="allZero && labels.length" class="chart-empty">
        <Icon name="chart" :size="20" />
        <span>{{ emptyText }}</span>
      </div>
      <div v-if="hover != null" class="chart-tooltip" :style="tooltipStyle" role="status">
        <div class="chart-tooltip-time">{{ hoverLabel }}</div>
        <div v-for="row in hoverRows" :key="row.key" class="chart-tooltip-row">
          <span class="tooltip-label"><span class="legend-swatch" :style="{ background: row.color }"></span>{{ row.label }}</span>
          <span class="tooltip-value">{{ row.value }}</span>
        </div>
      </div>
    </div>
  </div>`,
};
