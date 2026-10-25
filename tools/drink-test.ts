import { BuiltinModule } from "../src/modules/builtin/index.js";

const m = new BuiltinModule();
const seen: unknown[] = [];
await m.init({
  config: { master: { qq: 123, name: "测试主人" }, coffee: { dailyQuota: 2, refillSimHour: 0 } },
  emitPerception: (e: unknown) => seen.push(e),
  simNow: () => Date.now(),
  log: () => {},
} as never);
const tool = m.tools[0]!;
const r1 = await tool.execute("t", {} as never);
console.log("喝第1杯:", JSON.stringify(r1.content), "| details:", JSON.stringify(r1.details));
await tool.execute("t", {} as never);
console.log("感知(应含 stimulant):", JSON.stringify(seen));
const r3 = await tool.execute("t", {} as never);
console.log("第3杯(空):", JSON.stringify(r3.content));
console.log("coffeeRemaining:", m.coffeeRemaining(), "| grant(2) 后:", (m.grantCoffee(2), m.coffeeRemaining()));
process.exit(0);
