import fs from "node:fs";
import path from "node:path";

/**
 * Minimal environment loader so local development can rely on a .env file
 * without pulling an extra dependency.
 */
export function loadEnvFromFile(envPath = ".env") {
  const resolvedPath = path.resolve(process.cwd(), envPath);
  if (!fs.existsSync(resolvedPath)) {
    return;
  }

  const fileContent = fs.readFileSync(resolvedPath, "utf8");
  for (const rawLine of fileContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
