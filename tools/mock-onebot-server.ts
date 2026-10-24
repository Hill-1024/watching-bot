import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";

/**
 * 假 OneBot 11 服务器:无需真 QQ 号即可全链路测试 napcat 模块。
 * - 接受 WS 连接(可选 token 校验跳过)
 * - 响应动作:get_login_info / get_friend_list / get_group_list / send_*_msg
 *   以及管理/表情/图片类:set_group_ban / set_group_special_title /
 *   set_msg_emoji_like / get_group_member_info / get_image
 * - 内置 HTTP 图片服务(3002 端口),群消息周期性带图,测表情包链路
 * - 按 cron 剧本推送私聊/群聊/被@消息;--storm 立即来一轮 @风暴
 *
 * 用法: npx tsx tools/mock-onebot-server.ts [ws端口=3001] [--storm]
 */
const port = Number(process.argv[2] ?? 3001) || 3001;
const imgPort = port + 1;
const stormNow = process.argv.includes("--storm");

/** 1x1 红色 PNG,当测试图用 */
const TEST_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "image/png" });
  res.end(Buffer.from(TEST_PNG, "base64"));
}).listen(imgPort, () => console.log(`[mock-onebot] 测试图片服务 http://127.0.0.1:${imgPort}/meme.png`));

const SELF = { user_id: 10000, nickname: "阿望" };
const FRIENDS = [
  { user_id: 20001, nickname: "小林", remark: "林林" },
  { user_id: 20002, nickname: "老王", remark: "" },
  { user_id: 20003, nickname: "组长", remark: "加班侠" },
];
const GROUPS = [{ group_id: 30001, group_name: "摸鱼互助小组", member_count: 42 }];

const wss = new WebSocketServer({ port });
let echoSeq = 0;
const sockets = new Set<WebSocket>();

wss.on("connection", (ws) => {
  console.log("[mock-onebot] client connected");
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  ws.on("message", (data) => {
    let msg: { action?: string; params?: Record<string, unknown>; echo?: string };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const { action, params = {}, echo } = msg;
    let dataResult: unknown = null;
    switch (action) {
      case "get_login_info":
        dataResult = SELF;
        break;
      case "get_friend_list":
        dataResult = FRIENDS;
        break;
      case "get_group_list":
        dataResult = GROUPS;
        break;
      case "get_group_member_info":
        dataResult = {
          group_id: params.group_id,
          user_id: params.user_id,
          role: params.user_id === 20003 ? "owner" : "member",
          card: params.user_id === 20003 ? "组长" : "",
          nickname: FRIENDS.find((f) => f.user_id === params.user_id)?.nickname ?? "",
          title: params.user_id === 20003 ? "加班侠" : "",
        };
        break;
      case "get_image":
        dataResult = { file: "mock.png", url: `http://127.0.0.1:${imgPort}/meme.png` };
        break;
      case "send_group_msg":
        console.log(`[mock-onebot] 群消息 -> ${String(params.group_id)}: ${JSON.stringify(params.message)}`);
        dataResult = { message_id: Math.floor(Math.random() * 1e6) };
        break;
      case "send_private_msg":
        console.log(`[mock-onebot] 私聊 -> ${String(params.user_id)}: ${JSON.stringify(params.message)}`);
        dataResult = { message_id: Math.floor(Math.random() * 1e6) };
        break;
      case "set_group_ban":
        console.log(`[mock-onebot] 禁言 -> 群${String(params.group_id)} 成员${String(params.user_id)} ${String(params.duration)}s`);
        break;
      case "set_group_special_title":
        console.log(`[mock-onebot] 头衔 -> 群${String(params.group_id)} 成员${String(params.user_id)}:「${String(params.special_title)}」`);
        break;
      case "set_msg_emoji_like":
        console.log(`[mock-onebot] 贴表情 -> 消息${String(params.message_id)} 表情${String(params.emoji_id)}`);
        break;
      default:
        console.log(`[mock-onebot] 未知动作(按成功应答): ${action}`);
        dataResult = null;
    }
    if (echo) {
      ws.send(JSON.stringify({ status: "ok", retcode: 0, data: dataResult, echo: echo ?? `s${++echoSeq}` }));
    }
  });

  // 连上就先推几条历史,让 list_chats/read_messages 有东西可看
  const now = Math.floor(Date.now() / 1000);
  pushMessage(ws, { message_type: "private", user_id: 20001, text: "在吗?晚上一起打游戏?", atMe: false, time: now - 600 });
  pushMessage(ws, { message_type: "private", user_id: 20002, text: "周末去爬山吗", atMe: false, time: now - 300 });
  pushMessage(ws, {
    message_type: "group",
    group_id: 30001,
    user_id: 20003,
    sender: { card: "组长", nickname: "组长" },
    segments: [
      { type: "at", data: { qq: String(SELF.user_id) } },
      { type: "text", data: { text: " 今晚值班看一下报告" } },
    ],
    time: now - 120,
  });
  pushMessage(ws, {
    message_type: "group",
    group_id: 30001,
    user_id: 20001,
    sender: { nickname: "小林" },
    segments: [
      { type: "text", data: { text: "看这个梗图 " } },
      { type: "image", data: { url: `http://127.0.0.1:${imgPort}/meme.png`, file: `img_${now}.image` } },
    ],
    time: now - 60,
  });
});

function pushMessage(
  ws: WebSocket,
  opts: {
    message_type: "private" | "group";
    user_id: number;
    group_id?: number;
    text?: string;
    segments?: { type: string; data: Record<string, unknown> }[];
    sender?: { card?: string; nickname?: string };
    atMe?: boolean;
    time: number;
  },
): void {
  const friend = FRIENDS.find((f) => f.user_id === opts.user_id);
  const event = {
    post_type: "message",
    message_type: opts.message_type,
    message_id: Math.floor(Math.random() * 1e9),
    time: opts.time,
    user_id: opts.user_id,
    group_id: opts.group_id,
    message:
      opts.segments ??
      [
        ...(opts.atMe ? [{ type: "at", data: { qq: String(SELF.user_id) } }] : []),
        { type: "text", data: { text: (opts.atMe ? " " : "") + (opts.text ?? "") } },
      ],
    raw_message: opts.text ?? "",
    sender: { user_id: opts.user_id, nickname: friend?.nickname ?? String(opts.user_id), card: opts.sender?.card },
    self_id: SELF.user_id,
  };
  ws.send(JSON.stringify(event));
}

function broadcast(opts: Parameters<typeof pushMessage>[1]): void {
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) pushMessage(ws, opts);
  }
}

// 剧本:每 45 秒一条私聊;每 3 分钟一轮被@连环;群消息周期性带图(表情包链路)
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  const texts = ["在干嘛", "哈哈哈笑死", "你看这个 news", "吃了吗"];
  broadcast({
    message_type: "private",
    user_id: FRIENDS[Math.floor(Math.random() * FRIENDS.length)]!.user_id,
    text: texts[Math.floor(Math.random() * texts.length)]!,
    time: now,
  });
}, 45_000);

// 每 90 秒往群里发一张图(测 收藏/查看/发表情包 链路)
setInterval(() => {
  broadcast({
    message_type: "group",
    group_id: 30001,
    user_id: 20001,
    sender: { nickname: "小林" },
    segments: [
      { type: "text", data: { text: "新梗图," } },
      { type: "image", data: { url: `http://127.0.0.1:${imgPort}/meme.png`, file: `img_${Date.now()}.image` } },
    ],
    time: Math.floor(Date.now() / 1000),
  });
}, 90_000);

setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 6; i++) {
    setTimeout(() => {
      broadcast({
        message_type: "group",
        group_id: 30001,
        user_id: 20003,
        sender: { card: "组长" },
        segments: [
          { type: "at", data: { qq: String(SELF.user_id) } },
          { type: "text", data: { text: ` 人呢?!第 ${i + 1} 次呼叫` } },
        ],
        time: Math.floor(Date.now() / 1000),
      });
    }, i * 1500);
  }
}, 180_000);

if (stormNow) {
  setTimeout(() => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 8; i++) {
      broadcast({
        message_type: "group",
        group_id: 30001,
        user_id: 20003,
        sender: { card: "组长" },
        segments: [
          { type: "at", data: { qq: String(SELF.user_id) } },
          { type: "text", data: { text: ` 紧急!马上回话 ${i + 1}` } },
        ],
        time: now,
      });
    }
  }, 2000);
}

wss.on("listening", () => {
  console.log(`[mock-onebot] 假 OneBot 11 服务器就绪 ws://127.0.0.1:${port} (--storm 可立即触发@风暴)`);
});
