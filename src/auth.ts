import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import open from "open";
import { bingRequest } from "./bing.js";
import { loadCredentials, saveCredentials } from "./config.js";
import { object, requiredString, resultArray } from "./utils.js";

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export async function connectBing(apiKey: string): Promise<number> {
  const key = apiKey.trim();
  if (!key) throw new Error("La clave de Bing está vacía.");
  const sites = resultArray(await bingRequest("GetUserSites", {}, key), "Bing");
  const credentials = await loadCredentials();
  credentials.bingApiKey = key;
  await saveCredentials(credentials);
  return sites.filter((site) => site.IsVerified === true).length;
}

export async function connectGoogle(clientJsonPath: string): Promise<void> {
  const raw = await readFile(resolve(clientJsonPath), "utf8");
  const file = object(JSON.parse(raw), "JSON de Google OAuth");
  const installed = object(file.installed, "cliente OAuth de escritorio");
  const clientId = requiredString(installed, "client_id");
  const clientSecret = requiredString(installed, "client_secret");

  const state = randomBytes(24).toString("base64url");
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("No se pudo iniciar el callback local de Google OAuth.");
  }
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  const oauth = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
  const authorizationUrl = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [GOOGLE_SCOPE],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });

  let timer: NodeJS.Timeout | undefined;
  const codePromise = new Promise<string>((resolveCode, rejectCode) => {
    timer = setTimeout(() => rejectCode(new Error("Tiempo agotado para autorizar Google.")), 300_000);
    server.on("request", (request, response) => {
      const callbackUrl = new URL(request.url || "/", redirectUri);
      if (callbackUrl.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      if (callbackUrl.searchParams.get("state") !== state) {
        response.writeHead(400).end("Estado OAuth inválido.");
        rejectCode(new Error("Estado OAuth inválido."));
        return;
      }
      const error = callbackUrl.searchParams.get("error");
      if (error) {
        response.writeHead(400).end("Autorización rechazada. Puedes cerrar esta ventana.");
        rejectCode(new Error(`Google rechazó la autorización: ${error}`));
        return;
      }
      const code = callbackUrl.searchParams.get("code");
      if (!code) {
        response.writeHead(400).end("Falta el código de autorización.");
        rejectCode(new Error("Google no devolvió un código de autorización."));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<p>Google Search Console conectado. Puedes cerrar esta ventana.</p>");
      resolveCode(code);
    });
  });

  try {
    console.log("Abriendo el navegador para autorizar Google Search Console...");
    try {
      await open(authorizationUrl);
    } catch {
      console.log(`Abre esta URL en tu navegador: ${authorizationUrl}`);
    }
    const code = await codePromise;
    const { tokens } = await oauth.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) throw new Error("Google no devolvió un refresh token. Reintenta la conexión.");
    const credentials = await loadCredentials();
    credentials.google = { clientId, clientSecret, refreshToken: tokens.refresh_token };
    await saveCredentials(credentials);
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
  }
}
