import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "/vendor/vue.esm-browser.prod.js";
import { onLive } from "../live.js";
import { api } from "../api.js";
import { fetchInjections, setInjectionsLive, store } from "../store.js";
import { fmtDateTime, fmtNum, relativeTime } from "../utils.js";

export const InjectionsPage = {
  name: "InjectionsPage",
  setup() {
    const tab = ref("live");
    const channel = ref("");
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
      get: () => store.injectionsLive,
      set: (v) => setInjectionsLive(v),
    });

    const liveEntries = computed(() =>
      channel.value ? store.injections.filter((i) => i.channel === channel.value) : store.injections,
    );

    function channelLabel(ch) {
      return ch === "feeling" ? "体感" : "环境";
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
    watch(channel, () => {
      if (tab.value === "history") {
        historyPage.value = 1;
        void loadHistory();
      }
    });

    async function loadHistory() {
      historyLoading.value = true;
      try {
        const params = new URLSearchParams({
          page: String(historyPage.value),
          pageSize: String(historyPageSize.value),
        });
        if (channel.value) params.set("channel", channel.value);
        const r = await api(`/api/injections?${params.toString()}`);
        historyItems.value = r.items || [];
        historyTotal.value = r.total || 0;
        historyError.value = "";
      } catch (err) {
        historyError.value = err.message || "注入历史读取失败";
      } finally {
        historyLoading.value = false;
      }
    }

    function onPageChange(p) {
      historyPage.value = p;
      void loadHistory();
    }

    let ticker = null;
    let offLive = null;
    onMounted(() => {
      ticker = setInterval(() => (now.value = Date.now()), 5000);
      // 只有本页挂载时才响应 injections 事件并增量拉取
      offLive = onLive("injections", () => void fetchInjections());
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
      channel,
      follow,
      newCount,
      feedEl,
      now,
      live,
      liveEntries,
      historyItems,
      historyTotal,
      historyPage,
      historyPageSize,
      historyLoading,
      historyError,
      channelLabel,
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
        <h1>感知注入</h1>
        <p>体感与环境的原话,是它行为的输入侧证据。</p>
      </div>
      <div class="page-head-meta">
        <LiveDot :live="store.injectionsLive && !store.injectionError" :label="store.injectionError ? '同步失败' : store.injectionsLive ? '实时追加' : '已暂停'" />
        <span class="muted">{{ relativeTime(store.statusAt, now) }}更新</span>
      </div>
    </header>

    <section class="feed-panel">
      <div class="feed-toolbar">
        <SegmentedControl v-model="tab" :options="[{value:'live',label:'实时'},{value:'history',label:'历史'}]" label="注入模式" />
        <div class="feed-toolbar-spacer"></div>
        <template v-if="tab === 'live'">
          <ToggleSwitch v-model="live" label="实时追加" />
          <ToggleSwitch v-model="follow" label="跟随最新" @update:modelValue="follow && scrollToLatest()" />
        </template>
        <template v-else>
          <button class="btn btn-sm" :disabled="historyLoading" @click="loadHistory">
            <Spinner v-if="historyLoading" :size="13" /><Icon v-else name="refresh" :size="14" />刷新
          </button>
        </template>
      </div>

      <div class="filter-row" role="group" aria-label="按渠道筛选">
        <button class="chip" :class="{ 'is-active': channel === '' }" @click="channel = ''">全部</button>
        <button class="chip" :class="{ 'is-active': channel === 'feeling' }" @click="channel = 'feeling'"><span class="chip-dot dot-warm"></span>体感</button>
        <button class="chip" :class="{ 'is-active': channel === 'env' }" @click="channel = 'env'"><span class="chip-dot dot-cool"></span>环境</button>
        <span class="filter-count">{{ tab === 'live' ? liveEntries.length : fmtNum(historyTotal) }} 条</span>
      </div>

      <div v-if="store.injectionError && tab === 'live'" class="banner banner-error">{{ store.injectionError }}</div>
      <div v-if="historyError" class="banner banner-error">{{ historyError }}</div>

      <template v-if="tab === 'live'">
        <div ref="feedEl" class="log-feed" @scroll.passive="onScroll">
          <div v-if="!store.injectionsLive" class="feed-paused">实时追加已暂停。</div>
          <div v-if="!liveEntries.length" class="empty-inline">还没有注入记录。</div>
          <div v-for="i in liveEntries" :key="i.id" class="injection-item is-feed">
            <div class="log-head">
              <span class="log-tag" :class="i.channel === 'feeling' ? 'tag-warm' : 'tag-cool'">{{ channelLabel(i.channel) }} · {{ i.kind }}<template v-if="i.tier"> · 强度 {{ i.tier }}</template></span>
              <span class="log-time">{{ fmtDateTime(i.ts_sim) }}</span>
            </div>
            <p class="log-text">{{ i.text }}</p>
          </div>
        </div>
        <div v-if="!follow && newCount > 0" class="feed-jump">
          <button class="btn btn-primary btn-sm" @click="scrollToLatest">回到最新 · {{ newCount }} 条新记录</button>
        </div>
      </template>

      <template v-else>
        <div class="log-feed log-feed-static">
          <div v-if="historyLoading && !historyItems.length" class="loading-block"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
          <div v-else-if="!historyItems.length" class="empty-inline">没有匹配的注入记录。</div>
          <div v-for="i in historyItems" :key="i.id" class="injection-item is-feed">
            <div class="log-head">
              <span class="log-tag" :class="i.channel === 'feeling' ? 'tag-warm' : 'tag-cool'">{{ channelLabel(i.channel) }} · {{ i.kind }}<template v-if="i.tier"> · 强度 {{ i.tier }}</template></span>
              <span class="log-time">{{ fmtDateTime(i.ts_sim) }}</span>
            </div>
            <p class="log-text">{{ i.text }}</p>
          </div>
        </div>
        <Pagination :page="historyPage" :total="historyTotal" :page-size="historyPageSize" :disabled="historyLoading" @update:page="onPageChange" />
      </template>
    </section>
  </div>`,
};
