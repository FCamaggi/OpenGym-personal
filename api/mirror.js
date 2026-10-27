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
  const tsOf = new Map();              // name -> `ts` of the Mongo document that file came from
  let since = 0;                       // newest `ts` seen; pull() asks only for what is newer
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
      tsOf.set(d._id, d.ts);
      if (d.ts > since) since = d.ts;
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
      const ts = Date.now();
      ops.push({ replaceOne: { filter: { _id: name }, replacement: { _id: name, text, ts }, upsert: true } });
      ups.push([name, sig, ts]);
    }
    for (const name of synced.keys()) {
      if (cur.has(name)) continue;
      ops.push({ deleteOne: { filter: { _id: name } } });
      dels.push(name);
    }
    if (!ops.length) return true;
    await col.bulkWrite(ops, { ordered: false });
    for (const [name, sig, ts] of ups) { synced.set(name, sig); tsOf.set(name, ts); if (ts > since) since = ts; }
    for (const name of dels) { synced.delete(name); tsOf.delete(name); }
    return true;
  }

  // For hosts where no process lives long enough to be the only writer (serverless): brings in what
  // another instance uploaded since. Run before a request is handled, so it reads current files.
  // The 5 s overlap covers clock skew between instances; a document already held is skipped.
  // Deletions made elsewhere are not followed.
  async function pull() {
    const docs = await col.find({ ts: { $gt: since - 5000 } }).toArray();
    for (const d of docs) {
      if (!MIRRORED.test(d._id) || typeof d.text !== 'string' || tsOf.get(d._id) === d.ts) continue;
      const file = path.join(dir, d._id);
      fs.writeFileSync(file, d.text, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      synced.set(d._id, sigOf(fs.statSync(file)));
      tsOf.set(d._id, d.ts);
      if (d.ts > since) since = d.ts;
    }
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

  return { restore, pull, sync, flush, start, stop, _synced: synced };
}

/** Single-use WebAuthn challenges for hosts with no memory shared between requests: the ceremony's
 *  two requests may land on different instances. take() deletes atomically, so a challenge still
 *  works once. `col` is a MongoDB collection with a TTL index on `exp`. */
export function createChallengeStore(col) {
  return {
    put: (cid, data, expMs) => col.insertOne({ _id: cid, data, exp: new Date(expMs) }),
    take: async cid => {
      const d = await col.findOneAndDelete({ _id: cid });
      const doc = d?.value !== undefined ? d.value : d;   // driver 6 returns the document itself
      return doc && doc.exp.getTime() >= Date.now() ? doc.data : null;
    },
  };
}

/** The real thing: connects with the driver (loaded only now, so it stays out of every other
 *  deployment) and restores. Throws if Mongo cannot be reached. `poll: false` skips the background
 *  timer (a serverless instance is frozen between requests; use pull() and flush() around each). */
export async function startMirror({ dir, uri, dbName = 'opengym', collection = 'files', poll = true, log = console }) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, appName: 'opengym-api' });
  await client.connect();
  const db = client.db(dbName);
  const col = db.collection(collection);
  const m = createMirror({ dir, col, log });
  await m.restore();
  await m.sync();                       // files that only exist locally (a first migration)
  if (poll) m.start();
  else {
    await col.createIndex({ ts: 1 });
    const ch = db.collection('challenges');
    await ch.createIndex({ exp: 1 }, { expireAfterSeconds: 0 });
    m.challenges = createChallengeStore(ch);
  }
  m.close = () => client.close();
  return m;
}
