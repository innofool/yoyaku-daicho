'use strict';
// 台帳の金庫：中身を暗号化して、その端末（iPad）の中にだけ保存する。
// ・合言葉から鍵を作る（PBKDF2-SHA256・60万回）。合言葉も鍵も保存しない。
// ・中身は AES-256-GCM で暗号化。1文字でも書き換えられたら開けない。
// ・その日の最初の保存の前に、前の状態を控えとして残す（14日分。暗号化のまま）。
(function (root) {
  const FORMAT = 'yoyaku-daicho';
  const VERSION = 2;
  const ITER = 600000;
  const MIN_PASS = 8;
  const KEEP_SNAPS = 14;
  const AAD = new TextEncoder().encode(FORMAT + ':' + VERSION);
  const subtle = () => root.crypto.subtle;

  function bad(msg, status) { return Object.assign(new Error(msg), { status: status || 400 }); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function today() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
  function rand(n) { const u = new Uint8Array(n); root.crypto.getRandomValues(u); return u; }

  async function deriveKey(pass, salt, iter) {
    const base = await subtle().importKey('raw', new TextEncoder().encode(String(pass).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  function parseEnvelope(text) {
    let j;
    try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { throw bad('台帳のファイルではありません'); }
    if (!j || j.format !== FORMAT || j.v !== VERSION || !j.kdf || j.kdf.name !== 'PBKDF2-SHA256') throw bad('台帳のファイルではありません');
    // 書き換えられたファイルで重い計算をさせられないよう上限を置く
    if (!(j.kdf.iter >= 100000 && j.kdf.iter <= 5000000) || typeof j.kdf.salt !== 'string' || typeof j.iv !== 'string' || typeof j.data !== 'string') throw bad('台帳のファイルではありません');
    return j;
  }

  async function open(env, key) {
    try {
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: AAD }, key, unb64(env.data));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (e) { return null; }
  }

  class Vault {
    // storage: { get(k), set(k, v), del(k), keys() } を持つ入れ物（iPadでは IndexedDB）
    constructor(storage) { this.s = storage; this.key = null; this.kdf = null; }

    get unlocked() { return !!this.key; }
    async exists() { return !!(await this.s.get('ledger')); }

    checkPass(pass) {
      if (typeof pass !== 'string' || pass.normalize('NFKC').length < MIN_PASS) throw bad('合言葉は' + MIN_PASS + '文字以上にしてください');
      if (pass.length > 200) throw bad('合言葉が長すぎます');
    }

    async setup(pass, db) {
      if (await this.exists()) throw bad('すでに台帳があります', 409);
      this.checkPass(pass);
      const salt = rand(16);
      this.kdf = { name: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt) };
      this.key = await deriveKey(pass, salt, ITER);
      await this.save(db);
    }

    // 続けて間違えたら待ち時間を置く（記録は端末の中。中身は暗号化されていないが、回数と時刻だけ）
    async guard() { return (await this.s.get('guard')) || { fails: 0, until: 0 }; }

    async unlock(pass) {
      const g = await this.guard();
      if (Date.now() < g.until) throw bad('続けて間違えたため、' + Math.ceil((g.until - Date.now()) / 1000) + '秒待ってください', 429);
      const env = parseEnvelope(await this.s.get('ledger'));
      const key = await deriveKey(String(pass || ''), unb64(env.kdf.salt), env.kdf.iter);
      const db = await open(env, key);
      if (!db) {
        const fails = g.fails + 1;
        await this.s.set('guard', { fails, until: fails >= 5 ? Date.now() + Math.min(60000 * 2 ** (fails - 5), 30 * 60000) : 0 });
        return null;
      }
      await this.s.set('guard', { fails: 0, until: 0 });
      this.key = key;
      this.kdf = env.kdf;
      return db;
    }

    lock() { this.key = null; this.kdf = null; }

    async _encrypt(db) {
      const iv = rand(12);
      const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, this.key, new TextEncoder().encode(JSON.stringify(db))));
      return JSON.stringify({ format: FORMAT, v: VERSION, kdf: this.kdf, savedAt: new Date().toISOString(), iv: b64(iv), data: b64(ct) });
    }

    async save(db) {
      if (!this.key) throw bad('ロックされています', 401);
      const out = await this._encrypt(db);
      await this._snapshot();
      await this.s.set('ledger', out);
    }

    async _snapshot() {
      const cur = await this.s.get('ledger');
      if (!cur) return;
      const k = 'snap:' + today();
      if (await this.s.get(k)) return;
      await this.s.set(k, cur);
      const snaps = (await this.s.keys()).filter((x) => /^snap:\d{4}-\d{2}-\d{2}$/.test(x)).sort();
      for (const x of snaps.slice(0, Math.max(0, snaps.length - KEEP_SNAPS))) await this.s.del(x);
    }

    async snapshots() {
      const keys = (await this.s.keys()).filter((x) => /^snap:\d{4}-\d{2}-\d{2}$/.test(x)).sort().reverse();
      return keys.map((k) => k.slice(5));
    }

    async changePass(oldPass, newPass, db) {
      if (!this.key) throw bad('ロックされています', 401);
      const env = parseEnvelope(await this.s.get('ledger'));
      const check = await open(env, await deriveKey(String(oldPass || ''), unb64(env.kdf.salt), env.kdf.iter));
      if (!check) throw bad('今の合言葉が違います', 403);
      this.checkPass(newPass);
      const salt = rand(16);
      this.kdf = { name: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt) };
      this.key = await deriveKey(newPass, salt, ITER);
      // 古い合言葉の控えが残らないよう、控えも消す（新しい合言葉で今の状態を保存し直す）
      for (const k of await this.snapshots()) await this.s.del('snap:' + k);
      await this.s.set('ledger', await this._encrypt(db));
    }

    // バックアップ用：暗号化されたままの中身（そのままファイルに保存できる）
    async exportText(snapDate) {
      if (!this.key) throw bad('ロックされています', 401);
      const t = await this.s.get(snapDate ? 'snap:' + snapDate : 'ledger');
      if (!t) throw bad('控えが見つかりません', 404);
      return t;
    }

    // バックアップから戻す：そのファイルの合言葉で開けることを確かめてから置き換える
    async importText(text, pass) {
      const env = parseEnvelope(text);
      const key = await deriveKey(String(pass || ''), unb64(env.kdf.salt), env.kdf.iter);
      const db = await open(env, key);
      if (!db) throw bad('このバックアップの合言葉が違います', 403);
      await this._snapshot();
      await this.s.set('ledger', typeof text === 'string' ? text : JSON.stringify(text));
      this.key = key;
      this.kdf = env.kdf;
      return db;
    }
  }

  // iPadのブラウザの中の保存場所（IndexedDB）
  function idbStorage(name) {
    const dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(name || 'yoyaku-daicho', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = (mode, fn) => dbp.then((db) => new Promise((resolve, reject) => {
      const t = db.transaction('kv', mode);
      const r = fn(t.objectStore('kv'));
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('保存できませんでした（端末の空き容量を確かめてください）'));
    }));
    return {
      get: (k) => tx('readonly', (s) => s.get(k)),
      set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
      del: (k) => tx('readwrite', (s) => s.delete(k)),
      keys: () => tx('readonly', (s) => s.getAllKeys()),
    };
  }

  // 試験用の入れ物（メモリの中だけ）
  function memoryStorage() {
    const m = new Map();
    return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); }, keys: async () => [...m.keys()], _map: m };
  }

  const api = { Vault, idbStorage, memoryStorage, parseEnvelope };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YoyakuVault = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
