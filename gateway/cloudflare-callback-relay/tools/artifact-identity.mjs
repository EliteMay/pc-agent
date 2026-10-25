// Offline only. No Cloudflare API calls, no token handling, no deploy.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_JS_SIZE = 4 * 1024 * 1024;
const MAX_PARTS = 8;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function readPart(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_JS_SIZE)
    throw new Error('invalid_artifact');
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) throw new Error('invalid_artifact');
  return bytes;
}

function enumerate(dir) {
  if (!lstatSync(dir).isDirectory()) throw new Error('invalid_directory');
  const found = [];
  const visit = (path, depth) => {
    if (depth > 3) throw new Error('invalid_directory');
    for (const item of readdirSync(path, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('symlink_not_allowed');
      const p = join(path, item.name);
      if (item.isDirectory()) visit(p, depth + 1);
      else if (!item.isFile()) throw new Error('unsupported_entry');
      else if (['.js', '.mjs'].includes(extname(item.name))) found.push(p);
    }
  };
  visit(dir, 0);
  if (found.length < 1 || found.length > MAX_PARTS) throw new Error('unsupported_js_part_count');
  return found.sort();
}

export function fingerprintDirectory(dir) {
  const parts = enumerate(resolve(dir));
  const hashes = parts.map(path => digest(readPart(path)));
  return {
    artifact_type: 'wrangler_dry_run_output',
    js_parts: hashes.length,
    // One-part digest is directly comparable with a single Cloudflare JS part.
    single_part_sha256: hashes.length === 1 ? hashes[0] : null,
    source_commit_verified: false,
    active_deployment_verified: false,
    live_oauth_allowed: false,
  };
}

export function compareFiles(expected, observed) {
  const left = resolve(expected), right = resolve(observed);
  if (left === right || realpathSync(left) === realpathSync(right)) throw new Error('independent_files_required');
  const leftHash = digest(readPart(left)), rightHash = digest(readPart(right));
  return {
    bytes_match: leftHash === rightHash,
    // Identical local bytes alone do not authenticate Cloudflare or pin an active version.
    comparison: 'local_files_only',
    active_deployment_verified: false,
    platform_log_scope: 'unverified',
    live_oauth_allowed: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    let result;
    if (mode === 'fingerprint-dir' && args.length === 1) result = fingerprintDirectory(args[0]);
    else if (mode === 'compare-files' && args.length === 2) result = compareFiles(args[0], args[1]);
    else throw new Error('usage');
    process.stdout.write(JSON.stringify(result) + '\n');
    if (mode === 'compare-files' && result.bytes_match !== true) process.exitCode = 1;
  } catch {
    // Never echo raw errors/paths: CLI may receive private local filenames.
    process.stdout.write(JSON.stringify({ artifact_identity: 'unverified', live_oauth_allowed: false }) + '\n');
    process.exitCode = 1;
  }
}
