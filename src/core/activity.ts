/** 活动日志条目(思维链/输出/工具调用/错误) */
export interface ActivityEntry {
  seq: number;
  tsSim: number;
  tsReal: number;
  kind: "thinking" | "text" | "tool_call" | "tool_result" | "error";
  text: string;
}
