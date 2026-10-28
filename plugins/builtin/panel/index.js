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
  Field,
  NumberField,
  Spinner,
} from "/app/panel-sdk.js";

/**
 * Builtin 插件页面:主人配置、每日咖啡配额与联网搜索。
 * 所有状态/动作都走本插件的通用 actions 路由,主面板不认识「咖啡」「搜索」。
 */
export default defineComponent({
  name: "BuiltinPanel",
  components: { Panel, Field, NumberField, Spinner },
  setup() {
    const state = ref(null);
    const draft = ref({
      name: "",
      qq: 0,
      dailyQuota: 3,
      refillSimHour: 8,
      searchProvider: "auto",
      searxngUrl: "",
      searxngMax: 8,
      deepseekUrl: "https://api.deepseek.com",
      deepseekKey: "",
      deepseekCount: 8,
      deepseekNeedContent: false,
      hostEnabled: true,
      hostShell: true,
      hostWorkdir: ".",
      hostOutside: false,
    });
    const loading = ref(true);
    const busy = ref("");
    const error = ref("");
    const testQuery = ref("DeepSeek");
    const testOutput = ref("");

    const remaining = computed(() => state.value?.remaining ?? 0);
    const quota = computed(() => state.value?.coffee?.dailyQuota ?? 0);
    const ratio = computed(() => {
      const q = quota.value || 1;
      return Math.max(0, Math.min(1, remaining.value / q));
    });
    const searchStatus = computed(() => {
      const s = state.value?.search;
      if (!s) return "未知";
      return s.configured ? s.provider : "未配置";
    });

    function applyState(next) {
      state.value = next;
      const ws = next.webSearch ?? {};
      const ht = next.hostTools ?? {};
      draft.value = {
        name: next.master?.name ?? "",
        qq: next.master?.qq ?? 0,
        dailyQuota: next.coffee?.dailyQuota ?? 0,
        refillSimHour: next.coffee?.refillSimHour ?? 8,
        searchProvider: ws.provider ?? "auto",
        searxngUrl: ws.searxng?.baseUrl ?? "",
        searxngMax: ws.searxng?.maxResults ?? 8,
        deepseekUrl: ws.deepseek?.baseUrl ?? "https://api.deepseek.com",
        deepseekKey: "",
        deepseekCount: ws.deepseek?.count ?? 8,
        deepseekNeedContent: ws.deepseek?.needContent === true,
        hostEnabled: ht.enabled !== false,
        hostShell: ht.shellEnabled !== false,
        hostWorkdir: ht.workdir ?? ".",
        hostOutside: ht.allowOutsideWorkdir === true,
      };
    }

    async function run(label, fn) {
      busy.value = label;
      error.value = "";
      try {
        await fn();
      } catch (err) {
        error.value = err?.message || String(err);
        notify("error", error.value);
      } finally {
        busy.value = "";
      }
    }

    async function load() {
      loading.value = true;
      await run("load", async () => applyState(await pluginAction("builtin")));
      loading.value = false;
    }

    function configBody() {
      const ws = {
        provider: draft.value.searchProvider,
        searxng: {
          baseUrl: draft.value.searxngUrl,
          maxResults: Number(draft.value.searxngMax) || 8,
        },
        deepseek: {
          baseUrl: draft.value.deepseekUrl,
          count: Number(draft.value.deepseekCount) || 8,
          needContent: draft.value.deepseekNeedContent === true,
        },
      };
      // 留空 = 不修改已有 key;要清除用下面的「清除」按钮
      if (draft.value.deepseekKey) ws.deepseek.apiKey = draft.value.deepseekKey;
      return {
        master: { name: draft.value.name, qq: Number(draft.value.qq) || 0 },
        coffee: {
          dailyQuota: Number(draft.value.dailyQuota) || 0,
          refillSimHour: Number(draft.value.refillSimHour) || 0,
        },
        webSearch: ws,
        hostTools: {
          enabled: draft.value.hostEnabled === true,
          shellEnabled: draft.value.hostShell === true,
          workdir: draft.value.hostWorkdir || ".",
          allowOutsideWorkdir: draft.value.hostOutside === true,
        },
      };
    }

    function save() {
      return run("save", async () => {
        const r = await pluginAction("builtin", "config", {
          method: "POST",
          body: configBody(),
        });
        if (r.state) applyState(r.state);
        notify("success", "配置已保存");
      });
    }

    function clearKey() {
      return run("clearKey", async () => {
        const r = await pluginAction("builtin", "config", {
          method: "POST",
          body: { webSearch: { deepseek: { clearApiKey: true } } },
        });
        if (r.state) applyState(r.state);
        notify("success", "DeepSeek key 已清除");
      });
    }

    function testSearch() {
      return run("testSearch", async () => {
        testOutput.value = "搜索中…";
        const r = await pluginAction("builtin", "search/test", {
          method: "POST",
          body: { query: testQuery.value },
        });
        testOutput.value = r.text ?? "";
        notify("success", `搜索成功(${r.provider})`);
      });
    }

    function grant(cups) {
      return run("grant", async () => {
        const r = await pluginAction("builtin", "grant", { method: "POST", body: { cups } });
        if (r.state) applyState(r.state);
        notify("success", `已补 ${cups} 杯`);
      });
    }

    function refill() {
      return run("refill", async () => {
        const r = await pluginAction("builtin", "refill", { method: "POST" });
        if (r.state) applyState(r.state);
        notify("success", "今日配给已重置");
      });
    }

    // 只有本插件状态变化时才刷新;其它插件/日志事件不会动这个页面
    let off = null;
    onMounted(() => {
      void load();
      off = onLive?.("plugin:builtin", () => void load());
    });
    onBeforeUnmount(() => off?.());

    return {
      state,
      draft,
      loading,
      busy,
      error,
      remaining,
      quota,
      ratio,
      searchStatus,
      testQuery,
      testOutput,
      save,
      grant,
      refill,
      load,
      clearKey,
      testSearch,
    };
  },
  template: `
  <div class="page plugin-page">
    <header class="page-head">
      <div>
        <span class="eyebrow">插件 · builtin</span>
        <h1>日常、咖啡、搜索与宿主能力</h1>
        <p class="page-sub">生理配给、联网搜索,以及读写文件 / shell 的边界。</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" :disabled="loading || !!busy" @click="load">刷新</button>
      </div>
    </header>

    <p v-if="error" class="field-error">{{ error }}</p>
    <div v-if="loading" class="plugin-loading"><Spinner :size="16" />正在读取插件状态…</div>

    <div v-else class="plugin-grid">
      <Panel title="今日配给" class="budget-card">
        <div class="budget">
          <div class="budget-number">
            <b>{{ remaining }}</b><span>/ {{ quota }} 杯</span>
          </div>
          <div class="budget-meter" role="img" :aria-label="'剩余 ' + remaining + ' 杯,共 ' + quota + ' 杯'">
            <span :style="{ width: (ratio * 100).toFixed(1) + '%' }"></span>
          </div>
          <p class="muted small">
            每天 {{ state?.coffee?.refillSimHour ?? 8 }} 点(模拟时间)自动补给;跨午夜不会丢失已喝的记录。
          </p>
        </div>
        <div class="budget-actions">
          <button class="btn btn-primary btn-sm" :disabled="!!busy" @click="grant(1)">补 1 杯</button>
          <button class="btn btn-ghost btn-sm" :disabled="!!busy" @click="grant(3)">补 3 杯</button>
          <button class="btn btn-ghost btn-sm" :disabled="!!busy" @click="refill">重置今日配给</button>
        </div>
      </Panel>

      <Panel title="主人">
        <div class="form-grid">
          <Field label="称呼" hint="bot 在工具描述与讨咖啡时怎么喊你">
            <input class="input" v-model="draft.name" maxlength="40" placeholder="主人" />
          </Field>
          <Field label="QQ 号" hint="喝完咖啡后它会上 QQ 找这个号讨;0 表示未配置">
            <input class="input" v-model.number="draft.qq" type="number" min="0" step="1" />
          </Field>
          <Field label="每日配额" hint="0 表示今天没有配给">
            <NumberField :model-value="draft.dailyQuota" :min="0" :max="50" :step="1" label="每日配额"
              @commit="draft.dailyQuota = $event" />
          </Field>
          <Field label="补给时刻" hint="模拟时间的小时数(0-23)">
            <NumberField :model-value="draft.refillSimHour" :min="0" :max="23" :step="1" label="补给时刻"
              @commit="draft.refillSimHour = $event" />
          </Field>
        </div>
        <div class="panel-foot">
          <button class="btn btn-primary btn-sm" :disabled="!!busy" @click="save">
            <Spinner v-if="busy === 'save'" :size="14" />保存
          </button>
        </div>
      </Panel>

      <Panel title="宿主能力">
        <p class="muted small">
          read_file / write_file / list_files / run_shell。工作目录之外的路径默认拒绝;
          shell 是真实的宿主命令执行,模型看到的聊天内容也可能被注入,请只接入可信的会话。
        </p>
        <div class="form-grid">
          <Field label="文件工具" hint="关闭后需重启 builtin 插件才会移除工具">
            <label class="muted small">
              <input type="checkbox" v-model="draft.hostEnabled" /> 启用 read_file / write_file / list_files
            </label>
          </Field>
          <Field label="Shell" hint="run_shell:在宿主上执行命令">
            <label class="muted small">
              <input type="checkbox" v-model="draft.hostShell" /> 启用 run_shell
            </label>
          </Field>
          <Field label="工作目录" hint="相对路径的基准;默认项目根目录">
            <input class="input" v-model="draft.hostWorkdir" placeholder="." />
          </Field>
          <Field label="越界访问" hint="允许读写工作目录之外的路径">
            <label class="muted small">
              <input type="checkbox" v-model="draft.hostOutside" /> 允许
            </label>
          </Field>
        </div>
        <div class="panel-foot">
          <button class="btn btn-primary btn-sm" :disabled="!!busy" @click="save">保存</button>
        </div>
      </Panel>

      <Panel title="联网搜索">
        <p class="muted small">
          当前后端:<b>{{ searchStatus }}</b>
          <span v-if="state?.search?.detail"> · {{ state.search.detail }}</span>
        </p>
        <div class="form-grid">
          <Field label="后端" hint="auto:有 DeepSeek key 就优先 DeepSeek,否则 SearXNG">
            <select class="input" v-model="draft.searchProvider">
              <option value="auto">auto</option>
              <option value="deepseek">DeepSeek</option>
              <option value="searxng">SearXNG</option>
            </select>
          </Field>
          <Field label="SearXNG 地址" hint="本机直跑填 127.0.0.1;需要实例启用 json 格式">
            <input class="input" v-model="draft.searxngUrl" placeholder="http://127.0.0.1:10099" />
          </Field>
          <Field label="SearXNG 条数">
            <NumberField :model-value="draft.searxngMax" :min="1" :max="20" :step="1" label="SearXNG 条数"
              @commit="draft.searxngMax = $event" />
          </Field>
          <Field label="DeepSeek 地址">
            <input class="input" v-model="draft.deepseekUrl" placeholder="https://api.deepseek.com" />
          </Field>
          <Field :label="'DeepSeek API Key' + (state?.webSearch?.deepseek?.apiKeySet ? '(已配置)' : '')"
            hint="留空不修改;只存在 data/builtin.json(gitignored)">
            <input class="input" v-model="draft.deepseekKey" type="password" autocomplete="off"
              :placeholder="state?.webSearch?.deepseek?.apiKeySet ? '已配置,留空不改' : 'sk-...'" />
          </Field>
          <Field label="DeepSeek 条数">
            <NumberField :model-value="draft.deepseekCount" :min="1" :max="20" :step="1" label="DeepSeek 条数"
              @commit="draft.deepseekCount = $event" />
          </Field>
          <Field label="取正文" hint="DeepSeek 搜索时是否顺便拿网页正文(更慢更占上下文)">
            <label class="muted small">
              <input type="checkbox" v-model="draft.deepseekNeedContent" /> 默认取正文
            </label>
          </Field>
        </div>
        <div class="panel-foot">
          <button class="btn btn-primary btn-sm" :disabled="!!busy" @click="save">保存</button>
          <button class="btn btn-ghost btn-sm" :disabled="!!busy" @click="clearKey">清除 Key</button>
        </div>
      </Panel>

      <Panel title="试一下">
        <div class="form-grid">
          <Field label="搜索关键词">
            <input class="input" v-model="testQuery" placeholder="DeepSeek" />
          </Field>
        </div>
        <div class="panel-foot">
          <button class="btn btn-ghost btn-sm" :disabled="!!busy" @click="testSearch">测试搜索</button>
        </div>
        <pre v-if="testOutput" class="muted small"
          style="white-space:pre-wrap;max-height:260px;overflow:auto;margin-top:12px">{{ testOutput }}</pre>
      </Panel>
    </div>
  </div>`,
});
