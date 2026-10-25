# 架构

## 分层与依赖方向

```
                 ┌──────────────────────────┐
                 │ 状态管理 StateManager      │ 隐藏,LLM 不可见
                 │ 只监控 agent 本体          │
                 └─────╮──────────╭─────────┘
              事件总线(sub)│      │命令 API(inject/forceSleep/wake)
                 ┌───────╯────────╰──────╮
                 │  核心 core(agent 承载)  │
                 │  pi Agent + 无限循环     │
                 │  醒睡状态机+clock+注入器  │
                 └───────────╮───────────┘
                             │ 唯一边界:模块总线 ModuleBus
              ┌──────────────┼──────────────┬─────────────┐
           napcat      mock(测试)     未来:其他IM/沙箱电脑/联网搜索
```

依赖方向铁律:**`modules → bus ← core ← state-manager`**。

- 核心(core)不 import 任何具体模块 —— 它只看见「一堆黑箱工具」和归一化的感知事件;
- 状态管理器不感知任何模块 —— 它只消费核心事件流;
- 模块之间互不相识。

验证方式:管理面板热停用任意模块,核心与状态管理零改动照常运行(`src/modules/builtin/` 就是另一个可插拔模块的存在证明)。

## 模块总线(最重要的接口)

契约定义在 `src/bus/types.ts`,实现只有一个类 `src/bus/host.ts`:

```ts
interface BotModule {
  name: string;
  summary: string;                  // 一句话能力简介,进系统提示「可用能力」段
  tools: AgentTool[];               // pi TypeBox 工具,自描述
  toolTags?: Record<string, string[]>;  // 工具语义标签,如 send_message: ["social"]
  init(ctx: ModuleCtx): Promise<void>;
  stop(): Promise<void>;
}
interface ModuleCtx {
  config: unknown;                  // config/modules.<name> 段
  emitPerception(e: PerceptionEvent): void;  // 模块对核心的唯一反向通道
  simNow(): number;
  log(msg: string): void;
}
interface PerceptionEvent {
  kind: "message" | "mention" | "mention_storm" | "alert";
  intensity: number;                // 1-5
}
```

两个关键翻译都发生在核心侧,模块零提示词知识:

1. **工具注入**:总线把所有模块工具拼合挂到 pi Agent;系统提示的「可用能力」段由 `bus.capabilitySection()` 动态生成,模块启停工具即出现/消失。
2. **感知翻译**:`emitPerception` 只报语义(kind + 强度),核心查 `src/core/copy.ts` 文案表翻译成体感注入(「手机震了一下」「好像有人在叫你」)。

`toolTags` 语义标签是解耦的粘合剂:状态管理器想给「社交行为」消耗社交电量,但它不认识 `send_message` —— napcat 在工具定义旁声明 `send_message: ["social"]`,核心把 `tool_execution_start` 事件连同标签发给状态管理器,后者只认标签。换一个 IM 适配器,只要给它自己的发消息工具打上 `social`,状态管理一行不改。

## 核心(core)内部

| 组件 | 文件 | 职责 |
|---|---|---|
| 时钟 | `src/core/clock.ts` | `simNow = simStart + 真实流逝 × timeScale`;所有状态动力学/闹钟/wait 按模拟时间;支持面板热调倍率(重定基不跳变)。tick 每 `tickRealMs` 触发一次,是整个系统的心跳 |
| 注入器 | `src/core/inject.ts` | 体感(kind+tier)→伪造 assistant 内心独白 `<feeling>…</feeling>`;环境事件→`[环境]` user 旁白。注入先入队,loop 在 kick 前 flush;同 kind 环境感知去重防灌水 |
| 文案表 | `src/core/copy.ts` | 状态区间 → 主观描述的映射。**状态数值永不进入提示词**(tests/state-engine.test.ts 有专门断言) |
| Agent 装配 | `src/core/agent.ts` | pi Agent 构造:leading system 消息 = persona.md + 命名 sections(memory/capabilities/instructions,可热更新);`transformContext` 钩子接 pi 的 compaction 纯函数做日常压缩 |
| 内置工具 | `src/core/tools.ts` | `wait`/`sleep`/`wake_up`/`set_alarm`/`cancel_alarm`/`what_time_is_it` |
| 状态机 | `src/core/machine.ts` | `awake / sleep_transition / asleep / waking` 四态;强制入睡、系统级唤醒(自然醒/硬上限)不经模型,闹钟/风暴打断进 `waking` 由模型决定 |
| 循环 | `src/core/loop.ts` | orchestrator,见下 |

## 无限循环:kick 模型

orchestrator 是**唯一决定「何时调用 LLM」的角色**:

```
触发器(wait到期 / 闹钟 / 感知体感 / 状态命令 / 心跳兜底)
   → kick = flush 注入队列 + 拼一条 [节拍] user 消息 → agent.prompt(batch)
   → 模型反复调工具直到不再调用 → run 自然结束 → 挂起
   → onRunEnd 评估:赖床判定 / 空响应退避 / 排下一次心跳
```

- `wait(minutes)` 工具立即返回,loop 按模拟时间排程下一次 kick —— 模型自己决定放空多久;
- 空响应(没调工具且文本 <8 字符)→ 心跳间隔指数退避(30→60→…→180 模拟分),防烧钱空转;
- run 进行中来触发 → `agent.steer()` 注入,不打断当前 run。

pi 的角色:agent loop、Context(可拼接任意消息,混合注入因此可行)、`steer` 队列、`transformContext` 钩子、faux provider(测试),模型网关见 `docs/configuration.md` 的「模型接入」。

## 醒睡状态机

```
            sleep 工具(自愿) / 疲惫≥90(强制)
  AWAKE ────────────────────────────────────────► SLEEP_TRANSITION
    ▲                                              (睡眠期归并:日记+MEMORY.md)
    │ 确认起床 wake_up            ◄── 归并完成 ──────┘
    │                                                    │
    │                                    系统级:疲惫≤15 自然醒 /
    │ WAKING   ◄── 闹钟/@风暴打断(beginWaking)            │ 模拟12h硬上限 / 面板
    │    │                                               ▼
    │    ├─ 模型调 wake_up ──► AWAKE(没睡够则注入困意)   ASLEEP
    │    └─ run 结束没调 ──► 赖床:ASLEEP,响铃源重新排程,────┘
    │         烦躁累积,赖满 6 次强制拽醒
```

要点:

- **闹钟重响**是真实重新入列(`alarms` 表新记录),不是简单定时 kick —— 所以「已经第 N 次了」的升级文案来自 `snoozeCount`;
- 模型在被叫醒的犹豫期(WAKING)调 `sleep` 等价于赖床(`machine.sleepVoluntarily` 处理);
- 醒来时疲惫仍 ≥ `drowsyOnWake`(40)→ 注入「没睡够」体感 —— 对应「闹钟响了但疲惫没降下来,醒了也困」。

## 状态管理与 judge

`src/state/manager.ts` 只做三件事:

1. 消费核心事件流(`turn_end`/`tool_call`+tags/`perception`/`alarm_rang`/`phase_changed`),映射为 `StateEvent` 交给纯函数引擎(`src/state/engine.ts`)做变量动力学;
2. 每个 tick 后评估阈值 → 经 `CoreCommands` 注入体感(同类同档冷却 45 模拟分,升档立即);
3. 阈值硬动作:疲惫≥90 强制入睡、≤15 自然醒。

judge(`src/state/judge.ts`)是双通道 LLM 情绪修正:

- **实时通道**:mention_storm / 闹钟连环触发一次廉价 LLM 判读,输出 `{moodDelta, stressDelta}`,manager 侧有冷却(30 模拟分)与每日上限双保险;
- **睡眠通道**:睡眠期归并时模型可用 `adjust_mood` 工具给今天做一次情绪结算 —— 复用睡前总结,零额外调用。

## 持久化

- SQLite(`data/watching-bot.db`):`state_history`(状态曲线)/ `injections`(注入流水,「它为什么这样」可回溯)/ `sleep_log` / `alarms` / `events`;
- `data/state.json`:快照(当前变量、agent transcript、闹钟),每 30s 与优雅退出时写;重启从快照恢复,模拟时间从快照锚点续走。
- 模块私有库:`data/modules/napcat.db`(消息流水/已读游标/@提及/表情包索引),核心不读它。

详细机制之外的行为规格(赖床次数上限、风暴聚合窗口等)全部在 `config/default.json` 的 `state.thresholds` / `loop` 段,见 `docs/configuration.md`。
