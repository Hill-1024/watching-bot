import { computed, onBeforeUnmount, onMounted, ref } from "/vendor/vue.esm-browser.prod.js";
import { api, postJSON } from "../api.js";
import { notify } from "../store.js";
import { relativeTime, renderMarkdown } from "../utils.js";

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** 文件自带的一级标题与面板标题重复,渲染时去掉第一行 H1 */
function stripLeadingTitle(md) {
  return String(md || "").replace(/^\s*#\s+.*(?:\r?\n)+/, "");
}

export const MemoryPage = {
  name: "MemoryPage",
  setup() {
    const data = ref(null);
    const loading = ref(false);
    const syncing = ref(false);
    const error = ref("");
    const selectedDate = ref("");
    const diary = ref(null);
    const diaryLoading = ref(false);
    const consolidating = ref(false);
    const now = ref(Date.now());

    const indexHtml = computed(() => {
      const text = stripLeadingTitle(data.value?.index || "");
      if (!text.trim()) return '<p class="muted">MEMORY.md 还是空的。它会在下一次睡眠归并后写入长期记忆。</p>';
      return renderMarkdown(text);
    });
    const diaries = computed(() => data.value?.diaries || []);
    const latestDate = computed(() => diaries.value[0]?.date || "");
    const diaryHtml = computed(() => (diary.value ? renderMarkdown(stripLeadingTitle(diary.value.content)) : ""));

    async function load(silent = false) {
      if (silent) syncing.value = true;
      else loading.value = true;
      try {
        const d = await api("/api/memory");
        const diariesChanged =
          !data.value || JSON.stringify(d.diaries) !== JSON.stringify(data.value.diaries);
        const indexChanged = !data.value || d.updatedAt !== data.value.updatedAt;
        // 内容没变就不替换响应式对象,避免 v-html 重绘把阅读滚动位置顶回顶部
        if (diariesChanged || indexChanged) data.value = d;
        error.value = "";
        if (!selectedDate.value && d.diaries?.length) {
          void selectDate(d.diaries[0].date);
        }
      } catch (err) {
        error.value = err.message || "记忆读取失败";
      } finally {
        loading.value = false;
        syncing.value = false;
      }
    }

    async function selectDate(date) {
      if (!date) return;
      selectedDate.value = date;
      diaryLoading.value = true;
      try {
        diary.value = await api(`/api/memory/diary?date=${encodeURIComponent(date)}`);
      } catch (err) {
        diary.value = null;
        notify("error", err.message || "日记读取失败");
      } finally {
        diaryLoading.value = false;
      }
    }

    async function consolidate() {
      if (consolidating.value) return;
      consolidating.value = true;
      notify("info", "已开始整理记忆,模型完成前请稍候");
      try {
        await postJSON("/api/consolidate");
        notify("success", "记忆整理完成");
        await load(true);
        if (selectedDate.value) await selectDate(selectedDate.value);
      } catch (err) {
        notify("error", err.message || "记忆整理失败");
      } finally {
        consolidating.value = false;
      }
    }

    let timer = null;
    onMounted(() => {
      void load();
      timer = setInterval(() => {
        if (document.hidden) return;
        now.value = Date.now();
        void load(true);
      }, 5000);
    });
    onBeforeUnmount(() => clearInterval(timer));

    return {
      data,
      loading,
      syncing,
      error,
      selectedDate,
      diary,
      diaryLoading,
      consolidating,
      now,
      indexHtml,
      diaries,
      latestDate,
      diaryHtml,
      load,
      selectDate,
      consolidate,
      fmtBytes,
      relativeTime,
    };
  },
  template: `<div class="page">
    <header class="page-head">
      <div>
        <h1>长期记忆</h1>
        <p>MEMORY.md 与每日日记。每 5 秒同步一次,不会打断当前阅读位置。</p>
      </div>
      <div class="page-head-meta">
        <LiveDot :live="!error" :label="syncing ? '同步中' : '自动同步'" />
        <span v-if="data" class="muted">MEMORY.md {{ relativeTime(data.updatedAt, now) }}更新</span>
        <button class="btn btn-sm" @click="load(false)"><Icon name="refresh" :size="14" />刷新</button>
        <button class="btn btn-primary btn-sm" :disabled="consolidating" @click="consolidate">
          <Spinner v-if="consolidating" :size="13" /><Icon v-else name="brain" :size="14" />立即整理
        </button>
      </div>
    </header>

    <div v-if="error" class="banner banner-error">{{ error }}</div>

    <div class="grid memory-grid">
      <Panel class="span-7" title="MEMORY.md" :subtitle="data?.indexPath || '长期记忆索引'">
        <template #actions>
          <CopyButton :text="data?.index || ''" label="复制全文" />
        </template>
        <div v-if="loading && !data" class="loading-block"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
        <article v-else class="markdown-body" v-html="indexHtml"></article>
      </Panel>

      <Panel class="span-5" title="日记" :subtitle="diaries.length ? '最近 ' + diaries.length + ' 篇' : '还没有日记'">
        <div v-if="!diaries.length" class="empty-inline">它还没有写过日记。睡觉时归并会生成第一篇。</div>
        <div v-else class="diary-list">
          <button v-for="d in diaries" :key="d.date" type="button" class="diary-item"
            :class="{ 'is-active': d.date === selectedDate }" @click="selectDate(d.date)">
            <span class="diary-date">{{ d.date }}<span v-if="d.date === latestDate" class="badge badge-sm">最新</span></span>
            <span class="diary-meta">{{ fmtBytes(d.bytes) }} · {{ relativeTime(d.updatedAt, now) }}</span>
            <span class="diary-preview">{{ d.preview }}</span>
          </button>
        </div>
      </Panel>

      <Panel class="span-12" :title="diary ? diary.date + ' 日记' : '日记内容'" :subtitle="diary ? '睡眠归并写下的当日记录' : '从右侧选择一天'">
        <div v-if="diaryLoading" class="loading-block"><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
        <article v-else-if="diary" class="markdown-body diary-body" v-html="diaryHtml"></article>
        <div v-else class="empty-inline">选择一篇日记查看完整内容。</div>
      </Panel>
    </div>
  </div>`,
};
