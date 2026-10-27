import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "/vendor/vue.esm-browser.prod.js";
import { onLive } from "../live.js";
import { api } from "../api.js";
import { fetchActivity, setActivityLive, store } from "../store.js";
import { KIND_META } from "../meta.js";
import { debounce, fmtDateTime, fmtNum, relativeTime } from "../utils.js";

const KIND_OPTIONS = [
  { value: "thinking", label: "思考" },
  { value: "text", label: "输出" },
  { value: "tool_call", label: "工具调用" },
  { value: "tool_result", label: "工具结果" },
  { value: "error", label: "错误" },
];

export const ActivityPage = {
  name: "ActivityPage",
  setup() {
    const tab = ref("live");
    const selectedKinds = ref([]);
    const query = ref("");
    const follow = ref(true);
    const newCount = ref(0);
    const feedEl = ref(null);
    const now = ref(Date.now());

    const historyItems = ref([]);
    const historyTotal = ref(0);
    const historyPage = ref(1);
    const historyPageSize = ref(50);
    const historyLoading = ref(false);
    const historyError = ref("");

    const live = computed({
      get: () => store.activityLive,
      set: (v) => setActivityLive(v),
    });

    const liveEntries = computed(() => {
      const kinds = selectedKinds.value;
      if (!kinds.length) return store.activity;
      return store.activity.filter((e) => kinds.includes(e.kind));
    });

    const historyEntries = computed(() => historyItems.value);

    function kindMeta(kind) {
      return KIND_META[kind] || { label: kind, tone: "text" };
    }
    function toggleKind(kind) {
      selectedKinds.value = selectedKinds.value.includes(kind)
        ? selectedKinds.value.filter((k) => k !== kind)
        : [...selectedKinds.value, kind];
    }

    function scrollToBottom() {
      const el = feedEl.value;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      newCount.value = 0;
    }
    function scrollToLatest() {
      follow.value = true;
      nextTick(scrollToBottom);
    }
    function onScroll() {
      const el = feedEl.value;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
      if (nearBottom && !follow.value) {
        follow.value = true;
        newCount.value = 0;
      } else if (!nearBottom && follow.value) {
        follow.value = false;
      }
    }

    watch(
      () => liveEntries.value.length,
      (n, old) => {
        if (tab.value !== "live") return;
        if (follow.value) nextTick(scrollToBottom);
        else if (n > old) newCount.value += n - old;
      },
    );

    watch(tab, (v) => {
      if (v === "history") void loadHistory();
      else nextTick(scrollToBottom);
    });

    async function loadHistory() {
      historyLoading.value = true;
      try {
        const params = new URLSearchParams({
          page: String(historyPage.value),
          pageSize: String(historyPageSize.value),
        });
        if (selectedKinds.value.length) params.set("kinds", selectedKinds.value.join(","));
        if (query.value.trim()) params.set("q", query.value.trim());
        const r = await api(`/api/activity/history?${params.toString()}`);
        historyItems.value = r.items || [];
        historyTotal.value = r.total || 0;
        historyError.value = "";
      } catch (err) {
        historyError.value = err.message || "历史日志读取失败";
      } finally {
        historyLoading.value = false;
      }
    }

    const scheduleHistory = debounce(() => {
      historyPage.value = 1;
      if (tab.value === "history") void loadHistory();
    }, 320);

    watch(selectedKinds, () => scheduleHistory(), { deep: true });
    watch(query, () => scheduleHistory());

    function onPageChange(p) {
      historyPage.value = p;
      void loadHistory();
    }

    let ticker = null;
    let offLive = null;
    onMounted(() => {
      ticker = setInterval(() => (now.value = Date.now()), 3000);
      // 只有本页挂载时才会响应 activity 事件;数据拉取也只在此时发生
      offLive = onLive("activity", () => void fetchActivity());
      if (tab.value === "history") void loadHistory();
      else nextTick(scrollToBottom);
    });
    onBeforeUnmount(() => {
      clearInterval(ticker);
      offLive?.();
    });

    return {
      store,
      tab,
      selectedKinds,
      query,
      follow,
      newCount,
      feedEl,
      now,
      live,
      liveEntries,
      historyEntries,
      historyTotal,
      historyPage,
      historyPageSize,
      historyLoading,
      historyError,
      KIND_OPTIONS,
      kindMeta,
      toggleKind,
      onScroll,
      scrollToLatest,
      loadHistory,
      onPageChange,
      fmtDateTime,
      fmtNum,
      relativeTime,
    };
  },
  template: `<div class="page">
    <header class="page-head">
      <div>
        <h1>活动日志</h1>
        <p>思维链、输出与工具调用。实时模式只追加,不会重建列表。</p>
      </div>
      <div class="page-head-meta">
        <LiveDot :live="store.activityLive && !store.activityError" :label="store.activityError ? '同步失败' : store.activityLive ? '实时追加' : '已暂停'" />
        <span class="muted">{{ relativeTime(store.statusAt, now) }}更新</span>
      </div>
    </header>

    <section class="feed-panel">
      <div class="feed-toolbar">
        <SegmentedControl v-model="tab" :options="[{value:'live',label:'实时'},{value:'history',label:'历史'}]" label="日志模式" />
        <div class="feed-toolbar-spacer"></div>
        <template v-if="tab === 'live'">
          <ToggleSwitch v-model="live" label="实时追加" />
          <ToggleSwitch v-model="follow" label="跟随最新" @update:modelValue="follow && scrollToLatest()" />
        </template>
        <template v-else>
          <div class="search-box">
            <Icon name="search" :size="14" />
            <input v-model="query" type="text" placeholder="搜索日志内容" aria-label="搜索日志内容" />
          </div>
          <button class="btn btn-sm" :disabled="historyLoading" @click="loadHistory">
            <Spinner v-if="historyLoading" :size="13" /><Icon v-else name="refresh" :size="14" />刷新
          </button>
        </template>
      </div>

      <div class="filter-row" role="group" aria-label="按类型筛选">
        <button class="chip" :class="{ 'is-active': selectedKinds.length === 0 }" @click="selectedKinds = []">全部</button>
        <button v-for="k in KIND_OPTIONS" :key="k.value" class="chip" :class="{ 'is-active': selectedKinds.includes(k.value) }"
          :aria-pressed="selectedKinds.includes(k.value)" @click="toggleKind(k.value)">
          <span class="chip-dot" :class="'dot-' + kindMeta(k.value).tone"></span>{{ k.label }}
        </button>
        <span class="filter-count">{{ tab === 'live' ? liveEntries.length : fmtNum(historyTotal) }} 条</span>
      </div>

      <div v-if="store.activityError && tab === 'live'" class="banner banner-error">{{ store.activityError }}</div>
      <div v-if="historyError" class="banner banner-error">{{ historyError }}</div>

      <template v-if="tab === 'live'">
        <div ref="feedEl" class="log-feed" @scroll.passive="onScroll">
          <div v-if="!store.activityLive" class="feed-paused">实时追加已暂停。恢复后从当前缓冲重新读取。</div>
          <div v-if="!liveEntries.length" class="empty-inline">还没有日志。它下一次运行时会出现在这里。</div>
          <div v-for="e in liveEntries" :key="e.seq" class="log-item" :class="'is-' + e.kind">
            <div class="log-head">
              <span class="log-tag" :class="'tag-' + kindMeta(e.kind).tone">{{ kindMeta(e.kind).label }}</span>
              <span class="log-time">{{ fmtDateTime(e.tsSim) }}<span class="log-time-real">真实 {{ fmtDateTime(e.tsReal) }}</span></span>
            </div>
            <p class="log-text">{{ e.text }}</p>
          </div>
        </div>
        <div v-if="!follow && newCount > 0" class="feed-jump">
          <button class="btn btn-primary btn-sm" @click="scrollToLatest">回到最新 · {{ newCount }} 条新记录</button>
        </div>
      </template>

      <template v-else>
        <div class="log-feed log-feed-static">
          <div v-if="historyLoading && !historyEntries.length" class="loading-block"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
          <div v-else-if="!historyEntries.length" class="empty-inline">没有匹配的历史日志。</div>
          <div v-for="e in historyEntries" :key="e.id" class="log-item" :class="'is-' + e.kind">
            <div class="log-head">
              <span class="log-tag" :class="'tag-' + kindMeta(e.kind).tone">{{ kindMeta(e.kind).label }}</span>
              <span class="log-time">{{ fmtDateTime(e.tsSim) }}<span class="log-time-real">真实 {{ fmtDateTime(e.tsReal) }}</span></span>
            </div>
            <p class="log-text">{{ e.text }}</p>
          </div>
        </div>
        <Pagination :page="historyPage" :total="historyTotal" :page-size="historyPageSize" :disabled="historyLoading" @update:page="onPageChange" />
      </template>
    </section>
  </div>`,
};
