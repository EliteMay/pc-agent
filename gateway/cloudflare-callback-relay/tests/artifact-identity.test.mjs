import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fingerprintDirectory, compareFiles } from '../tools/artifact-identity.mjs';

const cli = new URL('../tools/artifact-identity.mjs', import.meta.url);
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'relay-artifact-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function run(...args) { const p = spawnSync(process.execPath, [fileURLToPath(cli), ...args], { encoding:'utf8' }); return { status: p.status, data: JSON.parse(p.stdout.trim()) }; }

test('dry-run fingerprint is stable, limited to JS bytes, and never claims active version proof', t => {
  const dir=fixture(t), code=join(dir,'index.js'); writeFileSync(code,'export default {}\n'); writeFileSync(join(dir,'index.js.map'),'private-not-js');
  const a=fingerprintDirectory(dir), b=fingerprintDirectory(dir);
  assert.deepEqual(a,b); assert.equal(a.js_parts,1); assert.match(a.single_part_sha256,/^[a-f0-9]{64}$/);
  assert.equal(a.active_deployment_verified,false); assert.equal(a.live_oauth_allowed,false);
  assert.equal(run('fingerprint-dir',dir).status,0);
});

test('matching independent files do not imply authenticated deployed version', t => {
  const dir=fixture(t), a=join(dir,'build.js'), b=join(dir,'cloudflare.js');
  writeFileSync(a,'a'.repeat(128)); writeFileSync(b,'a'.repeat(128));
  const result=compareFiles(a,b); assert.equal(result.bytes_match,true);
  assert.equal(result.active_deployment_verified,false);
  assert.equal(run('compare-files',a,b).status,0);
  writeFileSync(b,'b'.repeat(128)); assert.equal(compareFiles(a,b).bytes_match,false);
  assert.equal(run('compare-files',a,b).status,1);
});

test('rejects same file, empty files, oversized files and symbolic links', t => {
  const dir=fixture(t), a=join(dir,'a.js'), b=join(dir,'b.js'), link=join(dir,'link.js');
  writeFileSync(a,'text'); writeFileSync(b,''); symlinkSync(a,link);
  assert.throws(()=>compareFiles(a,a),/independent_files_required/);
  assert.throws(()=>compareFiles(a,b),/invalid_artifact/);
  assert.throws(()=>fingerprintDirectory(dir),/symlink_not_allowed/);
  assert.equal(run('compare-files',a,b).data.artifact_identity,'unverified');
  assert.equal(run('compare-files',a,b).data.live_oauth_allowed,false);
});

test('one directory with multiple JS parts cannot produce a misleading single-part digest', t => {
  const dir=fixture(t); mkdirSync(join(dir,'nested')); writeFileSync(join(dir,'a.js'),'a'); writeFileSync(join(dir,'nested','b.mjs'),'b');
  const result=fingerprintDirectory(dir); assert.equal(result.js_parts,2); assert.equal(result.single_part_sha256,null);
  assert.equal(result.live_oauth_allowed,false);
});
