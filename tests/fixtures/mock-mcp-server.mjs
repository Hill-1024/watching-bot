// 测试用最小 MCP stdio server:initialize / tools/list / tools/call。
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf("\n");
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(msg) {
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "1.0.0" },
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            title: "回显",
            description: "把 text 原样回显",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", description: "要回显的文字" } },
              required: ["text"],
            },
          },
          {
            name: "snap",
            title: "截图",
            description: "返回文字 + 一张假图",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "crash",
            title: "模拟进程退出",
            description: "返回一句话后让 MCP server 进程退出(测试懒重连)",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `echo:${args.text ?? ""}` }] },
      });
      return;
    }
    if (name === "snap") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [
            { type: "text", text: "snap ok" },
            { type: "image", data: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" },
          ],
        },
      });
      return;
    }
    if (name === "crash") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "bye" }] },
      });
      setTimeout(() => process.exit(0), 30);
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true },
    });
    return;
  }
  if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
}
