import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  onLive,
  ref,
  notify,
  fetchStatus,
  pluginAction,
  Panel,
  Spinner,
} from "/app/panel-sdk.js";

/**
 * QQ 插件页面:NapCat / SnowLuma 二选一 + 运行状态 + 登录入口。
 *
 * 五层状态必须分开显示 —— 容器 running 不代表 QQ 已登录,QQ 已登录也不代表
 * OneBot 可用。把它们合成一个「健康/不健康」是这类面板最常见的谎。
 */
export default defineComponent({
  name: "QqPanel",
  components: { Panel, Spinner },
  setup() {
    const state = ref(null);
    const loading = ref(true);
    const busy = ref("");
    const error = ref("");
    const showToken = ref({});
    const logs = ref("");
    const showLogs = ref(false);
    const portDraft = ref({ webui: "", novnc: "" });
    const tokenDraft = ref("");

    const selectedRuntime = computed(() => state.value?.runtimes?.find((r) => r.selected) ?? null);
    const connection = computed(() => state.value?.connection ?? { onebot: "unknown", login: null });
    const login = computed(() => state.value?.login ?? { entries: [], instructions: [] });
    const noSupervisor = computed(() => (state.value?.supervisor ?? "unavailable") !== "connected");
    // 进度完全来自服务端实际执行到的步骤,页面不做时间插值
    const progress = ref(null);

    function applyProgress(data) {
      if (!data || typeof data !== "object") return;
      if (data.switching === false) {
        progress.value = null;
        return;
      }
      if (!data.switching || !Array.isArray(data.switchSteps) || !data.switchSteps.length) return;
      const total = data.switchTotal || data.switchSteps.length;
      const index = Math.max(0, Math.min(total - 1, Number(data.switchIndex) || 0));
      progress.value = { stages: data.switchSteps, index, total, stage: data.switchStage || "" };
    }

    const switchStages = computed(() => progress.value?.stages ?? []);
    const switchIndex = computed(() => progress.value?.index ?? 0);
    const switchTotal = computed(() => Math.max(1, progress.value?.total || switchStages.value.length));
    const switchPct = computed(() => {
      if (!progress.value) return 0;
      return Math.min(100, Math.round(((switchIndex.value + 1) / switchTotal.value) * 100));
    });
    const switching = computed(() => progress.value != null);

    function applyState(next) {
      state.value = next;
      if (next?.switching) applyProgress(next);
      else if (progress.value && next && next.switching === false) progress.value = null;
      const current = next?.runtimes?.find((r) => r.selected);
      if (current) {
        portDraft.value = {
          webui: String(current.webuiPort ?? ""),
          novnc: current.novncPort ? String(current.novncPort) : "",
        };
      }
      tokenDraft.value = next?.onebotToken?.override ?? "";
    }

    async function load({ quiet = false } = {}) {
      if (!quiet) loading.value = true;
      try {
        applyState(await pluginAction("qq"));
        error.value = "";
      } catch (err) {
        error.value = err?.message || String(err);
      } finally {
        loading.value = false;
      }
    }

    async function run(label, fn, okText) {
      if (busy.value) return;
      busy.value = label;
      error.value = "";
      try {
        const r = await fn();
        if (r?.state) applyState(r.state);
        if (label === "select") await fetchStatus();
        if (okText) notify("success", okText);
        return r;
      } catch (err) {
        error.value = err?.message || String(err);
        notify("error", error.value);
      } finally {
        busy.value = "";
      }
    }

    const select = (id) =>
      run("select", () => pluginAction("qq", "select", { method: "POST", body: { runtime: id } }), "已切换运行时");

    const reconnect = () => run("reconnect", () => pluginAction("qq", "reconnect", { method: "POST" }), "重连完成");
    const restart = () => run("restart", () => pluginAction("qq", "restart", { method: "POST" }), "已重启运行时");

    function saveToken() {
      return run("token", () =>
        pluginAction("qq", "token", {
          method: "POST",
          body: { token: String(tokenDraft.value || "").trim() },
        }),
      tokenDraft.value.trim() ? "OneBot token 已保存并重连" : "已清除手填 token(改用自动读取)");
    }

    function savePorts() {
      return run("ports", async () => {
        const body = {};
        const webui = Number(portDraft.value.webui);
        if (Number.isInteger(webui) && webui > 0) body.webui = webui;
        const novnc = Number(portDraft.value.novnc);
        if (Number.isInteger(novnc) && novnc > 0) body.novnc = novnc;
        return pluginAction("qq", "ports", { method: "POST", body });
      }, "端口已更新(容器已重建,数据卷保留)");
    }

    async function loadLogs() {
      showLogs.value = true;
      logs.value = "读取中…";
      try {
        const r = await pluginAction("qq", "logs", { method: "GET" });
        logs.value = r.logs || "(空)";
      } catch (err) {
        logs.value = err?.message || String(err);
      }
    }

    function copy(text) {
      if (!text) return;
      void navigator.clipboard?.writeText(text);
      notify("success", "已复制");
    }

    // QQ 插件自己会在连接状态变化时推送 plugin:qq,不需要轮询
    let off = null;
    onMounted(async () => {
      await load();
      // 进度事件自带当前步骤;其它 plugin:qq 信号再去拉完整状态
      off = onLive?.("plugin:qq", (data) => {
        if (data && typeof data === "object" && ("switching" in data || "switchIndex" in data)) {
          applyProgress(data);
          return;
        }
        void load({ quiet: true });
      });
    });
    onBeforeUnmount(() => off?.());

    return {
      state,
      loading,
      busy,
      error,
      showToken,
      logs,
      showLogs,
      portDraft,
      tokenDraft,
      selectedRuntime,
      connection,
      login,
      noSupervisor,
      switching,
      switchStages,
      switchIndex,
      switchTotal,
      switchPct,
      select,
      reconnect,
      restart,
      savePorts,
      saveToken,
      loadLogs,
      copy,
      load,
    };
  },
  template: `
  <div class="page plugin-page">
    <header class="page-head">
      <div>
        <span class="eyebrow">插件 · qq</span>
        <h1>QQ 接入</h1>
        <p class="page-sub">一份 OneBot 能力,两种运行时。同一时间只允许一套在线。</p>
      </div>
      <div class="page-actions">
        <span class="chip" :class="'chip-' + (state?.supervisor === 'connected' ? 'ok' : 'muted')">
          supervisor: {{ state?.supervisor ?? '-' }}
        </span>
        <button class="btn btn-ghost btn-sm" :disabled="loading || !!busy" @click="load()">刷新</button>
      </div>
    </header>

    <p v-if="error || state?.lastError" class="field-error">{{ error || state?.lastError }}</p>
    <div v-if="loading" class="plugin-loading"><Spinner :size="16" />正在读取运行时状态…</div>

    <template v-else-if="state">
      <div class="runtime-picker" role="radiogroup" aria-label="QQ 运行时">
        <button v-for="r in state.runtimes" :key="r.id" class="runtime-card"
          :class="{ 'is-active': r.selected }" role="radio" :aria-checked="r.selected"
          :disabled="!!busy || (r.selected && connection.onebot === 'connected')"
          @click="select(r.id)">
          <div class="runtime-card-top">
            <b>{{ r.displayName }}</b>
            <span class="chip" :class="r.selected ? 'chip-ok' : 'chip-muted'">{{ r.selected ? '使用中' : '可切换' }}</span>
          </div>
          <div class="runtime-meta">
            <span>镜像 <code>{{ r.image }}</code></span>
            <span>WebUI <code>:{{ r.webuiPort }}</code>{{ r.novncPort ? ' · noVNC :' + r.novncPort : '' }}</span>
            <span>安装 {{ r.install }} · 进程 {{ r.process }}</span>
          </div>
        </button>
      </div>

      <div class="plugin-grid">
        <Panel title="运行状态">
          <ul class="health-list">
            <li><span>容器安装</span><b>{{ selectedRuntime?.install ?? '-' }}</b></li>
            <li><span>进程</span><b>{{ selectedRuntime?.process ?? '-' }}</b></li>
            <li>
              <span>QQ 登录</span>
              <b :class="{ 'ok-text': connection.login }">
                {{ connection.login ? connection.login.nickname + '(' + connection.login.userId + ')' : '未登录 / 未知' }}
              </b>
            </li>
            <li><span>OneBot</span><b :class="{ 'ok-text': connection.onebot === 'connected' }">{{ connection.onebot }}</b></li>
            <li><span>插件</span><b>{{ switching ? ((switchIndex + 1) + '/' + switchTotal + ' ' + (switchStages[switchIndex] || '')) : '运行中' }}</b></li>
          </ul>
          <div v-if="switching" class="switch-progress" role="progressbar"
            :aria-valuenow="switchIndex + 1" :aria-valuemin="0" :aria-valuemax="switchTotal">
            <span class="switch-progress-bar" :style="{ width: switchPct + '%' }"></span>
          </div>
          <ol v-if="switching" class="switch-steps">
            <li v-for="(s, i) in switchStages" :key="s" :class="{ 'is-done': i < switchIndex, 'is-current': i === switchIndex }">{{ s }}</li>
          </ol>
          <div class="panel-foot plugin-actions">
            <button class="btn btn-primary btn-sm" :disabled="!!busy || noSupervisor" @click="restart">
              <Spinner v-if="busy === 'restart'" :size="14" />重启运行时
            </button>
            <button class="btn btn-ghost btn-sm" :disabled="!!busy" @click="reconnect">重连 OneBot</button>
            <button class="btn btn-ghost btn-sm" :disabled="noSupervisor" @click="loadLogs">查看容器日志</button>
          </div>
          <p v-if="noSupervisor" class="muted small">未配置 runtime supervisor:只能连接已在运行的 OneBot,不能安装/重启容器。</p>
        </Panel>

        <Panel title="登录入口">
          <div class="login-links">
            <a v-if="login.webuiUrl" class="link-chip" :href="login.webuiUrl" target="_blank" rel="noopener">WebUI ↗</a>
            <a v-if="login.remoteDesktopUrl" class="link-chip" :href="login.remoteDesktopUrl" target="_blank" rel="noopener">noVNC ↗</a>
          </div>
          <ul class="cred-list">
            <li v-for="(e, i) in login.entries" :key="i">
              <div class="cred-head">
                <span>{{ e.label }}</span>
                <span class="cred-tools">
                  <button v-if="e.available" class="btn btn-ghost btn-xs" @click="showToken[i] = !showToken[i]">{{ showToken[i] ? '隐藏' : '显示' }}</button>
                  <button v-if="e.available" class="btn btn-ghost btn-xs" @click="copy(e.value)">复制</button>
                </span>
              </div>
              <code class="cred-value">{{ e.available ? (e.sensitive && !showToken[i] ? '••••••••••••' : e.value) : '暂不可用' }}</code>
              <p v-if="e.hint" class="muted small">{{ e.hint }}</p>
            </li>
          </ul>
          <ol class="steps">
            <li v-for="(s, i) in login.instructions" :key="i">{{ s }}</li>
          </ol>
          <ul v-if="selectedRuntime?.securityNotes?.length" class="notes">
            <li v-for="(n, i) in selectedRuntime.securityNotes" :key="i">{{ n }}</li>
          </ul>
        </Panel>

        <Panel title="OneBot 访问 token" class="span-2">
          <div class="form-inline">
            <label>手填 token
              <input class="input input-sm" v-model="tokenDraft" autocomplete="off" spellcheck="false"
                :placeholder="state?.onebotToken?.autoRead ? '留空 = 自动从运行时配置读取' : '留空 = 不校验'" />
            </label>
            <button class="btn btn-ghost btn-sm" :disabled="!!busy" @click="saveToken">
              <Spinner v-if="busy === 'token'" :size="14" />保存并重连
            </button>
          </div>
          <p class="muted small">
            <template v-if="state?.onebotToken?.autoRead">
              已自动从运行时配置读取 token({{ state.onebotToken.effective ? '已获取' : '未获取' }})。
            </template>
            SnowLuma 绑定 0.0.0.0 时必须设 access token;这里的值优先于自动读取,清空即恢复自动。
          </p>
        </Panel>

        <Panel title="宿主端口" class="span-2">
          <div class="form-inline">
            <label>WebUI <input class="input input-sm" v-model="portDraft.webui" inputmode="numeric" /></label>
            <label v-if="selectedRuntime?.novncPort">noVNC <input class="input input-sm" v-model="portDraft.novnc" inputmode="numeric" /></label>
            <button class="btn btn-ghost btn-sm" :disabled="!!busy || noSupervisor" @click="savePorts">
              <Spinner v-if="busy === 'ports'" :size="14" />应用(重建容器)
            </button>
          </div>
          <p class="muted small">只改宿主侧端口,OneBot 始终走容器内网 {{ selectedRuntime?.displayName }}:3001;重建容器不删数据卷。</p>
        </Panel>
      </div>

      <Panel v-if="showLogs" title="容器日志">
        <pre class="log-block">{{ logs }}</pre>
      </Panel>
    </template>
  </div>`,
});
