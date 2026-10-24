import { installFauxLlm } from "../src/faux.js";
import { runConsolidation } from "../src/memory/consolidation.js";
import { MemoryStore } from "../src/memory/files.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const llm = installFauxLlm();
const memory = new MemoryStore({
  dataDir: "data",
  memoryFile: "data/MEMORY.md",
  diaryDir: "data/memories",
  consolidateDiaryDaysToWeek: 7,
});
const transcript = [
  { role: "user", content: "[节拍] (kick:boot) 测试", timestamp: Date.now() },
  { role: "assistant", content: [{ type: "text", text: "今天很平淡" }], timestamp: Date.now() },
] as unknown as AgentMessage[];
await runConsolidation(
  { model: llm.model as never, streamFn: llm.streamFn, memory, log: (m) => console.log("LOG:", m) },
  transcript,
  Date.now(),
);
console.log("diaries:", memory.listDiaryDates());
console.log("index head:", memory.indexText().slice(0, 200));
process.exit(0);
