import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Credentials = {
  bingApiKey?: string;
  google?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
};

export function credentialsPath(): string {
  const base = process.platform === "win32"
    ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "seo-webmaster-mcp", "credentials.json");
}

export async function loadCredentials(): Promise<Credentials> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("El archivo local de credenciales es inválido.");
  }
  return value as Credentials;
}

export async function saveCredentials(value: Credentials): Promise<void> {
  const path = credentialsPath();
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.credentials-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
}
