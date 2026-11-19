// Dev helper: call browser-mcp tools from the shell.
// Usage: node scripts/call.ts <tool> '<json args>' [<tool> '<json args>' ...]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "browser-mcp-cli", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../src/index.ts", import.meta.url).pathname], stderr: "ignore" }));
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const res: any = await client.callTool({ name: argv[i], arguments: JSON.parse(argv[i + 1] ?? "{}") });
  console.log(`=== ${argv[i]}${res.isError ? " (error)" : ""}`);
  for (const c of res.content) console.log(c.type === "text" ? c.text : `[${c.type} ${c.data?.length} b64 chars]`);
}
await client.close();
