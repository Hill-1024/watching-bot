import { computed, onBeforeUnmount, onMounted, ref } from "/vendor/vue.esm-browser.prod.js";
import { postJSON } from "../api.js";
import { fetchStatus, logout, notify, store } from "../store.js";
import { durationText, fmtBytes, fmtNum } from "../utils.js";

/**
 * 系统页:只保留核心运行参数与核心动作。
 * 任何插件专用配置(咖啡、QQ 运行时、端口、token)都不在这里 —— 它们在插件自己的页面。
 */
export const SystemPage = {
  name: "SystemPage",
  setup() {
    const acting = ref("");
    const now = ref(Date.now());

    const status = computed(() => store.status);
    const uptime = computed(() => (status.value?.startedAt ? durationText(now.value - status.value.startedAt) : "-"));


    async function commitTimescale(value) {
      try {
        const r = await postJSON("/api/timescale", { value });
        notify("success", `timeScale 已切换为 ×${r.timeScale}`);
        await fetchStatus();
      } catch (err) {
        notify("error", err.message || "timeScale 切换失败");
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

    let ticker = null;
    onMounted(() => {
      ticker = setInterval(() => (now.value = Date.now()), 2000);
    });
    onBeforeUnmount(() => clearInterval(ticker));

    return {
      store, status, acting, uptime,
      commitTimescale, act, logout, fmtNum,
    };
  },
  template: `<div class="page">
    <header class="page-head">
      <div>
        <span class="eyebrow">核心</span>
        <h1>系统</h1>
        <p class="page-sub">模拟时钟、生命周期动作与进程运行参数。插件配置在各自的模块页面。</p>
      </div>
    </header>

    <div v-if="!status" class="panel"><LoadingBlock :rows="5" /></div>

    <div v-else class="grid">
      <Panel class="span-6" title="时间与动作" subtitle="模拟时钟的节奏由 timeScale 决定">
        <div class="kv-row"><span class="kv-key">模拟时间</span><span class="kv-value mono"><SimClock /></span></div>
        <div class="kv-row"><span class="kv-key">真实时间</span><span class="kv-value mono"><RealClock /></span></div>
        <div class="kv-row">
          <span class="kv-key">timeScale</span>
          <div class="kv-control">
            <NumberField :model-value="status.timeScale" :min="1" :max="100000" :step="1" suffix="×"
              hint="模拟时间倍率:1 表示与真实时间同步,120 表示模拟时间比真实时间快 120 倍"
              label="timeScale" @commit="commitTimescale" />
          </div>
        </div>
        <div class="kv-row"><span class="kv-key">运行时长</span><span class="kv-value">{{ uptime }}</span></div>
        <div class="divider"></div>
        <div class="btn-row">
          <button class="btn" :disabled="acting === '/api/sleep'" @click="act('/api/sleep', '已请求入睡')"><Icon name="bed" :size="15" />强制入睡</button>
          <button class="btn" :disabled="acting === '/api/wake'" @click="act('/api/wake', '已强制唤醒')"><Icon name="sunrise" :size="15" />强制唤醒</button>
          <button class="btn" :disabled="acting === '/api/consolidate'" @click="act('/api/consolidate', '记忆整理完成')"><Icon name="brain" :size="15" />整理记忆</button>
        </div>
      </Panel>

      <Panel class="span-6" title="进程与数据">
        <div class="info-grid">
          <div class="info-cell"><span>面板端口</span><b>{{ status.panel?.port ?? '-' }}</b></div>
          <div class="info-cell"><span>鉴权</span><b>{{ status.panel?.authRequired ? '已开启' : '未开启' }}</b></div>
          <div class="info-cell"><span>活动序列</span><b>{{ fmtNum(status.activityLastSeq) }}</b></div>
          <div class="info-cell"><span>数据库</span><b>{{ fmtBytes(status.dbBytes) }}</b></div>
          <div class="info-cell"><span>MEMORY.md</span><b><RelativeTime :ts="status.memoryUpdatedAt" /></b></div>
          <div class="info-cell"><span>待响闹钟</span><b>{{ status.pendingAlarms }}</b></div>
          <div class="info-cell"><span>插件数量</span><b>{{ status.plugins?.length ?? 0 }}</b></div>
        </div>
        <div class="btn-row panel-footer">
          <button class="btn btn-ghost" @click="logout"><Icon name="logout" :size="15" />退出面板</button>
        </div>
      </Panel>
    </div>
  </div>`,
};
