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
    const switchingBackend = ref("");
    const now = ref(Date.now());
    const qqBackends = [
      {
        name: "napcat",
        label: "NapCat",
        desc: "默认。NapCat 卡片提供 WebUI token/端口;18 个 QQ 工具。",
      },
      {
        name: "snowluma",
        label: "SnowLuma",
        desc: "OneBot v11 运行时。与 NapCat 共用同一套 18 个工具与消息/表情包数据。",
      },
    ];
    const napcatToken = ref({
      token: "",
      source: "none",
      port: 0,
      exists: false,
      reachable: false,
      onebot: { token: "", source: "none" },
    });
    const napcatPortDraft = ref("");
    const savingNapcatPort = ref(false);
    const napcatPortWaiting = ref(false);
    const napcatPortReady = ref(false);
    const napcatPortMsg = ref("");
    const napcatPortError = ref(false);
    let napcatPortTimer = null;
    let napcatPortDeadline = 0;
    const builtinConfig = ref(null);
    const builtinDraft = ref({ masterName: "", masterQQ: "", dailyQuota: "" });
    const savingBuiltin = ref(false);
    const builtinMsg = ref("");
    const builtinError = ref(false);

    const status = computed(() => store.status);
    const qqBackend = computed(() => (status.value?.qqBackend === "snowluma" ? "snowluma" : "napcat"));
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

    async function loadNapcatToken() {
      try {
        const r = await api("/api/napcat/token");
        const onebot = r.onebot || {};
        const port = typeof r.port === "number" ? r.port : 0;
        napcatToken.value = {
          token: typeof r.token === "string" ? r.token : "",
          source: r.source === "webui-config" || r.source === "env" ? r.source : "none",
          port,
          exists: Boolean(r.exists),
          reachable: Boolean(r.reachable),
          onebot: {
            token: typeof onebot.token === "string" ? onebot.token : "",
            source: onebot.source === "env" || onebot.source === "config" ? onebot.source : "none",
          },
        };
        if (!napcatPortWaiting.value && !savingNapcatPort.value) {
          napcatPortDraft.value = port > 0 ? String(port) : "";
          napcatPortReady.value = Boolean(r.reachable);
        }
      } catch {
        napcatToken.value = {
          token: "",
          source: "none",
          port: 0,
          exists: false,
          reachable: false,
          onebot: { token: "", source: "none" },
        };
        if (!napcatPortWaiting.value && !savingNapcatPort.value) {
          napcatPortDraft.value = "";
          napcatPortReady.value = false;
        }
      }
    }

    function stopNapcatPortPolling() {
      if (napcatPortTimer) {
        clearInterval(napcatPortTimer);
        napcatPortTimer = null;
      }
    }

    async function checkNapcatPort() {
      if (!napcatPortWaiting.value) return;
      try {
        const s = await api("/api/napcat/webui/status");
        if (s.reachable) {
          stopNapcatPortPolling();
          napcatPortWaiting.value = false;
          napcatPortReady.value = true;
          napcatPortError.value = false;
          napcatPortMsg.value = "NapCat WebUI 已就绪";
          notify("success", "NapCat WebUI 已重新唤起");
          await loadNapcatToken();
          return;
        }
      } catch {
        // 重启过程中偶发连接失败,继续等下一轮
      }
      if (Date.now() > napcatPortDeadline) {
        stopNapcatPortPolling();
        napcatPortWaiting.value = false;
        napcatPortReady.value = false;
        napcatPortError.value = true;
        napcatPortMsg.value = "等待超时。请确认 NapCat 已重启并监听新端口,可再次点击保存端口重试。";
      }
    }

    function startNapcatPortPolling() {
      stopNapcatPortPolling();
      napcatPortWaiting.value = true;
      napcatPortReady.value = false;
      napcatPortError.value = false;
      napcatPortMsg.value = "";
      napcatPortDeadline = Date.now() + 120_000;
      napcatPortTimer = setInterval(() => void checkNapcatPort(), 2000);
      void checkNapcatPort();
    }

    async function saveNapcatPort() {
      if (savingNapcatPort.value || napcatPortWaiting.value) return;
      const port = Number(napcatPortDraft.value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        napcatPortError.value = true;
        napcatPortMsg.value = "端口需为 1-65535 的整数";
        return;
      }
      if (!napcatToken.value.exists) {
        napcatPortError.value = true;
        napcatPortMsg.value = "未找到 NapCat WebUI 配置,无法保存端口";
        return;
      }
      savingNapcatPort.value = true;
      napcatPortError.value = false;
      napcatPortMsg.value = "";
      try {
        const r = await api("/api/napcat/webui", {
          method: "PATCH",
          body: JSON.stringify({ port }),
        });
        napcatToken.value = { ...napcatToken.value, port: r.port, exists: true };
        napcatPortDraft.value = String(r.port);
        napcatPortReady.value = false;
        notify(
          "success",
          r.changed ? `WebUI 端口已保存为 ${r.port},等待 NapCat 重启` : "端口未变化,正在检查 WebUI 状态",
        );
        startNapcatPortPolling();
      } catch (err) {
        napcatPortError.value = true;
        napcatPortMsg.value = err.message || "保存端口失败";
        notify("error", err.message || "保存端口失败");
      } finally {
        savingNapcatPort.value = false;
      }
    }

    async function loadBuiltinConfig() {
      try {
        const r = await api("/api/builtin/config");
        builtinConfig.value = r;
        builtinDraft.value = {
          masterName: r.master?.name ?? "",
          masterQQ: String(r.master?.qq ?? 0),
          dailyQuota: String(r.coffee?.dailyQuota ?? 0),
        };
        builtinMsg.value = "";
        builtinError.value = false;
      } catch {
        builtinConfig.value = null;
      }
    }

    async function saveBuiltinConfig() {
      if (savingBuiltin.value) return;
      const name = String(builtinDraft.value.masterName || "").trim();
      const qq = Number(builtinDraft.value.masterQQ);
      const quota = Number(builtinDraft.value.dailyQuota);
      if (!name) {
        builtinError.value = true;
        builtinMsg.value = "主人称呼不能为空";
        return;
      }
      if (!Number.isFinite(qq) || qq < 0 || qq > 9_999_999_999_999) {
        builtinError.value = true;
        builtinMsg.value = "主人 QQ 需为非负整数";
        return;
      }
      if (!Number.isFinite(quota) || quota < 0 || quota > 50) {
        builtinError.value = true;
        builtinMsg.value = "每日配额需在 0-50 之间";
        return;
      }
      savingBuiltin.value = true;
      builtinError.value = false;
      builtinMsg.value = "";
      try {
        const r = await api("/api/builtin/config", {
          method: "PATCH",
          body: JSON.stringify({
            master: { name, qq: Math.round(qq) },
            coffee: { dailyQuota: Math.round(quota) },
          }),
        });
        builtinConfig.value = r;
        builtinDraft.value = {
          masterName: r.master?.name ?? name,
          masterQQ: String(r.master?.qq ?? 0),
          dailyQuota: String(r.coffee?.dailyQuota ?? 0),
        };
        builtinMsg.value = "配置已保存";
        await loadCoffee();
        await fetchStatus();
        notify("success", "builtin 配置已保存");
      } catch (err) {
        builtinError.value = true;
        builtinMsg.value = err.message || "保存失败";
        notify("error", err.message || "保存失败");
      } finally {
        savingBuiltin.value = false;
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

    async function selectQqBackend(name) {
      if (switchingBackend.value || qqBackend.value === name) return;
      switchingBackend.value = name;
      try {
        await postJSON("/api/qq-backend", { name });
        notify("success", `QQ 接入已切换为 ${name === "snowluma" ? "SnowLuma" : "NapCat"}`);
        await fetchStatus();
        await loadNapcatToken();
      } catch (err) {
        notify("error", err.message || "切换 QQ 接入失败");
      } finally {
        switchingBackend.value = "";
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
        if (row.name === "builtin") await loadBuiltinConfig();
        if (row.name === "napcat") await loadNapcatToken();
      } catch (err) {
        notify("error", err.message || "模块切换失败");
      } finally {
        toggling.value = "";
      }
    }

    let ticker = null;
    onMounted(() => {
      void loadCoffee();
      void loadBuiltinConfig();
      void loadNapcatToken();
      ticker = setInterval(() => (now.value = Date.now()), 2000);
    });
    onBeforeUnmount(() => {
      clearInterval(ticker);
      stopNapcatPortPolling();
    });

    return {
      store,
      status,
      moduleRows,
      coffee,
      napcatToken,
      napcatPortDraft,
      savingNapcatPort,
      napcatPortWaiting,
      napcatPortReady,
      napcatPortMsg,
      napcatPortError,
      builtinConfig,
      builtinDraft,
      savingBuiltin,
      builtinMsg,
      builtinError,
      qqBackend,
      qqBackends,
      switchingBackend,
      acting,
      toggling,
      now,
      uptime,
      memoryUpdated,
      loadCoffee,
      commitTimescale,
      act,
      claimCoffee,
      saveNapcatPort,
      saveBuiltinConfig,
      selectQqBackend,
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

        <Panel class="span-6" title="咖啡配给" subtitle="builtin 模块的额度与配置">
          <div v-if="!coffee" class="empty-inline">builtin 模块未启用,咖啡配给不可用。</div>
          <template v-else>
            <div class="big-number">{{ coffee.remaining }}<span class="unit">杯</span></div>
            <p class="panel-note">喝完后它会主动在 QQ 上找主人讨。这里的补货会直接增加今日余量。</p>
            <div class="btn-row">
              <button class="btn" @click="claimCoffee(1)"><Icon name="coffee" :size="15" />补 1 杯</button>
              <button class="btn" @click="claimCoffee(3)"><Icon name="coffee" :size="15" />补 3 杯</button>
            </div>
            <div v-if="builtinConfig" class="builtin-config">
              <div class="divider"></div>
              <div class="builtin-config-head">
                <b>builtin 配置</b>
                <span class="builtin-config-head-hint">每天 {{ builtinConfig.coffee.refillSimHour }} 点(模拟)自动配给</span>
              </div>
              <div class="builtin-config-grid">
                <Field label="主人称呼">
                  <input v-model="builtinDraft.masterName" class="input" maxlength="40" placeholder="主人" />
                </Field>
                <Field label="主人 QQ">
                  <input v-model="builtinDraft.masterQQ" class="input" type="number" min="0" step="1"
                    inputmode="numeric" autocomplete="off" placeholder="0 = 未配置" />
                </Field>
                <Field label="每日默认咖啡配额">
                  <input v-model="builtinDraft.dailyQuota" class="input" type="number" min="0" max="50" step="1" />
                </Field>
              </div>
              <div class="btn-row builtin-config-actions">
                <button class="btn btn-sm" :disabled="savingBuiltin" @click="saveBuiltinConfig">
                  <Spinner v-if="savingBuiltin" :size="12" />保存配置
                </button>
                <span v-if="builtinMsg" :class="builtinError ? 'field-error' : 'field-hint'">{{ builtinMsg }}</span>
              </div>
              <p class="field-hint builtin-config-note">
                配额修改从下一次每日配给生效;今日余量可用上方补货按钮调整。主人 QQ 若由 WATCHING_BOT_MASTER_QQ 指定,重启后以环境变量为准。
              </p>
            </div>
          </template>
        </Panel>

        <Panel class="span-12" title="QQ 接入" subtitle="选择 agent 使用哪套 OneBot 运行时;默认 NapCat">
          <div class="backend-choice">
            <button
              v-for="b in qqBackends"
              :key="b.name"
              type="button"
              class="backend-option"
              :class="{ 'is-active': qqBackend === b.name }"
              :aria-pressed="qqBackend === b.name"
              :disabled="Boolean(switchingBackend)"
              @click="selectQqBackend(b.name)"
            >
              <span class="backend-option-main">
                <b>{{ b.label }}</b>
                <span v-if="qqBackend === b.name" class="badge badge-ok">当前使用</span>
                <span v-if="switchingBackend === b.name" class="backend-switching">
                  <Spinner :size="12" />切换中…
                </span>
              </span>
              <span class="backend-option-desc">{{ b.desc }}</span>
            </button>
          </div>
          <p class="panel-note">
            两套运行时都通过 OneBot 11 接入,工具集完全一致。切换只停/启 agent 侧模块,不负责启动或停止 QQ 进程;请确保所选运行时已在配置的 WS 地址监听。消息、未读与表情包数据共用。
          </p>
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
                <div v-if="m.name === 'napcat'" class="module-token">
                  <div class="module-token-head">
                    <span class="module-token-label">NapCat WebUI 登录 Token</span>
                    <span v-if="napcatToken.token && napcatToken.source !== 'none'" class="module-token-source">
                      来自 {{ napcatToken.source === 'env' ? '环境变量' : 'NapCat 配置' }}
                    </span>
                  </div>
                  <div v-if="napcatToken.token" class="module-token-line">
                    <code class="module-token-value">{{ napcatToken.token }}</code>
                    <CopyButton :text="napcatToken.token" label="复制" />
                  </div>
                  <p v-else class="module-token-empty">未找到 NapCat 的 WebUI 配置(runtime/napcat-node/napcat/config/webui.json)。</p>
                  <div class="module-token-sub">
                    <span>OneBot WS Token</span>
                    <code v-if="napcatToken.onebot.token" class="module-token-sub-value">{{ napcatToken.onebot.token }}</code>
                    <span v-else class="module-token-sub-empty">未配置(当前连接未使用)</span>
                    <CopyButton v-if="napcatToken.onebot.token" :text="napcatToken.onebot.token" label="复制" />
                  </div>
                  <div class="module-webui">
                    <div class="module-webui-form">
                      <Field label="WebUI 端口">
                        <input v-model="napcatPortDraft" class="input" type="number" min="1" max="65535" step="1"
                          :disabled="napcatPortWaiting || savingNapcatPort" />
                      </Field>
                      <button class="btn btn-sm" :disabled="savingNapcatPort || napcatPortWaiting" @click="saveNapcatPort">
                        <Spinner v-if="savingNapcatPort" :size="12" />保存端口
                      </button>
                      <span class="module-webui-state" :class="{ 'is-on': napcatPortReady }">
                        {{ napcatPortReady ? 'WebUI 在线' : 'WebUI 待重启' }}
                      </span>
                    </div>
                    <p v-if="napcatPortWaiting" class="module-webui-wait">
                      <Spinner :size="12" />端口已保存,等待 NapCat 重新唤起…
                    </p>
                    <p v-else-if="napcatPortMsg" :class="napcatPortError ? 'field-error' : 'field-hint'">{{ napcatPortMsg }}</p>
                    <p class="field-hint">WebUI: http://127.0.0.1:{{ napcatPortDraft || '—' }} · 保存后需重启 NapCat 才会生效</p>
                  </div>
                </div>
              </div>
              <span v-if="m.name === 'napcat' || m.name === 'snowluma'" class="module-managed">由上方选择器控制</span>
              <button v-else class="btn btn-sm" :disabled="toggling === m.name" @click="toggleModule(m)">
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
