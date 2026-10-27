import { computed, onMounted, ref } from "/vendor/vue.esm-browser.prod.js";
import { api } from "../api.js";
import { fetchStatus, notify, store } from "../store.js";

/**
 * 模块总览:通用卡片,只显示 manifest 提供的通用信息。
 * 这里不出现任何插件业务(咖啡、QQ token、端口),点进卡片才是插件的页面。
 */
export const ModulesPage = {
  name: "ModulesPage",
  setup() {
    const busy = ref("");
    const error = ref("");

    const plugins = computed(() => store.status?.plugins ?? []);

    async function toggle(plugin) {
      if (busy.value) return;
      busy.value = plugin.id;
      error.value = "";
      try {
        await api(`/api/plugins/${encodeURIComponent(plugin.id)}/${plugin.enabled ? "stop" : "start"}`, {
          method: "POST",
          body: "{}",
        });
        notify("success", plugin.enabled ? `已停用 ${plugin.name}` : `已启用 ${plugin.name}`);
        await fetchStatus();
      } catch (err) {
        error.value = err.message || "操作失败";
        notify("error", error.value);
      } finally {
        busy.value = "";
      }
    }

    function cardText(plugin) {
      const detail = plugin.health?.detail;
      if (detail && detail !== "stopped" && detail.includes("当前实现")) return detail;
      return plugin.summary || plugin.description;
    }

    function open(plugin) {
      if (plugin.panel?.route) location.hash = `#/${plugin.panel.route}`;
    }

    onMounted(() => {
      if (!store.status) void fetchStatus();
    });

    return { plugins, busy, error, toggle, open, cardText, store };
  },
  template: `<div class="page">
    <header class="page-head">
      <div>
        <span class="eyebrow">模块</span>
        <h1>模块总览</h1>
        <p class="page-sub">每个插件都是独立的目录与 manifest。启用后它的工具立刻出现在 agent 手里。</p>
      </div>
    </header>

    <p v-if="error" class="field-error">{{ error }}</p>

    <div v-if="!plugins.length" class="panel">
      <EmptyState title="还没有发现插件" hint="在 plugins/<id>/module.json 放一个 manifest,重启后即出现。" />
    </div>

    <div v-else class="module-cards">
      <article v-for="p in plugins" :key="p.id" class="module-card"
        :class="{ 'is-off': !p.enabled, 'is-linkable': !!p.panel }"
        @click="open(p)">
        <header class="module-card-head">
          <div class="module-card-title">
            <Icon :name="p.panel?.icon || 'layers'" :size="18" />
            <b>{{ p.name }}</b>
            <span class="muted small">v{{ p.version }}</span>
          </div>
          <span class="chip" :class="p.enabled ? 'chip-ok' : 'chip-muted'">{{ p.enabled ? '已启用' : '未启用' }}</span>
        </header>

        <p class="module-card-desc">{{ cardText(p) }}</p>

        <div v-if="p.toolNames?.length" class="tool-tags">
          <span v-for="t in p.toolNames.slice(0, 6)" :key="t" class="tool-tag">{{ t }}</span>
          <span v-if="p.toolNames.length > 6" class="tool-tag tool-tag-more">+{{ p.toolNames.length - 6 }}</span>
        </div>
        <p v-else class="muted small">没有对外工具</p>

        <footer class="module-card-foot">
          <a v-if="p.panel" class="btn btn-ghost btn-sm" :href="'#/' + p.panel.route" @click.stop>
            打开模块页面<Icon name="chevronRight" :size="14" />
          </a>
          <span v-else class="muted small">无独立页面</span>
          <button class="btn btn-sm" :disabled="busy === p.id" @click.stop="toggle(p)">
            <Spinner v-if="busy === p.id" :size="12" />{{ p.enabled ? '停用' : '启用' }}
          </button>
        </footer>
      </article>
    </div>
  </div>`,
};
