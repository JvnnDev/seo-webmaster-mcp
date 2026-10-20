import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { browserExecutable } from "../dist/render.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const mock = `
import ${JSON.stringify(new URL("../examples/offline-network.mjs", import.meta.url).href)};
const original = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.hostname === 'www.googleapis.com') return Response.json({lighthouseResult:{categories:{performance:{score:0.81}},audits:{'largest-contentful-paint':{numericValue:2100}}}});
  if (url.pathname !== '/workflow.html') return original(input, options);
  if (process.env.TEST_AUDIT_SCENARIO === 'offline') throw new Error('offline fixture');
  const after = process.env.TEST_AUDIT_SCENARIO === 'after' || (process.env.TEST_AUDIT_SCENARIO === 'sequence' && calls++ > 0);
  const response = await original('https://audit.example/' + (after ? 'after.html' : 'before.html'));
  const body = (await response.text()).replace('href="./after.html"', 'href="https://audit.example/workflow.html"');
  return new Response(body, {headers: {'content-type': 'text/html'}});
};
`;
const env = (temporary, scenario) => ({...process.env, APPDATA: temporary, XDG_CONFIG_HOME: temporary, HOME: temporary,
  TEST_AUDIT_SCENARIO: scenario});
const run = (temporary, scenario, ...args) => spawnSync(process.execPath,
  ["--import", `data:text/javascript,${encodeURIComponent(mock)}`, cli, ...args], {
    encoding: "utf8", timeout: 20000, env: env(temporary, scenario), maxBuffer: 2000000,
  });
const audit = (temporary, scenario, ...extra) => run(temporary, scenario, "audit", "https://audit.example/workflow.html", "--max-pages", "1", ...extra);

test("CLI completa auditar, guardar, listar, exportar y comparar en procesos separados", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "seo-workflow-cli-"));
  try {
    const unsaved = audit(temporary, "before");
    assert.equal(unsaved.status, 0, unsaved.stderr);
    assert.equal(JSON.parse(run(temporary, "before", "history").stdout).reports.length, 0);
    const before = audit(temporary, "before", "--save");
    assert.equal(before.status, 0, before.stderr);
    const beforeValue = JSON.parse(before.stdout);
    assert.equal(beforeValue.actions.length, 4);
    const after = audit(temporary, "after", "--save");
    assert.equal(after.status, 0, after.stderr);
    const afterValue = JSON.parse(after.stdout);
    assert.equal(afterValue.actions.length, 0);
    assert.equal(JSON.parse(run(temporary, "after", "history").stdout).reports.length, 2);
    const diff = run(temporary, "after", "compare", beforeValue.saved.id, afterValue.saved.id);
    assert.equal(diff.status, 0, diff.stderr);
    assert.equal(JSON.parse(diff.stdout).summary.resolved, 4);
    assert.equal(JSON.parse(diff.stdout).summary.new, 0);
    const markdownFile = join(temporary, "report.md");
    const exported = run(temporary, "after", "report", beforeValue.saved.id, "--format", "markdown", "--out", markdownFile);
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(exported.stdout, "");
    assert.match(await readFile(markdownFile, "utf8"), /Evidencia:/);
    const jsonFile = join(temporary, "after.json");
    assert.equal(run(temporary, "after", "report", afterValue.saved.id, "--out", jsonFile).status, 0);
    const fromFiles = run(temporary, "after", "compare", beforeValue.saved.id, jsonFile, "--format", "markdown");
    assert.equal(fromFiles.status, 0, fromFiles.stderr);
    assert.match(fromFiles.stdout, /Resueltos: 4/);
  } finally { await rm(temporary, {recursive: true, force: true}); }
});

test("CLI devuelve códigos para regresión y cobertura incompleta sin informar correcciones falsas", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "seo-workflow-policy-"));
  try {
    const clean = JSON.parse(audit(temporary, "after", "--save").stdout);
    const broken = JSON.parse(audit(temporary, "before", "--save").stdout);
    const regression = run(temporary, "after", "compare", clean.saved.id, broken.saved.id, "--fail-on-regression");
    assert.equal(regression.status, 3, regression.stderr);
    assert.equal(JSON.parse(regression.stdout).summary.new, 4);
    const offline = audit(temporary, "offline", "--save");
    assert.equal(offline.status, 2, offline.stderr);
    const diff = run(temporary, "after", "compare", broken.saved.id, JSON.parse(offline.stdout).saved.id);
    assert.equal(diff.status, 2, diff.stderr);
    assert.equal(JSON.parse(diff.stdout).summary.resolved, 0);
    assert.equal(JSON.parse(diff.stdout).summary.notComparable, 4);
    const invalid = audit(temporary, "after", "--format", "html", "--save");
    assert.equal(invalid.status, 1);
    const history = JSON.parse(run(temporary, "after", "history").stdout);
    assert.equal(history.reports.length, 3, "Una opción inválida no debe crear una auditoría");
  } finally { await rm(temporary, {recursive: true, force: true}); }
});

test("MCP guarda por petición explícita y recupera/compara tras reiniciar el servidor", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "seo-workflow-mcp-"));
  const connect = async scenario => {
    const client = new Client({name: "workflow-test", version: "1.0.0"});
    await client.connect(new StdioClientTransport({command: process.execPath,
      args: ["--import", `data:text/javascript,${encodeURIComponent(mock)}`, cli], env: env(temporary, scenario)}));
    return client;
  };
  const call = async (client, name, args = {}) => {
    const value = await client.callTool({name, arguments: args});
    assert(!value.isError, value.content[0].text);
    return JSON.parse(value.content[0].text);
  };
  let client;
  try {
    client = await connect("before");
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find(tool => tool.name === "seo_audit_save").annotations.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === "seo_audit_compare").annotations.readOnlyHint, true);
    assert.equal((await call(client, "seo_audit_history")).reports.length, 0);
    const before = await call(client, "seo_audit_save", {baseUrl: "https://audit.example/workflow.html", maxPages: 1});
    await client.close();
    client = await connect("after");
    const after = await call(client, "seo_audit_save", {baseUrl: "https://audit.example/workflow.html", maxPages: 1});
    assert.equal((await call(client, "seo_audit_history")).reports.length, 2);
    const diff = await call(client, "seo_audit_compare", {baselineId: before.saved.id, currentId: after.saved.id});
    assert.equal(diff.summary.resolved, 4);
    assert.equal(diff.summary.new, 0);
    assert.equal(diff.summary.notComparable, 0);
    const rendered = await call(client, "seo_audit_report", {id: before.saved.id, format: "markdown"});
    assert.match(rendered.markdown, /Evidencia:/);
    const invalid = await client.callTool({name: "seo_audit_report", arguments: {id: "../../credentials.json"}});
    assert.equal(invalid.isError, true);
  } finally { if (client) await client.close(); await rm(temporary, {recursive: true, force: true}); }
});

test("CLI y MCP exponen renderizado y rendimiento opcionales con datos separados", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "seo-optional-workflow-"));
  const client = new Client({name: "optional-test", version: "1.0.0"});
  try {
    const measured = audit(temporary, "after", "--performance");
    assert.equal(measured.status, 0, measured.stderr);
    assert.equal(JSON.parse(measured.stdout).performance.lab.performanceScore, 81);
    await client.connect(new StdioClientTransport({command: process.execPath,
      args: ["--import", `data:text/javascript,${encodeURIComponent(mock)}`, cli], env: env(temporary, "after")}));
    const response = await client.callTool({name: "seo_audit_advanced", arguments: {
      baseUrl: "https://audit.example/workflow.html", maxPages: 1, performance: true,
      ...(await browserExecutable() ? {render: "js"} : {}),
    }});
    assert(!response.isError, response.content[0].text);
    const report = JSON.parse(response.content[0].text);
    assert.equal(report.status, "complete", JSON.stringify(report.errors));
    assert.equal(report.performance.lab.performanceScore, 81);
    assert.equal(report.performance.field.url.available, false);
    if (await browserExecutable()) assert.equal(report.summary.rendering.complete, 1);
  } finally { await client.close(); await rm(temporary, {recursive: true, force: true}); }
});
