import { computed, onMounted, ref } from "/vendor/vue.esm-browser.prod.js";
import { api, postJSON } from "../api.js";
import { notify } from "../store.js";
import { THINKING_LEVELS } from "../meta.js";
import { fmtNum } from "../utils.js";

export const ModelPage = {
  name: "ModelPage",
  setup() {
    const model = ref(null);
    const loading = ref(true);
    const error = ref("");
    const saving = ref(false);
    const catalog = ref([]);
    const catalogLoading = ref(false);
    const form = ref({
      provider: "",
      model: "",
      baseUrl: "",
      apiKey: "",
      contextWindow: "",
      maxTokens: "",
      thinkingLevel: "off",
    });

    const providerOptions = computed(() => {
      const list = model.value?.providers || [];
      const current = model.value?.provider;
      const out = current && !list.includes(current) ? [current, ...list] : [...list];
      return out.map((p) => ({ value: p, label: p }));
    });
    const thinkingOptions = THINKING_LEVELS.map((v) => ({ value: v, label: v }));

    async function loadCatalog(provider, selected) {
      if (!provider) return;
      if (model.value?.baseUrl && provider === model.value.provider) {
        catalog.value = [model.value.model];
        if (!form.value.model) form.value.model = model.value.model;
        return;
      }
      catalogLoading.value = true;
      try {
        const r = await api(`/api/model/catalog?provider=${encodeURIComponent(provider)}`);
        catalog.value = r.models || [];
        if (!form.value.model && catalog.value.length) form.value.model = catalog.value[0];
        if (selected && catalog.value.includes(selected)) form.value.model = selected;
      } catch {
        catalog.value = [];
      } finally {
        catalogLoading.value = false;
      }
    }

    async function load() {
      loading.value = true;
      try {
        const m = await api("/api/model");
        model.value = m;
        form.value = {
          provider: m.provider,
          model: m.model,
          baseUrl: m.baseUrl || "",
          apiKey: "",
          contextWindow: m.contextWindow ? String(m.contextWindow) : "",
          maxTokens: m.maxTokens ? String(m.maxTokens) : "",
          thinkingLevel: m.thinkingLevel || "off",
        };
        error.value = "";
        await loadCatalog(m.provider, m.model);
      } catch (err) {
        error.value = err.message || "模型配置读取失败";
      } finally {
        loading.value = false;
      }
    }

    function onProviderChange(value) {
      form.value.provider = value;
      form.value.model = "";
      catalog.value = [];
      void loadCatalog(value);
    }

    async function apply() {
      if (saving.value) return;
      if (!form.value.model.trim()) {
        error.value = "请先填写模型 ID";
        return;
      }
      saving.value = true;
      error.value = "";
      try {
        const body = {
          provider: form.value.provider,
          model: form.value.model.trim(),
          baseUrl: form.value.baseUrl.trim(),
          contextWindow: Number(form.value.contextWindow) || 0,
          maxTokens: Number(form.value.maxTokens) || 0,
          thinkingLevel: form.value.thinkingLevel,
        };
        if (form.value.apiKey.trim()) body.apiKey = form.value.apiKey.trim();
        const r = await postJSON("/api/model", body);
        notify("success", "模型已热切换,后续调用立即生效");
        form.value.apiKey = "";
        model.value = { ...model.value, ...(r.model || {}) };
        await load();
      } catch (err) {
        error.value = err.message || "模型切换失败";
        notify("error", error.value);
      } finally {
        saving.value = false;
      }
    }

    onMounted(load);

    return {
      model,
      loading,
      error,
      saving,
      catalog,
      catalogLoading,
      form,
      providerOptions,
      thinkingOptions,
      load,
      onProviderChange,
      apply,
      fmtNum,
    };
  },
  template: `<div class="page">
    <header class="page-head">
      <div>
        <h1>模型</h1>
        <p>热切换 provider 与模型,不重启进程。覆盖层写入 data/model.json。</p>
      </div>
      <div class="page-head-meta">
        <LiveDot :live="Boolean(model && !model.faux)" :label="model?.faux ? 'faux 测试模式' : '可热切换'" />
      </div>
    </header>

    <div v-if="error" class="banner banner-error">{{ error }}</div>
    <div v-if="model?.faux" class="banner banner-info">
      <Icon name="alert" :size="16" />
      <span>当前由 WATCHING_BOT_FAUX_LLM=1 启动,模型切换被禁用。</span>
    </div>

    <div v-if="loading && !model" class="panel"><LoadingBlock :rows="5" /></div>

    <template v-else-if="model">
      <section class="model-hero">
        <div class="model-hero-main">
          <span class="model-provider">{{ model.provider }}</span>
          <h2 class="model-name">{{ model.model }}</h2>
          <p class="model-endpoint">{{ model.baseUrl || "pi 内置目录端点" }}</p>
        </div>
        <div class="model-hero-stats">
          <div><span>API Key</span><b :class="model.apiKeySet ? 'text-ok' : 'text-err'">{{ model.apiKeySet ? model.apiKeyMasked : '未配置' }}</b></div>
          <div><span>推理档位</span><b>{{ model.thinkingLevel }}</b></div>
          <div><span>上下文窗口</span><b>{{ fmtNum(model.contextWindow) }}</b></div>
          <div><span>单次上限</span><b>{{ fmtNum(model.maxTokens) }}</b></div>
        </div>
      </section>

      <div class="grid">
        <Panel class="span-8" title="切换配置" subtitle="留空表示沿用现有值">
          <div class="form-grid">
            <Field label="Provider">
              <SelectField :model-value="form.provider" :options="providerOptions" label="Provider" :disabled="model.faux" @update:modelValue="onProviderChange" />
            </Field>
            <Field label="模型 ID" :hint="catalogLoading ? '目录加载中...' : catalog.length ? '可从目录选择,也可直接填写自定义模型 ID' : '可直接填写模型 ID'">
              <input v-model="form.model" class="input" list="model-catalog" :disabled="model.faux" placeholder="例如 glm-4.7" />
              <datalist id="model-catalog"><option v-for="id in catalog" :key="id" :value="id"></option></datalist>
            </Field>
            <Field class="span-2" label="baseUrl" hint="留空使用 pi 目录端点;填写后走任意 OpenAI 兼容端点">
              <input v-model="form.baseUrl" class="input" :disabled="model.faux" placeholder="https://open.bigmodel.cn/api/paas/v4" />
            </Field>
            <Field label="API Key" :hint="model.apiKeySet ? '已配置,留空保持不变;填写后写入 data/model.json' : '也可改用环境变量 ' + model.apiKeyEnv">
              <input v-model="form.apiKey" class="input" type="password" autocomplete="off" :disabled="model.faux" placeholder="留空保持现有配置" />
            </Field>
            <Field label="contextWindow">
              <input v-model="form.contextWindow" class="input" type="number" min="0" step="1000" :disabled="model.faux" placeholder="沿用配置" />
            </Field>
            <Field label="maxTokens" hint="单次回复上限">
              <input v-model="form.maxTokens" class="input" type="number" min="0" step="1000" :disabled="model.faux" placeholder="8192" />
            </Field>
            <Field label="推理档位" hint="Responses 端点会映射为 reasoning effort">
              <SelectField v-model="form.thinkingLevel" :options="thinkingOptions" label="推理档位" :disabled="model.faux" />
            </Field>
          </div>
          <div class="btn-row form-actions">
            <button class="btn btn-primary" :disabled="saving || model.faux" @click="apply">
              <Spinner v-if="saving" :size="13" /><Icon v-else name="zap" :size="15" />应用并热切换
            </button>
            <button class="btn btn-ghost" :disabled="saving" @click="load">重置</button>
          </div>
        </Panel>

        <Panel class="span-4" title="说明" subtitle="当前生效顺序">
          <ol class="hint-list">
            <li>data/model.json 覆盖层优先</li>
            <li>其次 config/default.json 的 model 段</li>
            <li>API key 可来自环境变量 {{ model.apiKeyEnv }}</li>
            <li>切换会重建 pi 网关句柄并热替换到 agent</li>
          </ol>
          <p class="panel-note">面板写入的 API key 明文保存在 data/model.json,该目录已被 gitignore。</p>
        </Panel>
      </div>
    </template>
  </div>`,
};
