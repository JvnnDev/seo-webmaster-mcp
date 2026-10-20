import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "seo-webmaster-demo", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", new URL("./offline-network.mjs", import.meta.url).href,
    fileURLToPath(new URL("../dist/cli.js", import.meta.url))],
});

try {
  await client.connect(transport);
  for (const file of ["before.html", "after.html"]) {
    const response = await client.callTool({ name: "seo_audit_advanced", arguments: {
      baseUrl: `https://audit.example/${file}`, maxPages: 1,
    } });
    if (response.isError) throw new Error(response.content[0].text);
    const report = JSON.parse(response.content[0].text);
    if (report.status !== "complete") throw new Error(JSON.stringify(report.errors));
    console.log(JSON.stringify({ fixture: file, status: report.status, summary: report.summary,
      page: report.crawl.pages[0], actions: report.actions }, null, 2));
  }
} finally {
  await client.close();
}
