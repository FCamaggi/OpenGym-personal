/* DATA_DIR mirrored in MongoDB (mirror.js): restored at boot, changes uploaded, deletions followed,
   and a failed upload retried rather than forgotten. A fake collection stands in for Atlas. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMirror, MIRRORED } from '../mirror.js';
import { atomicWrite } from '../durable.js';

function fakeCol(init = {}) {
  const docs = new Map(Object.entries(init).map(([k, text]) => [k, { _id: k, text }]));
  const col = {
    docs, fail: false,
    find: () => ({ toArray: async () => [...docs.values()] }),
    bulkWrite: async ops => {
      if (col.fail) throw new Error('network');
      for (const o of ops) {
        if (o.replaceOne) docs.set(o.replaceOne.filter._id, o.replaceOne.replacement);
        if (o.deleteOne) docs.delete(o.deleteOne.filter._id);
      }
    },
  };
  return col;
}
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const quiet = { log() {}, error() {} };

test('only the files the API keeps are mirrored', () => {
  for (const f of ['secret', 'db.json', 'vapid.json', 'coach.json', 'audit.log', 'state-ab_1.json', 'coach-auth-u1.json']) assert.ok(MIRRORED.test(f), f);
  for (const f of ['db.json.bak', 'db.json.tmp', 'state-x.json.tmp', '.health-1', 'uploads', 'db.json.unreadable-1']) assert.ok(!MIRRORED.test(f), f);
});

test('restore writes the stored files; a file only on disk is uploaded', async t => {
  const dir = tmp(t);
  const col = fakeCol({ secret: 's3cret', 'state-u1.json': '{"_rev":3}' });
  fs.writeFileSync(path.join(dir, 'vapid.json'), '{"k":1}');
  const m = createMirror({ dir, col, log: quiet });
  await m.restore();
  assert.equal(fs.readFileSync(path.join(dir, 'state-u1.json'), 'utf8'), '{"_rev":3}');
  assert.equal(fs.statSync(path.join(dir, 'secret')).mode & 0o777, 0o600);
  await m.sync();
  assert.equal(col.docs.get('vapid.json').text, '{"k":1}');
  assert.equal(col.docs.get('secret').text, 's3cret');
});

test('an atomic rewrite is uploaded, a delete is followed, an unchanged file is not re-sent', async t => {
  const dir = tmp(t);
  const col = fakeCol();
  const m = createMirror({ dir, col, log: quiet });
  await m.restore();
  const file = path.join(dir, 'state-u1.json');
  atomicWrite(file, '{"_rev":1}', 0o600);
  assert.equal(await m.flush(), true);
  assert.equal(col.docs.get('state-u1.json').text, '{"_rev":1}');
  atomicWrite(file, '{"_rev":2}', 0o600);
  await m.flush();
  assert.equal(col.docs.get('state-u1.json').text, '{"_rev":2}');
  let calls = 0; const bw = col.bulkWrite; col.bulkWrite = async o => { calls++; return bw(o); };
  await m.flush();
  assert.equal(calls, 0);
  fs.unlinkSync(file);
  await m.flush();
  assert.ok(!col.docs.has('state-u1.json'));
});

test('a failed upload is reported and retried on the next pass', async t => {
  const dir = tmp(t);
  const col = fakeCol();
  const m = createMirror({ dir, col, log: quiet });
  await m.restore();
  fs.writeFileSync(path.join(dir, 'db.json'), '{"users":[]}');
  col.fail = true;
  assert.equal(await m.flush(), false);
  assert.ok(!col.docs.has('db.json'));
  col.fail = false;
  assert.equal(await m.flush(), true);
  assert.equal(col.docs.get('db.json').text, '{"users":[]}');
});
