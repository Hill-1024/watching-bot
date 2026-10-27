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
 * Builtin 插件页面:主人配置 + 每日咖啡配额。
 * 所有状态/动作都走本插件的通用 actions 路由,主面板不认识「咖啡」。
 */
export default defineComponent({
  name: "BuiltinPanel",
  components: { Panel, Field, NumberField, Spinner },
  setup() {
    const state = ref(null);
    const draft = ref({ name: "", qq: 0, dailyQuota: 3, refillSimHour: 8 });
    const loading = ref(true);
    const busy = ref("");
    const error = ref("");

    const remaining = computed(() => state.value?.remaining ?? 0);
    const quota = computed(() => state.value?.coffee?.dailyQuota ?? 0);
    const ratio = computed(() => {
      const q = quota.value || 1;
      return Math.max(0, Math.min(1, remaining.value / q));
    });

    function applyState(next) {
      state.value = next;
      draft.value = {
        name: next.master?.name ?? "",
        qq: next.master?.qq ?? 0,
        dailyQuota: next.coffee?.dailyQuota ?? 0,
        refillSimHour: next.coffee?.refillSimHour ?? 8,
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

    function save() {
      return run("save", async () => {
        const r = await pluginAction("builtin", "config", {
          method: "POST",
          body: {
            master: { name: draft.value.name, qq: Number(draft.value.qq) || 0 },
            coffee: {
              dailyQuota: Number(draft.value.dailyQuota) || 0,
              refillSimHour: Number(draft.value.refillSimHour) || 0,
            },
          },
        });
        if (r.state) applyState(r.state);
        notify("success", "配置已保存");
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

    return { state, draft, loading, busy, error, remaining, quota, ratio, save, grant, refill, load };
  },
  template: `
  <div class="page plugin-page">
    <header class="page-head">
      <div>
        <span class="eyebrow">插件 · builtin</span>
        <h1>日常与咖啡</h1>
        <p class="page-sub">与 IM 无关的生理能力:每天固定的咖啡配给,喝完它得自己去找主人讨。</p>
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
    </div>
  </div>`,
});
