import path from "node:path";

const SENSITIVE_FILE_NAMES = new Set([
  ".env",
  "credentials.json",
  "token.json",
  "id_rsa",
  "id_ed25519"
]);

const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".ssh"
]);

function normalizeWindowsPath(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Path must be a non-empty string.");
  }

  const normalized = path.win32.normalize(value.trim());

  if (!path.win32.isAbsolute(normalized)) {
    throw new Error("Path must be absolute.");
  }

  return normalized.replace(/[\\/]+$/, "");
}

function isInsideRoot(candidate, root) {
  const candidateKey = candidate.toLocaleLowerCase("en-US");
  const rootKey = root.toLocaleLowerCase("en-US");

  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}\\`);
}

export function assertPathWithinAllowedRoots(candidatePath, allowedRoots) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new Error("No allowed roots are configured.");
  }

  const candidate = normalizeWindowsPath(candidatePath);
  const roots = allowedRoots.map(normalizeWindowsPath);

  if (!roots.some((root) => isInsideRoot(candidate, root))) {
    throw new Error(`Path is outside allowed roots: ${candidate}`);
  }

  return candidate;
}

export function isSensitivePath(candidatePath) {
  const normalized = normalizeWindowsPath(candidatePath);
  const parts = normalized
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((part) => part.toLocaleLowerCase("en-US"));

  if (parts.some((part) => SENSITIVE_DIRECTORY_NAMES.has(part))) {
    return true;
  }

  const baseName = parts.at(-1) ?? "";

  if (SENSITIVE_FILE_NAMES.has(baseName)) {
    return true;
  }

  if (baseName.startsWith(".env.")) {
    return true;
  }

  return baseName.endsWith(".pem") || baseName.endsWith(".key");
}

export const pathPolicyInternals = Object.freeze({
  normalizeWindowsPath,
  isInsideRoot
});
