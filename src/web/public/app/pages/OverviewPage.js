import { computed, onBeforeUnmount, onMounted, ref } from "/vendor/vue.esm-browser.prod.js";
import { onLive } from "../live.js";
import { api, postJSON } from "../api.js";
import { fetchStatus, notify, store } from "../store.js";
import { KIND_META, VAR_META } from "../meta.js";
import {
  compactNum,
  debounce,
  durationText,
  fmtClock,
  fmtDay,
  fmtNum,
  fmtPct,
  HOUR_MS,
  navigate,
  renderMarkdown,
  setIfChanged,
  startOfDay,
} from "../utils.js";

export const OverviewPage = {
  name: "OverviewPage",
  setup() {
    const history = ref(null);
    const usageToday = ref(null);
    const memory = ref(null);
    const acting = ref("");
    const consolidating = ref(false);

    const status = computed(() => store.status);

    const varList = computed(() =>
      Object.entries(status.value?.defs || {}).map(([name, def]) => ({
        name,
        min: def.min,
        max: def.max,
        init: def.init,
        ...(VAR_META[name] || { label: name, hint: "", color: "var(--accent)" }),
      })),
    );

    const historyByVar = computed(() => {
      const out = {};
      const items = history.value?.items || [];
      for (const v of varList.value) {
        out[v.name] = items.map((r) => r.vars?.[v.name]).filter((n) => typeof n === "number");
      }
      return out;
    });

    function deltaText(name) {
      const pts = historyByVar.value[name] || [];
      if (pts.length < 2) return "近 2 小时";
      const d = pts[pts.length - 1] - pts[0];
      const sign = d > 0 ? "+" : "";
      return `近 2 小时 ${sign}${(Math.round(d * 10) / 10).toFixed(1)}`;
    }

    const sleepText = computed(() => {
      const s = status.value;
      if (!s) return "-";
      if (!s.sleepStartedSim) return "未在睡";
      return durationText(Math.max(0, s.simMs - s.sleepStartedSim));
    });

    const uptimeText = computed(() => {
      if (!status.value?.startedAt) return "-";
      return durationText(Date.now() - status.value.startedAt);
    });

    const usageSpark = computed(() => (usageToday.value?.buckets || []).map((b) => b.total));
    const usageTotals = computed(() => usageToday.value?.totals || null);
    const latestDiary = computed(() => memory.value?.diaries?.[0] || null);
    const memoryPreviewHtml = computed(() => {
      const text = (memory.value?.index || "").replace(/^\s*#\s+.*(?:\r?\n)+/, "");
      if (!text.trim()) return '<p class="muted">MEMORY.md 还是空的。</p>';
      return renderMarkdown(text.slice(0, 1100));
    });

    const activityRecent = computed(() => store.activity.slice(-8).reverse());
    const injectionsRecent = computed(() => store.injections.slice(-6).reverse());

    function kindMeta(kind) {
      return KIND_META[kind] || { label: kind, tone: "text" };
    }
    function truncate(s, n) {
      const text = String(s || "").replace(/\s+/g, " ").trim();
      return text.length > n ? `${text.slice(0, n)}...` : text;
    }
    function channelLabel(ch) {
      return ch === "feeling" ? "体感" : "环境";
    }

    async function loadHistory() {
      const s = store.status;
      if (!s) return;
      try {
        const until = s.simMs + 1;
        const since = s.simMs - 2 * HOUR_MS;
        setIfChanged(history, await api(`/api/history?since=${since}&until=${until}&points=160`));
      } catch {
        // 概览页不因为曲线失败打断主信息
      }
    }

    async function loadUsage() {
      try {
        const nowMs = Date.now();
        const since = startOfDay(nowMs);
        setIfChanged(usageToday, await api(`/api/usage?since=${since}&until=${nowMs}`));
      } catch {
        // 统计接口不可用时保留旧数据
      }
    }

    async function loadMemory() {
      try {
        setIfChanged(memory, await api("/api/memory"));
      } catch {
        // 记忆接口不可用时保留旧数据
      }
    }

    async function act(path, label) {
      if (acting.value) return;
      acting.value = path;
      try {
        await postJSON(path);
        notify("success", label);
        await fetchStatus();
      } catch (err) {
        notify("error", err.message || "操作失败");
      } finally {
        acting.value = "";
      }
    }

    async function consolidate() {
      if (consolidating.value) return;
      consolidating.value = true;
      notify("info", "已开始整理记忆,模型完成前请稍候");
      try {
        await postJSON("/api/consolidate");
        notify("success", "记忆整理完成");
        await loadMemory();
      } catch (err) {
        notify("error", err.message || "记忆整理失败");
      } finally {
        consolidating.value = false;
      }
    }

    // 只订阅概览真正需要的 topic;活动/注入等其他页面的变化不会让概览重绘
    const scheduleHistory = debounce(() => void loadHistory(), 1200);
    const scheduleUsage = debounce(() => void loadUsage(), 1500);
    const scheduleMemory = debounce(() => void loadMemory(), 800);
    const offs = [];

    onMounted(() => {
      void loadHistory();
      void loadUsage();
      void loadMemory();
      offs.push(onLive("state", scheduleHistory));
      offs.push(onLive("usage", scheduleUsage));
      offs.push(onLive("memory", scheduleMemory));
    });
    onBeforeUnmount(() => {
      for (const off of offs) off();
    });

    return {
      store,
      status,
      varList,
      historyByVar,
      deltaText,
      sleepText,
      uptimeText,
      usageSpark,
      usageTotals,
      memory,
      latestDiary,
      memoryPreviewHtml,
      activityRecent,
      injectionsRecent,
      acting,
      consolidating,
      kindMeta,
      truncate,
      channelLabel,
      act,
      consolidate,
      navigate,
      fmtClock,
      fmtDay,
      fmtNum,
      fmtPct,
      compactNum,
        };
  },
  template: `<div class="page">
    <header class="page-head">
      <div>
        <h1>概览</h1>
        <p>它此刻的身体状态、最近的行为与消耗。</p>
      </div>
      <div class="page-head-meta">
        <LiveDot :live="store.live.connected && !store.statusError" :label="store.statusError ? '连接中断' : '实时同步'" />
        <RelativeTime :ts="store.statusAt" class="muted" />
      </div>
    </header>

    <div v-if="!status" class="panel">
      <LoadingBlock :rows="4" />
    </div>

    <template v-else>
      <section class="status-hero">
        <div class="hero-status">
          <StatusPill :phase="status.phase" />
          <SimClock class="hero-sim" />
          <div class="hero-sub">模拟时间 · 真实 <RealClock /> · timeScale ×{{ status.timeScale }}</div>
        </div>
        <div class="hero-stats">
          <div class="hero-stat"><span>本段睡眠</span><b>{{ sleepText }}</b></div>
          <div class="hero-stat"><span>赖床次数</span><b>{{ status.snoozeCount }}</b></div>
          <div class="hero-stat"><span>待响闹钟</span><b>{{ status.pendingAlarms }}</b></div>
          <div class="hero-stat"><span>运行时长</span><b>{{ uptimeText }}</b></div>
        </div>
        <div class="hero-actions">
          <button class="btn" :disabled="acting === '/api/sleep'" @click="act('/api/sleep', '已请求入睡')">
            <Icon name="bed" :size="15" />强制入睡
          </button>
          <button class="btn" :disabled="acting === '/api/wake'" @click="act('/api/wake', '已强制唤醒')">
            <Icon name="sunrise" :size="15" />强制唤醒
          </button>
          <button class="btn btn-primary" :disabled="consolidating" @click="consolidate">
            <Spinner v-if="consolidating" :size="13" /><Icon v-else name="brain" :size="15" />整理记忆
          </button>
        </div>
      </section>

      <section class="var-grid" aria-label="状态变量,可直接调整">
        <div v-for="v in varList" :key="v.name" class="var-card">
          <VariableControl :name="v.name" :label="v.label" :value="status.vars[v.name] ?? 0"
            :min="v.min" :max="v.max" :step="1" :hint="v.hint" />
          <div class="var-spark">
            <Sparkline :values="historyByVar[v.name]" :min="v.min" :max="v.max" :color="v.color" :height="34" />
            <span class="var-delta">{{ deltaText(v.name) }}</span>
          </div>
        </div>
      </section>

      <div class="overview-columns">
        <div class="overview-col">
          <Panel title="最近活动" subtitle="思维链、输出与工具调用">
            <template #actions>
              <button class="btn btn-ghost btn-sm" @click="navigate('activity')">查看全部 <Icon name="arrowRight" :size="13" /></button>
            </template>
            <div v-if="!activityRecent.length" class="empty-inline">还没有活动记录。</div>
            <div v-else class="activity-list is-compact">
              <div v-for="e in activityRecent" :key="e.seq" class="log-item">
                <span class="log-time">{{ fmtDay(e.tsSim) }} {{ fmtClock(e.tsSim) }}</span>
                <span class="log-tag" :class="'tag-' + kindMeta(e.kind).tone">{{ kindMeta(e.kind).label }}</span>
                <span class="log-text">{{ truncate(e.text, 150) }}</span>
              </div>
            </div>
          </Panel>


          <Panel title="长期记忆" subtitle="MEMORY.md 的最近状态">
            <template #actions>
              <button class="btn btn-ghost btn-sm" @click="navigate('memory')">打开记忆页 <Icon name="arrowUpRight" :size="13" /></button>
            </template>
            <div v-if="!memory" class="empty-inline">正在读取记忆...</div>
            <template v-else>
              <div class="memory-preview" v-html="memoryPreviewHtml"></div>
              <div v-if="latestDiary" class="memory-foot">
                <span>最近日记 {{ latestDiary.date }}</span>
                <RelativeTime :ts="memory.updatedAt" />
              </div>
            </template>
          </Panel>
        </div>

        <div class="overview-col">
          <Panel title="今日 Token" subtitle="从今天零点累计">
            <template #actions>
              <button class="btn btn-ghost btn-sm" @click="navigate('usage')">统计详情 <Icon name="arrowUpRight" :size="13" /></button>
            </template>
            <div v-if="!usageTotals" class="empty-inline">正在读取用量...</div>
            <template v-else>
              <div class="usage-hero-number">{{ compactNum(usageTotals.total) }}<span class="unit">tokens</span></div>
              <div class="usage-hero-row">
                <span>{{ fmtNum(usageTotals.requests) }} 次调用</span>
                <span>命中率 {{ fmtPct(usageTotals.cacheHitRate) }}</span>
              </div>
              <Sparkline :values="usageSpark" :min="0" :max="Math.max(1, ...usageSpark)" color="var(--chart-total)" :height="56" />
              <div class="usage-breakdown">
                <span>输入 {{ compactNum(usageTotals.input) }}</span>
                <span>输出 {{ compactNum(usageTotals.output) }}</span>
                <span>缓存 {{ compactNum(usageTotals.cacheRead) }}</span>
              </div>
            </template>
          </Panel>


          <Panel title="感知注入" subtitle="它最近感受到了什么">
            <template #actions>
              <button class="btn btn-ghost btn-sm" @click="navigate('injections')">查看全部 <Icon name="arrowRight" :size="13" /></button>
            </template>
            <div v-if="!injectionsRecent.length" class="empty-inline">还没有注入记录。</div>
            <div v-else class="injection-list">
              <div v-for="i in injectionsRecent" :key="i.id" class="injection-item">
                <span class="log-tag" :class="i.channel === 'feeling' ? 'tag-warm' : 'tag-cool'">{{ channelLabel(i.channel) }} · {{ i.kind }}</span>
                <span class="injection-time">{{ fmtDay(i.ts_sim) }} {{ fmtClock(i.ts_sim) }}</span>
                <p>{{ truncate(i.text, 180) }}</p>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </template>
  </div>`,
};
