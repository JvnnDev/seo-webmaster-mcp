#!/usr/bin/env node
import { input, password, select } from "@inquirer/prompts";
import { connectBing, connectGoogle } from "./auth.js";
import { credentialsPath, loadCredentials, saveCredentials } from "./config.js";
import { importGeoReport } from "./geo.js";
import { bingListSites } from "./bing.js";
import { gscListSites } from "./google.js";

async function setup(provider?: string, clientPath?: string): Promise<void> {
  const choice = provider || await select({
    message: "¿Qué proveedor quieres conectar?",
    choices: [
      { name: "Bing Webmaster Tools", value: "bing" },
      { name: "Google Search Console", value: "google" },
    ],
  });
  if (choice === "bing") {
    const key = await password({ message: "Clave API de Bing:", mask: "*" });
    const verified = await connectBing(key);
    console.log(`Bing conectado. Sitios verificados: ${verified}.`);
  } else if (choice === "google") {
    console.log("Google: habilita Search Console API, configura OAuth y descarga un cliente Desktop app.");
    console.log("Guía: https://developers.google.com/webmaster-tools/v1/how-tos/authorizing");
    const path = clientPath || await input({ message: "Ruta del JSON OAuth de escritorio de Google:" });
    await connectGoogle(path);
    try {
      const sites = await gscListSites();
      console.log(`Google Search Console conectado. Propiedades accesibles: ${sites.sites.length}.`);
    } catch (error) {
      console.log("Google guardó la autorización, pero no pudo consultar propiedades.");
      console.log(error instanceof Error ? error.message : "Error inesperado.");
    }
  } else {
    throw new Error("Proveedor desconocido. Usa bing o google.");
  }
}

async function main(): Promise<void> {
  const [command = "serve", provider, option, optionValue, fifth, sixth] = process.argv.slice(2);
  if (command === "serve") {
    await import("./index.js");
  } else if (command === "setup") {
    if (option && option !== "--client") throw new Error("Opción desconocida.");
    await setup(provider, optionValue);
  } else if (command === "status") {
    const credentials = await loadCredentials();
    console.log(JSON.stringify({
      credentialsFile: credentialsPath(),
      bingConnected: Boolean(credentials.bingApiKey),
      googleConnected: Boolean(credentials.google?.refreshToken),
    }, null, 2));
  } else if (command === "doctor") {
    const credentials = await loadCredentials();
    const checks = await Promise.allSettled([
      credentials.bingApiKey ? bingListSites() : Promise.resolve(null),
      credentials.google ? gscListSites() : Promise.resolve(null),
    ]);
    const format = (index: number, configured: boolean) => !configured ? { status: "not_configured" }
      : checks[index].status === "fulfilled" ? { status: "ok", siteCount: checks[index].value?.sites.length || 0 }
        : { status: "error", message: checks[index].reason instanceof Error ? checks[index].reason.message : "Error inesperado." };
    console.log(JSON.stringify({ bing: format(0, Boolean(credentials.bingApiKey)),
      google: format(1, Boolean(credentials.google)) }, null, 2));
  } else if (command === "disconnect") {
    const credentials = await loadCredentials();
    if (provider === "bing") delete credentials.bingApiKey;
    else if (provider === "google") delete credentials.google;
    else throw new Error("Usa disconnect bing o disconnect google.");
    await saveCredentials(credentials);
    console.log(`${provider} desconectado.`);
  } else if (command === "geo-import") {
    if (!provider || !option || !optionValue || !fifth || !sixth) {
      throw new Error("Uso: seo-webmaster-mcp geo-import archivo.csv siteUrl startDate endDate page|date");
    }
    console.log(JSON.stringify(await importGeoReport({ file: provider, siteUrl: option,
      startDate: optionValue, endDate: fifth, dimension: sixth }), null, 2));
  } else if (command === "config") {
    const client = provider || "codex";
    if (client === "codex") {
      console.log('codex mcp add seo-webmaster -- npx -y seo-webmaster-mcp');
    } else if (client === "claude" || client === "cursor") {
      console.log(JSON.stringify({ mcpServers: { "seo-webmaster": {
        command: "npx", args: ["-y", "seo-webmaster-mcp"],
      } } }, null, 2));
    } else throw new Error("Usa config codex, config claude o config cursor.");
  } else {
    console.log("Uso: seo-webmaster-mcp [serve]");
    console.log("Uso: seo-webmaster-mcp setup [bing|google] [--client ruta.json]");
    console.log("     seo-webmaster-mcp status");
    console.log("     seo-webmaster-mcp disconnect [bing|google]");
    console.log("     seo-webmaster-mcp doctor");
    console.log("     seo-webmaster-mcp config [codex|claude|cursor]");
    console.log("     seo-webmaster-mcp geo-import archivo.csv siteUrl startDate endDate page|date");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Error inesperado.");
  process.exitCode = 1;
});
