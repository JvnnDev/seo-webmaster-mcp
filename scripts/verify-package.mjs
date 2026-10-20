// Run via npm run verify:package. Test the actual tarball in an isolated install.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execute = promisify(execFile);
const npmCli = process.env.npm_execpath;
assert(npmCli, "Ejecuta esta comprobación con npm run verify:package.");
const project = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "seo-webmaster-package-"));
const npm = (args, cwd = project) => execute(process.execPath, [npmCli, ...args], {
  cwd, timeout: 180_000, maxBuffer: 2_000_000,
});

try {
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  const registry = JSON.parse(await readFile(join(project, "server.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(project, "package-lock.json"), "utf8"));
  assert([registry.version, registry.packages[0].version, lock.version, lock.packages[""].version]
    .every((version) => version === manifest.version), "Las versiones deben estar alineadas");
  const packed = await npm(["pack", "--json", "--pack-destination", temporary]);
  const [artifact] = JSON.parse(packed.stdout);
  const files = artifact.files.map((file) => file.path);
  assert(files.every((file) => /^(?:dist\/[\w-]+\.js|README\.md|CHANGELOG\.md|LICENSE|package\.json)$/.test(file)),
    "El paquete contiene un archivo fuera de la lista permitida");
  assert(files.includes("dist/cli.js"));
  const installRoot = join(temporary, "install");
  await npm(["install", "--prefix", installRoot, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
    join(temporary, artifact.filename)]);
  const cli = join(installRoot, "node_modules", manifest.name, "dist", "cli.js");
  assert.equal((await execute(process.execPath, [cli, "--version"])).stdout.trim(), manifest.version);
  assert.equal((await npm(["exec", "--offline", "--", manifest.name, "--version"], installRoot)).stdout.trim(), manifest.version);
  const configRoot = join(temporary, "config");
  const credentials = join(process.platform === "darwin" ? join(configRoot, "Library", "Application Support") : configRoot,
    manifest.name, "credentials.json");
  await mkdir(dirname(credentials), { recursive: true });
  await writeFile(credentials, "invalid credentials JSON: a URL-only audit must not read this");
  const client = new Client({ name: "package-verifier", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", new URL("../examples/offline-network.mjs", import.meta.url).href, cli],
    env: { ...process.env, APPDATA: configRoot, XDG_CONFIG_HOME: configRoot, HOME: configRoot } });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, manifest.version);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 25);
    assert(tools.every((tool) => tool.annotations?.readOnlyHint === true));
    for (const [file, expected] of [["before.html", 4], ["after.html", 0]]) {
      const response = await client.callTool({ name: "seo_audit_advanced", arguments: {
        baseUrl: `https://audit.example/${file}`, maxPages: 1,
      } });
      assert(!response.isError, response.content[0].text);
      const report = JSON.parse(response.content[0].text);
      assert.equal(report.status, "complete");
      assert.equal(report.actions.length, expected);
      assert.equal(report.crawl.pages[0].status, 200);
      assert.equal(report.official, null);
    }
  } finally { await client.close(); }
  console.log(JSON.stringify({ version: manifest.version, packageFiles: files.length,
    freshInstall: "ok", mcpTools: 25, auditBefore: 4, auditAfter: 0, credentialsRead: false }, null, 2));
} finally {
  const withinTemp = relative(resolve(tmpdir()), resolve(temporary));
  assert(withinTemp && !withinTemp.startsWith("..") && basename(temporary).startsWith("seo-webmaster-package-"),
    "La limpieza debe permanecer dentro de la carpeta temporal creada por esta prueba");
  await rm(temporary, { recursive: true, force: true });
}
