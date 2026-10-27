export const VAR_META = {
  fatigue: { label: "疲惫", hint: "越高越困", color: "var(--chart-total)" },
  mood: { label: "心情", hint: "会回落到基线", color: "var(--chart-output)" },
  annoyance: { label: "烦躁", hint: "被吵醒会上升", color: "var(--chart-cache)" },
  stress: { label: "压力", hint: "随时间衰减", color: "var(--chart-input)" },
  social: { label: "社交电量", hint: "聊天会消耗", color: "var(--chart-rate)" },
};

export const KIND_META = {
  thinking: { label: "思考", tone: "thinking" },
  text: { label: "输出", tone: "text" },
  tool_call: { label: "调用", tone: "tool" },
  tool_result: { label: "结果", tone: "tool" },
  error: { label: "错误", tone: "error" },
};

export const PHASE_LABEL = {
  awake: "醒着",
  resting: "躺着放空",
  asleep: "睡着",
  sleep_transition: "正在入睡",
  waking: "被吵醒,犹豫中",
};

export const SOURCE_LABEL = {
  main: "主对话",
  compaction: "上下文压缩",
  memory: "睡眠归并",
  weekly: "周记归并",
  judge: "情绪判读",
};

export const SOURCE_TONE = {
  main: "warm",
  compaction: "cool",
  memory: "sage",
  weekly: "sage",
  judge: "rose",
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const USAGE_COLORS = {
  total: "var(--chart-total)",
  input: "var(--chart-input)",
  output: "var(--chart-output)",
  cacheRead: "var(--chart-cache)",
  rate: "var(--chart-rate)",
};
