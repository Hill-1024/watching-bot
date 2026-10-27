import { computed, onBeforeUnmount, ref } from "/vendor/vue.esm-browser.prod.js";
import { ICONS } from "../icons.js";
import { notify, store, dismissToast } from "../store.js";
import { fmtClock, fmtNum, fmtSimClock, relativeTime, simNowMs } from "../utils.js";

export const Icon = {
  name: "Icon",
  props: {
    name: { type: String, default: "circleAlert" },
    size: { type: [Number, String], default: 18 },
    stroke: { type: [Number, String], default: 1.6 },
    label: { type: String, default: "" },
  },
  computed: {
    markup() {
      return ICONS[this.name] || ICONS.circleAlert;
    },
  },
  template: `<svg class="icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" :stroke-width="stroke" stroke-linecap="round" stroke-linejoin="round"
    :aria-hidden="label ? undefined : 'true'" :role="label ? 'img' : undefined" :aria-label="label || undefined"
    v-html="markup"></svg>`,
};

const PHASE_LABEL = {
  awake: "醒着",
  resting: "躺着放空",
  asleep: "睡着",
  sleep_transition: "正在入睡",
  waking: "被吵醒,犹豫中",
};

export const StatusPill = {
  name: "StatusPill",
  props: { phase: { type: String, default: "awake" } },
  computed: {
    label() {
      return PHASE_LABEL[this.phase] || this.phase;
    },
  },
  template: `<span class="status-pill" :data-phase="phase"><span class="status-dot"></span><span class="status-label">{{ label }}</span></span>`,
};

export const LiveDot = {
  name: "LiveDot",
  props: {
    live: { type: Boolean, default: true },
    label: { type: String, default: "" },
  },
  template: `<span class="live-dot" :class="{ 'is-live': live }"><span class="dot"></span><span v-if="label">{{ label }}</span></span>`,
};

export const Panel = {
  name: "Panel",
  props: {
    title: { type: String, default: "" },
    subtitle: { type: String, default: "" },
    flush: { type: Boolean, default: false },
  },
  computed: {
    hasHead() {
      return Boolean(this.title || this.subtitle || this.$slots.actions || this.$slots.header);
    },
  },
  template: `<section class="panel" :class="{ 'panel-flush': flush }">
    <header v-if="hasHead" class="panel-head">
      <div class="panel-head-text">
        <slot name="header">
          <h2 v-if="title">{{ title }}</h2>
          <p v-if="subtitle">{{ subtitle }}</p>
        </slot>
      </div>
      <div v-if="$slots.actions" class="panel-actions"><slot name="actions"></slot></div>
    </header>
    <div class="panel-body"><slot></slot></div>
  </section>`,
};

export const Pagination = {
  name: "Pagination",
  props: {
    page: { type: Number, default: 1 },
    total: { type: Number, default: 0 },
    pageSize: { type: Number, default: 50 },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:page"],
  computed: {
    pageCount() {
      return Math.max(1, Math.ceil(this.total / this.pageSize));
    },
    pages() {
      const count = this.pageCount;
      const current = this.page;
      const out = [];
      const push = (p) => {
        if (!out.includes(p)) out.push(p);
      };
      push(1);
      for (let p = current - 1; p <= current + 1; p++) {
        if (p > 1 && p < count) push(p);
      }
      if (count > 1) push(count);
      return out;
    },
    rangeText() {
      if (this.total === 0) return "共 0 条";
      const start = (this.page - 1) * this.pageSize + 1;
      const end = Math.min(this.total, start + this.pageSize - 1);
      return `第 ${start}-${end} 条 · 共 ${fmtNum(this.total)} 条`;
    },
  },
  methods: {
    go(p) {
      if (this.disabled) return;
      const next = Math.min(this.pageCount, Math.max(1, p));
      if (next !== this.page) this.$emit("update:page", next);
    },
    isGap(index) {
      if (index === 0) return false;
      return this.pages[index] - this.pages[index - 1] > 1;
    },
  },
  template: `<div class="pagination">
    <span class="pagination-range">{{ rangeText }}</span>
    <div class="pagination-pages">
      <button class="pg-btn" :disabled="disabled || page <= 1" aria-label="上一页" @click="go(page - 1)">
        <Icon name="chevronLeft" :size="15" />
      </button>
      <template v-for="(p, i) in pages" :key="p">
        <span v-if="isGap(i)" class="pg-gap">...</span>
        <button class="pg-btn" :class="{ 'is-active': p === page }" :disabled="disabled" @click="go(p)">{{ p }}</button>
      </template>
      <button class="pg-btn" :disabled="disabled || page >= pageCount" aria-label="下一页" @click="go(page + 1)">
        <Icon name="chevronRight" :size="15" />
      </button>
    </div>
  </div>`,
};

export const EmptyState = {
  name: "EmptyState",
  props: {
    icon: { type: String, default: "sparkles" },
    title: { type: String, default: "暂无数据" },
    text: { type: String, default: "" },
  },
  template: `<div class="empty-state">
    <div class="empty-icon"><Icon :name="icon" :size="22" /></div>
    <div class="empty-title">{{ title }}</div>
    <p v-if="text" class="empty-text">{{ text }}</p>
    <slot></slot>
  </div>`,
};

export const LoadingBlock = {
  name: "LoadingBlock",
  props: { rows: { type: Number, default: 3 } },
  template: `<div class="loading-block" aria-label="加载中">
    <div v-for="i in rows" :key="i" class="skeleton-line" :style="{ width: (92 - i * 9) + '%' }"></div>
  </div>`,
};

export const Spinner = {
  name: "Spinner",
  props: { size: { type: Number, default: 14 } },
  template: `<span class="spinner" :style="{ width: size + 'px', height: size + 'px' }" aria-hidden="true"></span>`,
};

export const ToastHost = {
  name: "ToastHost",
  components: { Icon },
  setup() {
    return { store, dismissToast };
  },
  template: `<div class="toast-host" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in store.toasts" :key="t.id" class="toast" :class="'toast-' + t.kind" role="status">
        <Icon :name="t.kind === 'error' ? 'circleAlert' : t.kind === 'success' ? 'circleCheck' : 'sparkles'" :size="16" />
        <span class="toast-text">{{ t.text }}</span>
        <button class="toast-close" aria-label="关闭提示" @click="dismissToast(t.id)"><Icon name="x" :size="13" /></button>
      </div>
    </TransitionGroup>
  </div>`,
};

export const MetricCard = {
  name: "MetricCard",
  props: {
    label: { type: String, required: true },
    value: { type: [String, Number], default: "-" },
    unit: { type: String, default: "" },
    hint: { type: String, default: "" },
    tone: { type: String, default: "" },
  },
  template: `<div class="metric-card">
    <div class="metric-label">{{ label }}</div>
    <div class="metric-value" :class="tone"><span>{{ value }}</span><span v-if="unit" class="metric-unit">{{ unit }}</span></div>
    <div class="metric-foot">
      <span v-if="hint" class="metric-hint">{{ hint }}</span>
      <slot name="foot"></slot>
    </div>
  </div>`,
};

export const ToggleSwitch = {
  name: "ToggleSwitch",
  props: {
    modelValue: { type: Boolean, default: false },
    label: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:modelValue"],
  template: `<button type="button" class="switch-row" :class="{ 'is-on': modelValue }" role="switch"
    :aria-checked="modelValue" :disabled="disabled" @click="$emit('update:modelValue', !modelValue)">
    <span class="switch-track"><span class="switch-thumb"></span></span>
    <span v-if="label" class="switch-label">{{ label }}</span>
  </button>`,
};

export const CopyButton = {
  name: "CopyButton",
  components: { Icon },
  props: {
    text: { type: String, default: "" },
    label: { type: String, default: "复制" },
  },
  setup(props) {
    const copied = ref(false);
    async function copy() {
      try {
        await navigator.clipboard.writeText(props.text || "");
        copied.value = true;
        notify("success", "已复制到剪贴板");
        setTimeout(() => (copied.value = false), 1600);
      } catch {
        notify("error", "复制失败,请手动选择文本");
      }
    }
    return { copied, copy };
  },
  template: `<button type="button" class="btn btn-ghost btn-sm" @click="copy">
    <Icon :name="copied ? 'check' : 'copy'" :size="14" />{{ copied ? "已复制" : label }}
  </button>`,
};

export const Field = {
  name: "Field",
  props: {
    label: { type: String, default: "" },
    hint: { type: String, default: "" },
    error: { type: String, default: "" },
  },
  template: `<div class="field">
    <label v-if="label" class="field-label">{{ label }}</label>
    <slot></slot>
    <p v-if="error" class="field-error">{{ error }}</p>
    <p v-else-if="hint" class="field-hint">{{ hint }}</p>
  </div>`,
};

/**
 * 自走时的小组件。
 * 秒级时钟只让这一小块重绘,不会带着整页(尤其是几十行的日志列表)一起重新渲染。
 */
export const SimClock = {
  name: "SimClock",
  setup() {
    const now = ref(Date.now());
    const timer = setInterval(() => (now.value = Date.now()), 1000);
    onBeforeUnmount(() => clearInterval(timer));
    const label = computed(() => fmtSimClock(simNowMs(store.status, now.value)));
    return { label };
  },
  template: `<span class="sim-clock">{{ label }}</span>`,
};

export const RealClock = {
  name: "RealClock",
  setup() {
    const now = ref(Date.now());
    const timer = setInterval(() => (now.value = Date.now()), 1000);
    onBeforeUnmount(() => clearInterval(timer));
    const label = computed(() => fmtClock(now.value));
    return { label };
  },
  template: `<span class="real-clock">{{ label }}</span>`,
};

export const RelativeTime = {
  name: "RelativeTime",
  props: {
    ts: { type: Number, default: 0 },
    suffix: { type: String, default: "" },
  },
  setup(props) {
    const now = ref(Date.now());
    const timer = setInterval(() => (now.value = Date.now()), 10_000);
    onBeforeUnmount(() => clearInterval(timer));
    const label = computed(() => (props.ts ? relativeTime(props.ts, now.value) + props.suffix : "-"));
    return { label };
  },
  template: `<span class="relative-time">{{ label }}</span>`,
};
