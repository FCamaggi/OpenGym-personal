// Keeps DATA_DIR mirrored in MongoDB (Atlas), for hosts whose disk does not survive a restart.
//
// The API still reads and writes plain files, synchronously, exactly as before: that is what its
// concurrency and durability reasoning rests on (server.js, durable.js). MongoDB is the durable
// copy behind them. At boot the files are restored from it, before server.js reads anything; from
// then on every change to a mirrored file is noticed by comparing (mtime, size, inode) — an
// atomic rename always changes the inode — and uploaded. Nothing in the write paths had to change,
// and the coach's own writers are covered too.
//
// Mongo is authoritative at boot. If it is configured and cannot be reached, the process exits:
// starting empty would mint a new session secret and upload it over the real one.
//
// Not mirrored: uploads/ (photos and videos of custom exercises), the coach job queue.
import fs from 'node:fs';
import path from 'node:path';

// Top-level files only; the same set the API keeps there that is worth keeping.
export const MIRRORED = /^(secret|db\.json|vapid\.json|coach\.json|audit\.log|state-[A-Za-z0-9_-]+\.json|coach-auth-[A-Za-z0-9_-]+\.json)$/;

const sigOf = st => `${st.mtimeMs}:${st.size}:${st.ino}`;

/** `col` is a MongoDB collection (find / bulkWrite); injectable so tests need no server. */
export function createMirror({ dir, col, log = console, intervalMs = 15000 }) {
  const synced = new Map();            // name -> signature last known to be in Mongo
  let timer = null;

  function list() {
    const cur = new Map();
    let names;
    try { names = fs.readdirSync(dir); } catch { return cur; }
    for (const name of names) {
      if (!MIRRORED.test(name)) continue;
      try { const st = fs.statSync(path.join(dir, name)); if (st.isFile()) cur.set(name, sigOf(st)); } catch { /* gone again */ }
    }
    return cur;
  }

  async function restore() {
    const docs = await col.find({}).toArray();
    for (const d of docs) {
      if (!MIRRORED.test(d._id) || typeof d.text !== 'string') continue;
      const file = path.join(dir, d._id);
      fs.writeFileSync(file, d.text, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      synced.set(d._id, sigOf(fs.statSync(file)));
    }
    log.log(`mirror: restored ${synced.size} file(s) from MongoDB`);
  }

  // One scan-and-upload. Files already restored are known, so only what is new or changed goes up.
  async function pass() {
    const cur = list();
    const ops = [], ups = [], dels = [];
    for (const [name, sig] of cur) {
      if (synced.get(name) === sig) continue;
      let text;
      try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
      ops.push({ replaceOne: { filter: { _id: name }, replacement: { _id: name, text, ts: Date.now() }, upsert: true } });
      ups.push([name, sig]);
    }
    for (const name of synced.keys()) {
      if (cur.has(name)) continue;
      ops.push({ deleteOne: { filter: { _id: name } } });
      dels.push(name);
    }
    if (!ops.length) return true;
    await col.bulkWrite(ops, { ordered: false });
    for (const [name, sig] of ups) synced.set(name, sig);
    for (const name of dels) synced.delete(name);
    return true;
  }

  let chain = Promise.resolve(true);
  function sync() {
    chain = chain.then(pass).catch(e => { log.error('mirror: upload failed, will retry:', e.message); return false; });
    return chain;
  }

  /** Resolves true once everything on disk is in Mongo, false if that did not happen in time. */
  function flush(timeoutMs = 8000) {
    let t;
    const late = new Promise(r => { t = setTimeout(() => r(false), timeoutMs); });
    return Promise.race([sync(), late]).finally(() => clearTimeout(t));
  }

  function start() {
    if (timer) return;
    timer = setInterval(sync, intervalMs);
    timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { restore, sync, flush, start, stop, _synced: synced };
}

/** The real thing: connects with the driver (loaded only now, so it stays out of every other
 *  deployment) and restores. Throws if Mongo cannot be reached. */
export async function startMirror({ dir, uri, dbName = 'opengym', collection = 'files', log = console }) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, appName: 'opengym-api' });
  await client.connect();
  const col = client.db(dbName).collection(collection);
  const m = createMirror({ dir, col, log });
  await m.restore();
  await m.sync();                       // files that only exist locally (a first migration)
  m.start();
  m.close = () => client.close();
  return m;
}
