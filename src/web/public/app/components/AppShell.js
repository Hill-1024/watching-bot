import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "/vendor/vue.esm-browser.prod.js";
import { bootstrap, applyTheme, login, logout, store, toggleTheme } from "../store.js";
import { fmtFullDate, fmtSimClock, relativeTime, routeFromHash, simNowMs } from "../utils.js";
import { OverviewPage } from "../pages/OverviewPage.js";
import { StatePage } from "../pages/StatePage.js";
import { ActivityPage } from "../pages/ActivityPage.js";
import { InjectionsPage } from "../pages/InjectionsPage.js";
import { UsagePage } from "../pages/UsagePage.js";
import { MemoryPage } from "../pages/MemoryPage.js";
import { ModelPage } from "../pages/ModelPage.js";
import { SystemPage } from "../pages/SystemPage.js";
import { ModulesPage } from "../pages/ModulesPage.js";
import { NotFoundPage, makePluginErrorPage, makePluginUnavailablePage } from "../pages/PluginFallbackPages.js";

const NAV = [
  {
    group: "监控",
    items: [
      { route: "overview", label: "概览", icon: "dashboard" },
      { route: "state", label: "状态与历史", icon: "gauge" },
      { route: "activity", label: "活动日志", icon: "activity" },
      { route: "injections", label: "感知注入", icon: "waves" },
    ],
  },
  {
    group: "分析",
    items: [
      { route: "usage", label: "Token 统计", icon: "chart" },
      { route: "memory", label: "长期记忆", icon: "book" },
    ],
  },
  {
    group: "配置",
    items: [
      { route: "model", label: "模型", icon: "cpu" },
      { route: "system", label: "系统", icon: "settings" },
    ],
  },
];

const PAGES = {
  overview: OverviewPage,
  state: StatePage,
  activity: ActivityPage,
  injections: InjectionsPage,
  usage: UsagePage,
  memory: MemoryPage,
  model: ModelPage,
  system: SystemPage,
  modules: ModulesPage,
};

const GROUP_DEFAULT = Object.fromEntries(NAV.map((g) => [g.group, g.items[0]?.route || "overview"]));
const pluginPageCache = new Map();
const COLLAPSE_KEY = "wb_sidebar_collapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export const AppShell = {
  name: "AppShell",
  components: { OverviewPage, StatePage, ActivityPage, InjectionsPage, UsagePage, MemoryPage, ModelPage, SystemPage, ModulesPage },
  setup() {
    const route = ref(routeFromHash());
    const sidebarOpen = ref(false);
    const collapsed = ref(readCollapsed());
    const mql = window.matchMedia("(max-width: 1024px)");
    const isMobile = ref(mql.matches);
    const now = ref(Date.now());
    const tokenInput = ref("");
    const loginError = ref("");
    const loggingIn = ref(false);

    const currentPage = shallowRef(PAGES[route.value] || OverviewPage);
    // 只在插件路由签名变化时重算页面;状态轮询/推送不会触发页面切换
    const pluginSignature = computed(() =>
      (store.status?.plugins ?? [])
        .map((p) => `${p.id}:${p.enabled ? 1 : 0}:${p.panel?.route ?? ""}:${p.panel?.url ?? ""}`)
        .join("|"),
    );
    const pluginNavItems = computed(() =>
      (store.status?.plugins ?? [])
        .filter((p) => p.panel?.route)
        .map((p) => ({
          route: p.panel.route,
          label: p.panel.title,
          icon: p.panel.icon || "layers",
          plugin: p.id,
          enabled: p.enabled,
          order: p.panel.order ?? 1000,
        }))
        .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)),
    );
    const navGroups = computed(() => [
      ...NAV,
      {
        group: "模块",
        items: [{ route: "modules", label: "模块总览", icon: "layers" }, ...pluginNavItems.value],
      },
    ]);
    const currentMeta = computed(() => {
      for (const g of navGroups.value) {
        const item = g.items.find((i) => i.route === route.value);
        if (item) return { ...item, group: g.group };
      }
      return { route: route.value, label: "未知页面", group: "模块" };
    });
    const sidebarCollapsed = computed(() => collapsed.value && !isMobile.value);
    const groupDefault = computed(() => {
      const group = navGroups.value.find((g) => g.group === currentMeta.value.group);
      return group?.items[0]?.route || GROUP_DEFAULT[currentMeta.value.group] || "overview";
    });
    const toggleIcon = computed(() => (isMobile.value ? "menu" : "panelLeft"));
    const sidebarToggleLabel = computed(() =>
      isMobile.value
        ? sidebarOpen.value
          ? "关闭导航"
          : "打开导航"
        : collapsed.value
          ? "展开侧边栏"
          : "收起侧边栏",
    );
    // 实时通道本身是事件驱动的;心跳每 15s 一次,超过 40s 没消息才判定为延迟
    const fresh = computed(() => {
      void now.value; // 让本地时钟驱动「心跳是否还算新鲜」的判断
      return store.live.connected && Date.now() - (store.live.lastEventAt || 0) < 40_000;
    });
    const freshLabel = computed(() => {
      if (store.live.authFailed) return "登录失效";
      if (store.statusError) return "连接中断";
      if (!store.live.connected) return "连接中";
      if (!fresh.value) return "心跳延迟";
      return "实时";
    });
    // 模拟时间由最近一次推送 + 本地流逝外推,不需要每秒请求后端
    const simClock = computed(() => fmtSimClock(simNowMs(store.status, now.value)));
    const realClock = computed(() => fmtFullDate(now.value));

    function toggleSidebar() {
      if (isMobile.value) sidebarOpen.value = !sidebarOpen.value;
      else collapsed.value = !collapsed.value;
    }
    function clearSidebarSelection() {
      try {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const sidebar = document.querySelector(".sidebar");
        if (!sidebar) return;
        const inside = (node) => Boolean(node && sidebar.contains(node));
        if (inside(sel.anchorNode) || inside(sel.focusNode)) sel.removeAllRanges();
      } catch {
        // 选区 API 不可用时忽略
      }
    }
    function onMediaChange(e) {
      isMobile.value = e.matches;
      if (!e.matches) sidebarOpen.value = false;
    }
    function onHash() {
      route.value = routeFromHash();
      sidebarOpen.value = false;
      window.scrollTo(0, 0);
    }
    function onKeydown(e) {
      if (e.key === "Escape") sidebarOpen.value = false;
    }

    async function submitLogin() {
      if (loggingIn.value) return;
      loggingIn.value = true;
      loginError.value = "";
      try {
        await login(tokenInput.value);
        tokenInput.value = "";
      } catch (err) {
        loginError.value = store.auth.error || err.message || "登录失败";
      } finally {
        loggingIn.value = false;
      }
    }
    async function retry() {
      loginError.value = "";
      const ok = await bootstrap();
      if (!ok && !store.auth.error) loginError.value = "仍无法连接后端";
      else if (!ok) loginError.value = store.auth.error;
    }
    function doLogout() {
      logout();
      tokenInput.value = "";
      loginError.value = "";
    }

    async function resolvePage(r) {
      if (PAGES[r]) return PAGES[r];
      const plugin = (store.status?.plugins ?? []).find((p) => p.panel?.route === r);
      if (!plugin) return NotFoundPage;
      if (!plugin.enabled) return makePluginUnavailablePage(plugin);
      if (!plugin.panel?.url) return makePluginErrorPage(plugin, new Error("manifest 缺少可加载的面板入口"));
      const key = `${plugin.id}:${plugin.panel.url}`;
      if (pluginPageCache.has(key)) return pluginPageCache.get(key);
      try {
        const mod = await import(plugin.panel.url);
        const component = mod.default || mod.Panel || mod.page;
        if (!component) throw new Error(`${plugin.panel.url} 没有 default 导出`);
        pluginPageCache.set(key, component);
        return component;
      } catch (err) {
        // 清掉旧缓存,插件更新后重新加载
        pluginPageCache.delete(key);
        return makePluginErrorPage(plugin, err);
      }
    }

    let pageToken = 0;
    async function showRoute() {
      const token = ++pageToken;
      const component = await resolvePage(route.value);
      // 同一个组件对象不重复赋值,避免触发一次无意义的重新渲染
      if (token === pageToken && component && component !== currentPage.value) {
        currentPage.value = component;
      }
    }
    watch(route, () => void showRoute(), { immediate: true });
    // 插件启停/新增只影响模块相关页面,不会因为 status 每次推送就重新解析路由
    watch(pluginSignature, () => {
      const current = (store.status?.plugins ?? []).find((p) => p.panel?.route === route.value);
      if (current || route.value === "modules") void showRoute();
    });

    let ticker = null;
    onMounted(() => {
      applyTheme();
      window.addEventListener("hashchange", onHash);
      window.addEventListener("keydown", onKeydown);
      mql.addEventListener("change", onMediaChange);
      ticker = setInterval(() => (now.value = Date.now()), 1000);
      void bootstrap();
    });
    onBeforeUnmount(() => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKeydown);
      mql.removeEventListener("change", onMediaChange);
      clearInterval(ticker);
    });
    watch(route, () => {
      sidebarOpen.value = false;
    });
    watch(collapsed, (v) => {
      clearSidebarSelection();
      try {
        localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
      } catch {
        // 隐私模式下忽略持久化失败
      }
    });
    watch(sidebarOpen, (v) => {
      if (!v) clearSidebarSelection();
    });

    return {
      store,
      NAV,
      navGroups,
      route,
      sidebarOpen,
      collapsed,
      sidebarCollapsed,
      isMobile,
      now,
      tokenInput,
      loginError,
      loggingIn,
      currentPage,
      currentMeta,
      groupDefault,
      toggleIcon,
      sidebarToggleLabel,
      fresh,
      freshLabel,
      simClock,
      realClock,
      toggleSidebar,
      submitLogin,
      retry,
      doLogout,
      toggleTheme,
      relativeTime,
    };
  },
  template: `<div v-if="!store.auth.checked" class="boot-screen">
    <div class="boot-inner"><span class="brand-mark brand-mark-lg">w</span><Spinner :size="18" /><span>正在连接 watching-bot</span></div>
  </div>

  <div v-else-if="!store.auth.ok" class="gate-screen">
    <div class="gate-shell">
      <aside class="gate-brand">
        <span class="brand-mark brand-mark-lg">w</span>
        <h1>watching-bot</h1>
        <p>一个自己过日子的拟人 agent。这里是它的管理面板。</p>
        <div class="gate-signal" aria-hidden="true">
          <span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>
        </div>
        <div class="gate-notes">
          <div><span>状态</span><b>五维隐藏状态</b></div>
          <div><span>记忆</span><b>睡眠期归并</b></div>
          <div><span>循环</span><b>自驱 + 兜底</b></div>
        </div>
      </aside>
      <section class="gate-login">
        <div class="gate-login-inner">
          <span class="gate-kicker">管理面板</span>
          <h2>输入访问口令</h2>
          <p class="gate-sub">口令来自环境变量 WATCHING_BOT_PANEL_TOKEN。未设置时直接进入。</p>
          <form @submit.prevent="submitLogin">
            <label class="field-label" for="gate-token">口令</label>
            <input id="gate-token" v-model="tokenInput" class="input" type="password" autocomplete="current-password" placeholder="WATCHING_BOT_PANEL_TOKEN" />
            <button class="btn btn-primary gate-submit" type="submit" :disabled="loggingIn">
              <Spinner v-if="loggingIn" :size="14" /><Icon v-else name="arrowRight" :size="16" />进入面板
            </button>
          </form>
          <p v-if="loginError || store.auth.error" class="field-error">{{ loginError || store.auth.error }}</p>
          <button class="btn btn-ghost btn-sm gate-retry" @click="retry"><Icon name="refresh" :size="14" />重新连接</button>
        </div>
      </section>
    </div>
    <ToastHost />
  </div>

  <div v-else class="shell" :class="{ 'sidebar-open': sidebarOpen, 'sidebar-collapsed': sidebarCollapsed }">
    <button class="sidebar-backdrop" aria-label="关闭导航" @click="sidebarOpen = false"></button>
    <aside class="sidebar" :class="{ 'is-collapsed': sidebarCollapsed }">
      <div class="brand">
        <span class="brand-mark">w</span>
        <div class="brand-text"><b>watching-bot</b><span>管理面板</span></div>
        <button class="btn-icon btn-ghost sidebar-close" aria-label="关闭导航" @click="sidebarOpen = false"><Icon name="x" :size="16" /></button>
      </div>

      <nav class="nav" aria-label="主导航">
        <div v-for="g in navGroups" :key="g.group" class="nav-group">
          <div class="nav-group-label" aria-hidden="true">
            <span class="nav-group-label-h">{{ g.group }}</span>
            <span class="nav-group-label-v">
              <span class="nav-group-label-v-inner">
                <span v-for="(ch, ci) in Array.from(g.group)" :key="ci">{{ ch }}</span>
              </span>
            </span>
          </div>
          <a v-for="item in g.items" :key="item.route" class="nav-item" :class="{ 'is-active': route === item.route }"
            :href="'#/' + item.route" :aria-current="route === item.route ? 'page' : undefined"
            :title="sidebarCollapsed ? item.label : undefined" :aria-label="item.label">
            <Icon :name="item.icon" :size="17" />
            <span class="nav-label-clip"><span class="nav-label">{{ item.label }}</span></span>
          </a>
        </div>
      </nav>

      <div class="sidebar-foot">
        <div class="status-track">
          <StatusPill v-if="store.status" :phase="store.status.phase" />
          <LiveDot :live="fresh" :label="freshLabel" />
        </div>
        <div class="foot-meta">
          <div class="foot-times">
            <div class="sidebar-clock">
              <span class="clock-label">模拟</span><span class="clock-value">{{ simClock }}</span>
            </div>
            <div class="sidebar-clock">
              <span class="clock-label">真实</span><span class="clock-value">{{ realClock }}</span>
            </div>
          </div>
          <div class="foot-scale" :title="'模拟时间倍率 ×' + (store.status?.timeScale ?? '-')">
            ×{{ store.status?.timeScale ?? "-" }}
          </div>
        </div>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="topbar-left">
          <button class="btn-icon btn-ghost topbar-menu" :aria-label="sidebarToggleLabel" :title="sidebarToggleLabel" @click="toggleSidebar">
            <Icon :name="toggleIcon" :size="18" />
          </button>
          <nav class="breadcrumb" aria-label="位置">
            <a class="breadcrumb-link" :href="'#/' + groupDefault" :title="'前往' + currentMeta.group + '默认页'">{{ currentMeta.group }}</a>
            <Icon name="chevronRight" :size="12" />
            <b>{{ currentMeta.label }}</b>
          </nav>
        </div>
        <div class="topbar-right">
          <LiveDot :live="fresh" :label="freshLabel" />
          <span class="topbar-updated">{{ store.live.lastEventAt ? relativeTime(store.live.lastEventAt, now) + '更新' : '' }}</span>
          <button class="btn-icon btn-ghost" :aria-label="store.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'" @click="toggleTheme">
            <Icon :name="store.theme === 'dark' ? 'sun' : 'moon'" :size="17" />
          </button>
          <button class="btn-icon btn-ghost" aria-label="退出面板" @click="doLogout"><Icon name="logout" :size="16" /></button>
        </div>
      </header>

      <main class="content">
        <div v-if="store.legacyBackend" class="banner banner-warn">
          <Icon name="alert" :size="16" />
          <span>后端仍是旧进程,新面板 API 尚未加载。请重启 watching-bot(npm start)后再刷新本页。</span>
        </div>
        <component :is="currentPage" />
      </main>
    </div>
    <ToastHost />
  </div>`,
};
