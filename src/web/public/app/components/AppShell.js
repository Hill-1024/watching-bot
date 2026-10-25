import { computed, onBeforeUnmount, onMounted, ref, watch } from "/vendor/vue.esm-browser.prod.js";
import { bootstrap, applyTheme, login, logout, store, toggleTheme } from "../store.js";
import { fmtFullDate, relativeTime, routeFromHash } from "../utils.js";
import { OverviewPage } from "../pages/OverviewPage.js";
import { StatePage } from "../pages/StatePage.js";
import { ActivityPage } from "../pages/ActivityPage.js";
import { InjectionsPage } from "../pages/InjectionsPage.js";
import { UsagePage } from "../pages/UsagePage.js";
import { MemoryPage } from "../pages/MemoryPage.js";
import { ModelPage } from "../pages/ModelPage.js";
import { SystemPage } from "../pages/SystemPage.js";

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
      { route: "system", label: "模块与系统", icon: "settings" },
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
};

export const AppShell = {
  name: "AppShell",
  components: { OverviewPage, StatePage, ActivityPage, InjectionsPage, UsagePage, MemoryPage, ModelPage, SystemPage },
  setup() {
    const route = ref(routeFromHash());
    const sidebarOpen = ref(false);
    const now = ref(Date.now());
    const tokenInput = ref("");
    const loginError = ref("");
    const loggingIn = ref(false);

    const currentPage = computed(() => PAGES[route.value] || OverviewPage);
    const currentMeta = computed(() => {
      for (const g of NAV) {
        const item = g.items.find((i) => i.route === route.value);
        if (item) return { ...item, group: g.group };
      }
      return NAV[0].items[0];
    });
    const fresh = computed(() => Boolean(store.statusAt) && now.value - store.statusAt < 8000);
    const freshLabel = computed(() => {
      if (store.statusError) return "连接中断";
      if (!store.statusAt) return "连接中";
      if (!fresh.value) return "数据延迟";
      return "实时";
    });
    const simClock = computed(() => store.status?.sim || "-");
    const realClock = computed(() => fmtFullDate(now.value));

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

    let ticker = null;
    onMounted(() => {
      applyTheme();
      window.addEventListener("hashchange", onHash);
      window.addEventListener("keydown", onKeydown);
      ticker = setInterval(() => (now.value = Date.now()), 1000);
      void bootstrap();
    });
    onBeforeUnmount(() => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKeydown);
      clearInterval(ticker);
    });
    watch(route, () => {
      // 路由切换由 hashchange 负责,这里只用于确保移动端抽屉收起
      sidebarOpen.value = false;
    });

    return {
      store,
      NAV,
      route,
      sidebarOpen,
      now,
      tokenInput,
      loginError,
      loggingIn,
      currentPage,
      currentMeta,
      fresh,
      freshLabel,
      simClock,
      realClock,
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

  <div v-else class="shell" :class="{ 'sidebar-open': sidebarOpen }">
    <button class="sidebar-backdrop" aria-label="关闭导航" @click="sidebarOpen = false"></button>
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">w</span>
        <div class="brand-text"><b>watching-bot</b><span>管理面板</span></div>
        <button class="btn-icon btn-ghost sidebar-close" aria-label="关闭导航" @click="sidebarOpen = false"><Icon name="x" :size="16" /></button>
      </div>

      <nav class="nav" aria-label="主导航">
        <div v-for="g in NAV" :key="g.group" class="nav-group">
          <div class="nav-group-label">{{ g.group }}</div>
          <a v-for="item in g.items" :key="item.route" class="nav-item" :class="{ 'is-active': route === item.route }"
            :href="'#/' + item.route" :aria-current="route === item.route ? 'page' : undefined">
            <Icon :name="item.icon" :size="17" />
            <span>{{ item.label }}</span>
          </a>
        </div>
      </nav>

      <div class="sidebar-foot">
        <div class="sidebar-status">
          <StatusPill v-if="store.status" :phase="store.status.phase" />
          <LiveDot :live="fresh" :label="freshLabel" />
        </div>
        <div class="sidebar-clock">
          <span class="clock-label">模拟</span><span class="clock-value">{{ simClock }}</span>
        </div>
        <div class="sidebar-clock">
          <span class="clock-label">真实</span><span class="clock-value">{{ realClock }}</span>
        </div>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="topbar-left">
          <button class="btn-icon btn-ghost topbar-menu" aria-label="打开导航" @click="sidebarOpen = true"><Icon name="menu" :size="18" /></button>
          <nav class="breadcrumb" aria-label="位置">
            <span>{{ currentMeta.group }}</span>
            <Icon name="chevronRight" :size="12" />
            <b>{{ currentMeta.label }}</b>
          </nav>
        </div>
        <div class="topbar-right">
          <LiveDot :live="fresh" :label="freshLabel" />
          <span class="topbar-updated">{{ store.statusAt ? relativeTime(store.statusAt, now) + '更新' : '' }}</span>
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
        <Transition name="page" mode="out-in">
          <component :is="currentPage" :key="route" />
        </Transition>
      </main>
    </div>
    <ToastHost />
  </div>`,
};
