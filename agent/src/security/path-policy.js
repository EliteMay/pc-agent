import {
  existsSync,
  realpathSync,
  statSync
} from "node:fs";
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

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_SEGMENT_CHARS = /[<>:"|?*\x00-\x1F]/;

export class PathPolicyError extends Error {
  constructor(message, code = "PATH_POLICY_ERROR", options = undefined) {
    super(message, options);
    this.name = "PathPolicyError";
    this.code = code;
  }
}

function trimTrailingSeparatorsUnlessRoot(value) {
  const root = path.win32.parse(value).root;

  if (value.toLocaleLowerCase("en-US") === root.toLocaleLowerCase("en-US")) {
    return root;
  }

  return value.replace(/[\\/]+$/, "");
}

function normalizeWindowsPath(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PathPolicyError(
      "Path must be a non-empty string.",
      "INVALID_PATH"
    );
  }

  const normalized = path.win32.normalize(value.trim());

  if (!path.win32.isAbsolute(normalized)) {
    throw new PathPolicyError(
      "Path must be absolute.",
      "PATH_NOT_ABSOLUTE"
    );
  }

  return trimTrailingSeparatorsUnlessRoot(normalized);
}

function comparisonKey(value) {
  return trimTrailingSeparatorsUnlessRoot(
    path.win32.normalize(value)
  ).toLocaleLowerCase("en-US");
}

function isInsideRoot(candidate, root) {
  const candidateKey = comparisonKey(candidate);
  const rootKey = comparisonKey(root);

  if (candidateKey === rootKey) {
    return true;
  }

  const rootWithSeparator = rootKey.endsWith("\\")
    ? rootKey
    : rootKey + "\\";

  return candidateKey.startsWith(rootWithSeparator);
}

function assertAllowedRoots(allowedRoots) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new PathPolicyError(
      "No allowed roots are configured.",
      "NO_ALLOWED_ROOTS"
    );
  }
}

function canonicalizeExistingPath(value, {
  notFoundCode = "PATH_NOT_FOUND",
  notFoundLabel = "Path"
} = {}) {
  const normalized = normalizeWindowsPath(value);

  try {
    return trimTrailingSeparatorsUnlessRoot(
      path.win32.normalize(realpathSync.native(normalized))
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new PathPolicyError(
        notFoundLabel + " does not exist: " + normalized,
        notFoundCode,
        { cause: error }
      );
    }

    throw new PathPolicyError(
      "Unable to canonicalize path: " + normalized,
      "PATH_CANONICALIZATION_FAILED",
      { cause: error }
    );
  }
}

function canonicalizeAllowedRoots(allowedRoots) {
  assertAllowedRoots(allowedRoots);

  const seen = new Set();
  const canonicalRoots = [];

  for (const configuredRoot of allowedRoots) {
    const canonicalRoot = canonicalizeExistingPath(configuredRoot, {
      notFoundCode: "ALLOWED_ROOT_NOT_FOUND",
      notFoundLabel: "Allowed root"
    });

    let stats;
    try {
      stats = statSync(canonicalRoot);
    } catch (error) {
      throw new PathPolicyError(
        "Unable to inspect allowed root: " + canonicalRoot,
        "ALLOWED_ROOT_STAT_FAILED",
        { cause: error }
      );
    }

    if (!stats.isDirectory()) {
      throw new PathPolicyError(
        "Allowed root must be a directory: " + canonicalRoot,
        "ALLOWED_ROOT_NOT_DIRECTORY"
      );
    }

    const key = comparisonKey(canonicalRoot);
    if (!seen.has(key)) {
      seen.add(key);
      canonicalRoots.push(canonicalRoot);
    }
  }

  return canonicalRoots;
}

function assertCanonicalWithinRoots(candidate, canonicalRoots) {
  if (!canonicalRoots.some((root) => isInsideRoot(candidate, root))) {
    throw new PathPolicyError(
      "Path is outside allowed roots: " + candidate,
      "PATH_OUTSIDE_ALLOWED_ROOTS"
    );
  }

  return candidate;
}

function validateNewPathSegment(segment) {
  if (
    typeof segment !== "string"
    || segment.length === 0
    || segment === "."
    || segment === ".."
  ) {
    throw new PathPolicyError(
      "New path contains an invalid segment.",
      "INVALID_NEW_PATH_SEGMENT"
    );
  }

  if (WINDOWS_INVALID_SEGMENT_CHARS.test(segment)) {
    throw new PathPolicyError(
      "New path contains a Windows-invalid or alternate-stream segment: " + segment,
      "INVALID_NEW_PATH_SEGMENT"
    );
  }

  if (/[. ]$/.test(segment)) {
    throw new PathPolicyError(
      "New path segment must not end in a dot or space: " + segment,
      "INVALID_NEW_PATH_SEGMENT"
    );
  }

  if (WINDOWS_RESERVED_NAME.test(segment)) {
    throw new PathPolicyError(
      "New path uses a reserved Windows device name: " + segment,
      "RESERVED_WINDOWS_NAME"
    );
  }

  return segment;
}

function findNearestExistingAncestor(candidatePath) {
  let current = normalizeWindowsPath(candidatePath);
  const missingSegments = [];

  while (!existsSync(current)) {
    const root = path.win32.parse(current).root;

    if (comparisonKey(current) === comparisonKey(root)) {
      throw new PathPolicyError(
        "No existing parent could be resolved for: " + candidatePath,
        "NO_EXISTING_PARENT"
      );
    }

    const segment = path.win32.basename(current);
    validateNewPathSegment(segment);
    missingSegments.unshift(segment);

    const parent = path.win32.dirname(current);
    if (comparisonKey(parent) === comparisonKey(current)) {
      throw new PathPolicyError(
        "No existing parent could be resolved for: " + candidatePath,
        "NO_EXISTING_PARENT"
      );
    }

    current = parent;
  }

  let stats;
  try {
    stats = statSync(current);
  } catch (error) {
    throw new PathPolicyError(
      "Unable to inspect nearest existing parent: " + current,
      "PARENT_STAT_FAILED",
      { cause: error }
    );
  }

  if (!stats.isDirectory() && missingSegments.length > 0) {
    throw new PathPolicyError(
      "Nearest existing parent is not a directory: " + current,
      "PARENT_NOT_DIRECTORY"
    );
  }

  return {
    existingAncestor: current,
    missingSegments
  };
}

export function assertPathWithinAllowedRoots(candidatePath, allowedRoots) {
  assertAllowedRoots(allowedRoots);

  const candidate = normalizeWindowsPath(candidatePath);
  const roots = allowedRoots.map(normalizeWindowsPath);

  if (!roots.some((root) => isInsideRoot(candidate, root))) {
    throw new PathPolicyError(
      "Path is outside allowed roots: " + candidate,
      "PATH_OUTSIDE_ALLOWED_ROOTS"
    );
  }

  return candidate;
}

export function resolveExistingPathWithinAllowedRoots(
  candidatePath,
  allowedRoots
) {
  const canonicalRoots = canonicalizeAllowedRoots(allowedRoots);
  const candidate = canonicalizeExistingPath(candidatePath);

  return assertCanonicalWithinRoots(candidate, canonicalRoots);
}

export function resolveNewPathWithinAllowedRoots(
  candidatePath,
  allowedRoots
) {
  const normalizedCandidate = normalizeWindowsPath(candidatePath);

  if (existsSync(normalizedCandidate)) {
    return resolveExistingPathWithinAllowedRoots(
      normalizedCandidate,
      allowedRoots
    );
  }

  const canonicalRoots = canonicalizeAllowedRoots(allowedRoots);
  const {
    existingAncestor,
    missingSegments
  } = findNearestExistingAncestor(normalizedCandidate);

  const canonicalAncestor = canonicalizeExistingPath(existingAncestor);
  assertCanonicalWithinRoots(canonicalAncestor, canonicalRoots);

  const canonicalTarget = trimTrailingSeparatorsUnlessRoot(
    missingSegments.reduce(
      (current, segment) => path.win32.join(current, segment),
      canonicalAncestor
    )
  );

  return assertCanonicalWithinRoots(canonicalTarget, canonicalRoots);
}

export function revalidateNewPathBeforeWrite(
  candidatePath,
  allowedRoots,
  expectedCanonicalPath
) {
  const expected = normalizeWindowsPath(expectedCanonicalPath);
  const current = resolveNewPathWithinAllowedRoots(
    candidatePath,
    allowedRoots
  );

  if (comparisonKey(current) !== comparisonKey(expected)) {
    throw new PathPolicyError(
      "Path target changed between validation and write.",
      "PATH_CHANGED_DURING_OPERATION"
    );
  }

  return current;
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
  isInsideRoot,
  canonicalizeExistingPath,
  canonicalizeAllowedRoots,
  validateNewPathSegment,
  findNearestExistingAncestor,
  comparisonKey
});
