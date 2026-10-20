import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("CLI anuncia su versión, explica su uso y rechaza comandos desconocidos", () => {
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 15_000 });
  assert.match(run("--version").stdout, /^0\.4\.0\r?\n$/);
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /doctor/);
  const unknown = run("statuz");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Comando desconocido.*--help/);
  const config = run("config", "claude");
  assert.equal(config.status, 0);
  assert.deepEqual(JSON.parse(config.stdout).mcpServers["seo-webmaster"].args, ["-y", "seo-webmaster-mcp"]);
});

test("doctor distingue falta de configuración, acceso válido y fallo del proveedor con su código de salida", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "seo-cli-"));
  const credentials = join(process.platform === "darwin" ? join(temporary, "Library", "Application Support") : temporary,
    "seo-webmaster-mcp", "credentials.json");
  const run = (mock = "") => spawnSync(process.execPath, [
    ...(mock ? ["--import", `data:text/javascript,${encodeURIComponent(mock)}`] : []), cli, "doctor",
  ], { encoding: "utf8", timeout: 15_000,
    env: { ...process.env, APPDATA: temporary, XDG_CONFIG_HOME: temporary, HOME: temporary } });
  try {
    const empty = run();
    assert.equal(empty.status, 0);
    assert.equal(JSON.parse(empty.stdout).bing.status, "not_configured");
    await mkdir(dirname(credentials), { recursive: true });
    await writeFile(credentials, JSON.stringify({ bingApiKey: "do-not-expose-test-key" }));
    const ok = run('globalThis.fetch = async () => new Response(JSON.stringify({d:[]}));');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).bing.status, "ok");
    const failed = run('globalThis.fetch = async () => new Response(null, {status:401});');
    assert.equal(failed.status, 1);
    assert.equal(JSON.parse(failed.stdout).bing.status, "error");
    assert.match(JSON.parse(failed.stdout).bing.message, /401/);
    assert(!failed.stdout.includes("do-not-expose-test-key"));
    assert.equal(JSON.parse(await readFile(credentials, "utf8")).bingApiKey, "do-not-expose-test-key");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
