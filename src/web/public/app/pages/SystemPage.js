import { computed, onBeforeUnmount, onMounted, ref } from "/vendor/vue.esm-browser.prod.js";
import { api, postJSON } from "../api.js";
import { fetchStatus, logout, notify, store } from "../store.js";
import { durationText, fmtFullDate, fmtNum, relativeTime } from "../utils.js";

export const SystemPage = {
  name: "SystemPage",
  setup() {
    const coffee = ref(null);
    const acting = ref("");
    const toggling = ref("");
    const now = ref(Date.now());

    const status = computed(() => store.status);
    const moduleRows = computed(() => {
      const s = status.value;
      if (!s) return [];
      const running = new Map((s.modules || []).map((m) => [m.name, m]));
      const names = [...new Set([...(s.knownModules || []), ...running.keys()])];
      return names.map((name) => {
        const m = running.get(name);
        return {
          name,
          running: Boolean(m),
          summary: m?.summary || "未启用",
          tools: m?.toolNames || [],
        };
      });
    });
    const uptime = computed(() => (status.value?.startedAt ? durationText(now.value - status.value.startedAt) : "-"));
    const memoryUpdated = computed(() => (status.value?.memoryUpdatedAt ? relativeTime(status.value.memoryUpdatedAt, now.value) : "-"));

    async function loadCoffee() {
      try {
        coffee.value = await api("/api/coffee");
      } catch {
        coffee.value = null;
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

    async function toggleModule(row) {
      if (toggling.value) return;
      toggling.value = row.name;
      try {
        await postJSON("/api/modules", { name: row.name, enable: !row.running });
        notify("success", row.running ? `已停用 ${row.name}` : `已启用 ${row.name}`);
        await fetchStatus();
        await loadCoffee();
      } catch (err) {
        notify("error", err.message || "模块切换失败");
      } finally {
        toggling.value = "";
      }
    }

    let ticker = null;
    onMounted(() => {
      void loadCoffee();
      ticker = setInterval(() => (now.value = Date.now()), 2000);
    });
    onBeforeUnmount(() => clearInterval(ticker));

    return {
      store,
      status,
      moduleRows,
      coffee,
      acting,
      toggling,
      now,
      uptime,
      memoryUpdated,
      loadCoffee,
      commitTimescale,
      act,
      claimCoffee,
      toggleModule,
      logout,
      fmtFullDate,
      fmtNum,
    };
  },
  template: `<div class="page">
    <header class="page-head">
      <div>
        <h1>模块与系统</h1>
        <p>热插拔能力模块、调整时间倍率与面板运行参数。</p>
      </div>
      <div class="page-head-meta">
        <LiveDot :live="!store.statusError" :label="store.statusError ? '连接中断' : '运行中'" />
      </div>
    </header>

    <div v-if="!status" class="panel"><LoadingBlock :rows="5" /></div>

    <template v-else>
      <div class="grid">
        <Panel class="span-6" title="时间与动作" subtitle="模拟时钟的节奏由 timeScale 决定">
          <div class="kv-row">
            <span class="kv-key">模拟时间</span>
            <span class="kv-value mono">{{ status.sim }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">真实时间</span>
            <span class="kv-value mono">{{ fmtFullDate(now) }}</span>
          </div>
          <div class="kv-row">
            <span class="kv-key">timeScale</span>
            <div class="kv-control">
              <NumberField :model-value="status.timeScale" :min="1" :max="100000" :step="1" suffix="×" label="timeScale" @commit="commitTimescale" />
            </div>
          </div>
          <div class="kv-row">
            <span class="kv-key">运行时长</span>
            <span class="kv-value">{{ uptime }}</span>
          </div>
          <div class="divider"></div>
          <div class="btn-row">
            <button class="btn" :disabled="acting === '/api/sleep'" @click="act('/api/sleep', '已请求入睡')"><Icon name="bed" :size="15" />强制入睡</button>
            <button class="btn" :disabled="acting === '/api/wake'" @click="act('/api/wake', '已强制唤醒')"><Icon name="sunrise" :size="15" />强制唤醒</button>
            <button class="btn" :disabled="acting === '/api/consolidate'" @click="act('/api/consolidate', '记忆整理完成')"><Icon name="brain" :size="15" />整理记忆</button>
          </div>
        </Panel>

        <Panel class="span-6" title="咖啡配给" subtitle="builtin 模块的每日额度">
          <div v-if="!coffee" class="empty-inline">builtin 模块未启用,咖啡配给不可用。</div>
          <template v-else>
            <div class="big-number">{{ coffee.remaining }}<span class="unit">杯</span></div>
            <p class="panel-note">喝完后它会主动在 QQ 上找主人讨。这里的补货会直接增加今日余量。</p>
            <div class="btn-row">
              <button class="btn" @click="claimCoffee(1)"><Icon name="coffee" :size="15" />补 1 杯</button>
              <button class="btn" @click="claimCoffee(3)"><Icon name="coffee" :size="15" />补 3 杯</button>
            </div>
          </template>
        </Panel>

        <Panel class="span-12" title="能力模块" subtitle="启用/停用后 agent 工具集立即刷新">
          <div v-if="!moduleRows.length" class="empty-inline">没有注册任何模块工厂。</div>
          <div v-else class="module-list">
            <div v-for="m in moduleRows" :key="m.name" class="module-row">
              <div class="module-main">
                <div class="module-title">
                  <span class="module-dot" :class="{ 'is-on': m.running }"></span>
                  <b>{{ m.name }}</b>
                  <span class="badge" :class="m.running ? 'badge-ok' : ''">{{ m.running ? '运行中' : '未启用' }}</span>
                </div>
                <p class="module-summary">{{ m.summary }}</p>
                <div v-if="m.tools.length" class="tool-tags">
                  <span v-for="t in m.tools" :key="t" class="tool-tag">{{ t }}</span>
                </div>
              </div>
              <button class="btn btn-sm" :disabled="toggling === m.name" @click="toggleModule(m)">
                <Spinner v-if="toggling === m.name" :size="12" />{{ m.running ? '停用' : '启用' }}
              </button>
            </div>
          </div>
        </Panel>

        <Panel class="span-12" title="面板与数据" subtitle="当前进程的运行参数">
          <div class="info-grid">
            <div class="info-cell"><span>面板端口</span><b>{{ status.panel?.port ?? '-' }}</b></div>
            <div class="info-cell"><span>鉴权</span><b>{{ status.panel?.authRequired ? '已开启' : '未开启' }}</b></div>
            <div class="info-cell"><span>活动序列</span><b>{{ fmtNum(status.activityLastSeq) }}</b></div>
            <div class="info-cell"><span>MEMORY.md</span><b>{{ memoryUpdated }}</b></div>
            <div class="info-cell"><span>待响闹钟</span><b>{{ status.pendingAlarms }}</b></div>
            <div class="info-cell"><span>模块数量</span><b>{{ status.modules.length }}</b></div>
          </div>
          <div class="btn-row panel-footer">
            <button class="btn btn-ghost" @click="logout"><Icon name="logout" :size="15" />退出面板</button>
          </div>
        </Panel>
      </div>
    </template>
  </div>`,
};
