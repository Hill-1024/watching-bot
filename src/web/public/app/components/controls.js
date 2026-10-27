import { computed, onBeforeUnmount, onMounted, ref, watch } from "/vendor/vue.esm-browser.prod.js";
import { notify, setVar } from "../store.js";
import { clamp, dateToIso, isoToDate } from "../utils.js";

function fmtVal(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * 状态变量编辑器。核心目标:轮询更新永远不覆盖正在输入的内容。
 * 草稿只在聚焦/脏状态下由用户掌控,失焦或 Enter 才提交。
 */
export const VariableControl = {
  name: "VariableControl",
  components: {},
  props: {
    name: { type: String, required: true },
    label: { type: String, required: true },
    value: { type: Number, default: 0 },
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    step: { type: Number, default: 1 },
    unit: { type: String, default: "" },
    hint: { type: String, default: "" },
  },
  setup(props) {
    const draft = ref(fmtVal(props.value));
    const focused = ref(false);
    const hovered = ref(false);
    const dirty = ref(false);
    const saving = ref(false);
    const saved = ref(false);
    let savedTimer = null;

    const percent = computed(() => {
      const span = props.max - props.min || 1;
      return `${clamp(((Number(draft.value) || 0) - props.min) / span, 0, 1) * 100}%`;
    });

    watch(
      () => props.value,
      (v) => {
        // 正在编辑或鼠标停在控件上时不跟着后台状态跳,避免滑块/数字在指针下抖动
        if (!focused.value && !hovered.value && !dirty.value && !saving.value) draft.value = fmtVal(v);
      },
    );

    function flashSaved() {
      saved.value = true;
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (saved.value = false), 1500);
    }

    function resetDraft() {
      draft.value = fmtVal(props.value);
      dirty.value = false;
    }

    async function save(value) {
      if (!Number.isFinite(value)) {
        resetDraft();
        notify("error", `${props.label}的数值无效`);
        return;
      }
      const clamped = clamp(value, props.min, props.max);
      const outOfRange = clamped !== value;
      draft.value = fmtVal(clamped);
      dirty.value = false;
      saving.value = true;
      try {
        const r = await setVar(props.name, clamped);
        if (typeof r.applied === "number") draft.value = fmtVal(r.applied);
        if (outOfRange || r.clamped) notify("info", `${props.label}已限制在 ${props.min} 到 ${props.max}`);
        flashSaved();
      } catch (err) {
        notify("error", err.message || `${props.label}保存失败`);
        resetDraft();
      } finally {
        saving.value = false;
      }
    }

    function onInput(e) {
      draft.value = e.target.value;
      dirty.value = true;
    }

    function onFocus(e) {
      focused.value = true;
      e.target.select?.();
    }

    function onBlur() {
      focused.value = false;
      if (dirty.value) void save(Number.parseFloat(draft.value));
      else draft.value = fmtVal(props.value);
    }

    function onKeydown(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        e.target.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        resetDraft();
        e.target.blur();
      }
    }

    function onRange(e) {
      draft.value = e.target.value;
      dirty.value = true;
    }

    function onRangeCommit() {
      if (dirty.value) void save(Number.parseFloat(draft.value));
    }

    function nudge(dir) {
      const base = Number.parseFloat(draft.value);
      const next = clamp((Number.isFinite(base) ? base : props.value) + dir * props.step, props.min, props.max);
      dragSave(next);
    }

    function dragSave(next) {
      draft.value = fmtVal(next);
      dirty.value = false;
      void save(next);
    }

    onBeforeUnmount(() => {
      if (savedTimer) clearTimeout(savedTimer);
    });

    return {
      draft,
      focused,
      hovered,
      dirty,
      saving,
      saved,
      percent,
      onInput,
      onFocus,
      onBlur,
      onKeydown,
      onRange,
      onRangeCommit,
      nudge,
    };
  },
  template: `<div class="var-control" :class="{ 'is-editing': focused, 'is-saving': saving }"
      @mouseenter="hovered = true" @mouseleave="hovered = false">
    <div class="vc-head">
      <div class="vc-title">
        <span class="vc-name">{{ label }}</span>
        <span class="vc-code">{{ name }}</span>
      </div>
      <span class="vc-state" aria-live="polite">
        <Spinner v-if="saving" :size="12" />
        <Icon v-else-if="saved" name="check" :size="13" />
      </span>
    </div>
    <div class="vc-main">
      <button type="button" class="vc-step" :disabled="saving" :aria-label="label + ' 减少 ' + step" @click="nudge(-1)">
        <Icon name="minus" :size="15" />
      </button>
      <div class="vc-input-wrap">
        <input class="vc-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
          :value="draft" :aria-label="label + ' 数值'" @input="onInput" @focus="onFocus" @blur="onBlur" @keydown="onKeydown" />
        <span v-if="unit" class="vc-unit">{{ unit }}</span>
      </div>
      <button type="button" class="vc-step" :disabled="saving" :aria-label="label + ' 增加 ' + step" @click="nudge(1)">
        <Icon name="plus" :size="15" />
      </button>
    </div>
    <div class="vc-range-wrap">
      <div class="vc-range-track"><span :style="{ width: percent }"></span></div>
      <input class="vc-range" type="range" :min="min" :max="max" :step="step" :value="draft"
        :aria-label="label + ' 滑块'" :aria-valuemin="min" :aria-valuemax="max" :aria-valuenow="Number(draft) || 0"
        @input="onRange" @change="onRangeCommit" />
    </div>
    <div class="vc-foot">
      <span class="vc-bound">{{ min }}</span>
      <span class="vc-hint">{{ hint }}</span>
      <span class="vc-bound">{{ max }}</span>
    </div>
  </div>`,
};

export const NumberField = {
  name: "NumberField",
  props: {
    modelValue: { type: Number, default: 0 },
    min: { type: Number, default: -Infinity },
    max: { type: Number, default: Infinity },
    step: { type: Number, default: 1 },
    label: { type: String, default: "" },
    suffix: { type: String, default: "" },
    hint: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
    width: { type: String, default: "" },
  },
  emits: ["commit"],
  setup(props, { emit }) {
    const draft = ref(fmtVal(props.modelValue));
    const focused = ref(false);
    const dirty = ref(false);
    const saving = ref(false);
    watch(
      () => props.modelValue,
      (v) => {
        if (!focused.value && !dirty.value) draft.value = fmtVal(v);
      },
    );
    function commit() {
      const n = Number.parseFloat(draft.value);
      if (!Number.isFinite(n)) {
        draft.value = fmtVal(props.modelValue);
        dirty.value = false;
        return;
      }
      const clamped = clamp(n, props.min, props.max);
      draft.value = fmtVal(clamped);
      dirty.value = false;
      emit("commit", clamped);
    }
    function onBlur() {
      focused.value = false;
      if (dirty.value) commit();
    }
    function onKeydown(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        e.target.blur();
      }
    }
    function nudge(dir) {
      const base = Number.parseFloat(draft.value);
      const next = clamp((Number.isFinite(base) ? base : props.modelValue) + dir * props.step, props.min, props.max);
      draft.value = fmtVal(next);
      dirty.value = false;
      emit("commit", next);
    }
    return { draft, focused, dirty, saving, commit, onBlur, onKeydown, nudge };
  },
  template: `<div class="number-field" :style="width ? { width } : undefined">
    <button type="button" class="nf-step" :disabled="disabled" :aria-label="label + ' 减少'" @click="nudge(-1)">
      <Icon name="minus" :size="14" />
    </button>
    <div class="nf-input-wrap">
      <input class="nf-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false"
        :value="draft" :disabled="disabled" :aria-label="label || '数值'"
        @input="draft = $event.target.value; dirty = true" @focus="focused = true; $event.target.select()" @blur="onBlur" @keydown="onKeydown" />
    </div>
    <span v-if="suffix" class="nf-suffix" :title="hint || undefined">{{ suffix }}</span>
    <button type="button" class="nf-step" :disabled="disabled" :aria-label="label + ' 增加'" @click="nudge(1)">
      <Icon name="plus" :size="14" />
    </button>
  </div>`,
};

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

export const DateField = {
  name: "DateField",
  props: {
    modelValue: { type: String, default: "" },
    label: { type: String, default: "日期" },
    min: { type: String, default: "" },
    max: { type: String, default: "" },
    placeholder: { type: String, default: "选择日期" },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const root = ref(null);
    const open = ref(false);
    const todayIso = dateToIso(Date.now());
    const initial = props.modelValue ? isoToDate(props.modelValue) : new Date();
    const view = ref(new Date(initial.getFullYear(), initial.getMonth(), 1));

    const viewLabel = computed(() => `${view.value.getFullYear()} 年 ${view.value.getMonth() + 1} 月`);
    const days = computed(() => {
      const y = view.value.getFullYear();
      const m = view.value.getMonth();
      const first = new Date(y, m, 1);
      const offset = (first.getDay() + 6) % 7;
      const start = new Date(y, m, 1 - offset);
      const out = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const iso = dateToIso(d);
        out.push({
          iso,
          day: d.getDate(),
          inMonth: d.getMonth() === m,
          isToday: iso === todayIso,
          isSelected: iso === props.modelValue,
          disabled: Boolean((props.min && iso < props.min) || (props.max && iso > props.max)),
        });
      }
      return out;
    });

    function shiftMonth(n) {
      view.value = new Date(view.value.getFullYear(), view.value.getMonth() + n, 1);
    }
    function pick(d) {
      if (d.disabled) return;
      emit("update:modelValue", d.iso);
      open.value = false;
    }
    function goToday() {
      const d = new Date();
      view.value = new Date(d.getFullYear(), d.getMonth(), 1);
      emit("update:modelValue", dateToIso(d));
      open.value = false;
    }
    function onDocPointer(e) {
      if (root.value && !root.value.contains(e.target)) open.value = false;
    }
    function onKeydown(e) {
      if (e.key === "Escape") open.value = false;
    }
    onMounted(() => document.addEventListener("pointerdown", onDocPointer));
    onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocPointer));

    return { root, open, weekdays: WEEKDAYS, viewLabel, days, shiftMonth, pick, goToday, onKeydown, todayIso };
  },
  template: `<div class="date-field" ref="root" @keydown="onKeydown">
    <button type="button" class="date-trigger" :class="{ 'is-open': open }" :aria-expanded="open" :aria-label="label" @click="open = !open">
      <Icon name="calendar" :size="15" />
      <span class="date-value" :class="{ 'is-placeholder': !modelValue }">{{ modelValue || placeholder }}</span>
      <Icon name="chevronDown" :size="13" class="date-chevron" />
    </button>
    <Transition name="pop">
      <div v-if="open" class="date-pop" role="dialog" :aria-label="label + ' 日历'">
        <div class="date-pop-head">
          <button type="button" class="btn-icon btn-ghost btn-sm" aria-label="上个月" @click="shiftMonth(-1)"><Icon name="chevronLeft" :size="15" /></button>
          <span class="date-month">{{ viewLabel }}</span>
          <button type="button" class="btn-icon btn-ghost btn-sm" aria-label="下个月" @click="shiftMonth(1)"><Icon name="chevronRight" :size="15" /></button>
        </div>
        <div class="date-weekdays"><span v-for="w in weekdays" :key="w">{{ w }}</span></div>
        <div class="date-grid">
          <button v-for="d in days" :key="d.iso" type="button" class="date-day"
            :class="{ 'is-other': !d.inMonth, 'is-today': d.isToday, 'is-selected': d.isSelected }"
            :disabled="d.disabled" :aria-label="d.iso" :aria-current="d.isSelected ? 'date' : undefined" @click="pick(d)">{{ d.day }}</button>
        </div>
        <div class="date-pop-foot">
          <button type="button" class="btn btn-ghost btn-sm" @click="goToday">今天</button>
          <span class="date-pop-hint">左右切换月份</span>
        </div>
      </div>
    </Transition>
  </div>`,
};

export const SegmentedControl = {
  name: "SegmentedControl",
  props: {
    modelValue: { type: [String, Number], default: "" },
    options: { type: Array, default: () => [] },
    label: { type: String, default: "" },
  },
  emits: ["update:modelValue"],
  template: `<div class="segmented" role="group" :aria-label="label">
    <button v-for="o in options" :key="o.value" type="button" class="segmented-item"
      :class="{ 'is-active': o.value === modelValue }" :aria-pressed="o.value === modelValue"
      @click="$emit('update:modelValue', o.value)">{{ o.label }}</button>
  </div>`,
};

export const SelectField = {
  name: "SelectField",
  props: {
    modelValue: { type: [String, Number], default: "" },
    options: { type: Array, default: () => [] },
    label: { type: String, default: "" },
    disabled: { type: Boolean, default: false },
  },
  emits: ["update:modelValue"],
  template: `<div class="select-field">
    <select class="select-native" :value="modelValue" :aria-label="label" :disabled="disabled"
      @change="$emit('update:modelValue', $event.target.value)">
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
    <Icon name="chevronDown" :size="14" class="select-chevron" />
  </div>`,
};
