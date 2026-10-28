import {
  computed,
  defineComponent,
  onBeforeUnmount,
  onMounted,
  onLive,
  ref,
  notify,
  pluginAction,
  Panel,
  Spinner,
} from "/app/panel-sdk.js";

/**
 * QQ 插件页面:NapCat / SnowLuma 二选一 + 连接状态 + 登录入口。
 *
 * 两套 runtime 都是本机独立进程,bot 只连 OneBot WS。页面不假装能启动/停止 QQ,
 * 也不把「OneBot 已连接」「QQ 已登录」「插件健康」合成一个笼统的状态。
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
    const tokenDraft = ref("");

    const selectedRuntime = computed(() => state.value?.runtimes?.find((r) => r.selected) ?? null);
    const connection = computed(() => state.value?.connection ?? { onebot: "unknown", login: null });
    const login = computed(() => state.value?.login ?? { entries: [], instructions: [] });
    const switchSteps = computed(() => state.value?.switchSteps ?? []);
    const switchIndex = computed(() => state.value?.switchIndex ?? 0);
    const switching = computed(() => state.value?.switching === true);

    function applyState(next) {
      state.value = next;
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

    function saveToken() {
      return run("token", () =>
        pluginAction("qq", "token", {
          method: "POST",
          body: { token: String(tokenDraft.value || "").trim() },
        }),
      tokenDraft.value.trim() ? "OneBot token 已保存并重连" : "已清除手填 token(改用配置值)");
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
      off = onLive?.("plugin:qq", () => void load({ quiet: true }));
    });
    onBeforeUnmount(() => off?.());

    return {
      state,
      loading,
      busy,
      error,
      showToken,
      tokenDraft,
      selectedRuntime,
      connection,
      login,
      switching,
      switchSteps,
      switchIndex,
      select,
      reconnect,
      saveToken,
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
        <p class="page-sub">一份 OneBot 能力,两种运行时。QQ 进程由你(或系统服务)启动,bot 只负责连接。</p>
      </div>
      <div class="page-actions">
        <span class="chip" :class="'chip-' + (connection.onebot === 'connected' ? 'ok' : 'muted')">
          OneBot: {{ connection.onebot }}
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
            <span>OneBot <code>{{ r.onebotUrl }}</code></span>
            <span>WebUI <code>:{{ r.webuiPort }}</code>{{ r.novncPort ? ' · noVNC :' + r.novncPort : '' }}</span>
          </div>
        </button>
      </div>

      <div class="plugin-grid">
        <Panel title="连接状态">
          <ul class="health-list">
            <li>
              <span>QQ 登录</span>
              <b :class="{ 'ok-text': connection.login }">
                {{ connection.login ? connection.login.nickname + '(' + connection.login.userId + ')' : '未登录 / 未知' }}
              </b>
            </li>
            <li><span>OneBot</span><b :class="{ 'ok-text': connection.onebot === 'connected' }">{{ connection.onebot }}</b></li>
            <li><span>插件</span><b>{{ switching ? ((switchIndex + 1) + '/' + switchSteps.length + ' ' + (switchSteps[switchIndex] || '')) : '运行中' }}</b></li>
          </ul>
          <div v-if="switching" class="switch-progress" role="progressbar"
            :aria-valuenow="switchIndex + 1" :aria-valuemin="0" :aria-valuemax="switchSteps.length">
            <span class="switch-progress-bar" :style="{ width: ((switchIndex + 1) / Math.max(1, switchSteps.length) * 100) + '%' }"></span>
          </div>
          <div class="panel-foot plugin-actions">
            <button class="btn btn-primary btn-sm" :disabled="!!busy" @click="reconnect">
              <Spinner v-if="busy === 'reconnect'" :size="14" />重连 OneBot
            </button>
          </div>
          <p class="muted small">
            未连接时,先启动 {{ selectedRuntime?.displayName }} 进程并确认 OneBot v11 WebSocket 服务器在
            {{ selectedRuntime?.onebotUrl }} 上监听。
          </p>
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
                placeholder="留空 = 使用配置文件里的 token" />
            </label>
            <button class="btn btn-ghost btn-sm" :disabled="!!busy" @click="saveToken">
              <Spinner v-if="busy === 'token'" :size="14" />保存并重连
            </button>
          </div>
          <p class="muted small">
            NapCat / SnowLuma 的 OneBot WebSocket 若设置了 access token,这里必须填一致;留空表示不校验。
          </p>
        </Panel>
      </div>
    </template>
  </div>`,
});
