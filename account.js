'use strict';
// アカウント（メールアドレスとパスワード）と、端末どうしで台帳をそろえる仕組み。
//
// 鍵のしくみ（だれが何を持つか）
// ・台帳の鍵（DK）：台帳の中身を暗号化する鍵。端末の中で作り、受け口には「包んだ形」でしか渡さない。
// ・パスワード → PBKDF2（60万回）→ 2つに分ける
//     確認用の値（受け口に送る。ログインの確認に使う。ここから台帳の鍵は作れない）
//     包む鍵（端末の中だけ。台帳の鍵を包む・開く）
// ・復旧コード（24文字。紙に控える）でも台帳の鍵を包んでおく → パスワードを忘れた時に使う
// ・端末の鍵：端末の中の片割れ ＋ 受け口の片割れ（メールの確認コードが合った時だけもらえる）
//     → パスワードを忘れても、ログインしたことのある端末とメールがあれば戻せる
// 受け口に届くのは、暗号化したままの中身と、包んだ鍵と、確認用の値だけ。中身は読めない。
(function (root) {
  const ITER = 600000;
  const MIN_PASS = 8;
  const KEEP_SNAPS = 14;
  const KEEP_LOG = 3000;
  const SNAP_EVERY = 300;
  const te = new TextEncoder(), td = new TextDecoder();
  const subtle = () => root.crypto.subtle;
  const HK_SALT = te.encode('yoyaku-daicho');
  const AAD_DK = te.encode('yoyaku-dk');

  function bad(msg, status, code) { return Object.assign(new Error(msg), { status: status || 400, code: code || '' }); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function today() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function b64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
  const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function rand(n) { const u = new Uint8Array(n); root.crypto.getRandomValues(u); return u; }
  function cat(a, b) { const u = new Uint8Array(a.length + b.length); u.set(a); u.set(b, a.length); return u; }

  function checkPass(p) {
    if (typeof p !== 'string' || p.normalize('NFKC').length < MIN_PASS) throw bad('パスワードは' + MIN_PASS + '文字以上にしてください');
    if (p.length > 200) throw bad('パスワードが長すぎます');
  }
  function normEmail(v) {
    const s = String(v || '').trim().toLowerCase();
    if (s.length > 254 || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw bad('メールアドレスの形が正しくありません');
    return s;
  }

  // ---------- 鍵 ----------
  async function master(pass, saltB64, iter) {
    if (!(iter >= 100000 && iter <= 5000000)) throw bad('計算の回数が正しくありません');
    const base = await subtle().importKey('raw', te.encode(String(pass).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: iter }, base, 256);
    const hk = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveBits', 'deriveKey']);
    const auth = new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: HK_SALT, info: te.encode('yoyaku-auth') }, hk, 256));
    const kek = await subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: HK_SALT, info: te.encode('yoyaku-enc') }, hk, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
    return { authKey: b64(auth), kek };
  }
  async function wrap(dk, key) {
    const iv = rand(12);
    return b64(cat(iv, new Uint8Array(await subtle().wrapKey('raw', dk, key, { name: 'AES-GCM', iv, additionalData: AAD_DK }))));
  }
  async function unwrap(w, key, extractable) {
    const u = unb64(w);
    return subtle().unwrapKey('raw', u.subarray(12), key, { name: 'AES-GCM', iv: u.subarray(0, 12), additionalData: AAD_DK }, { name: 'AES-GCM' }, !!extractable, ['encrypt', 'decrypt']);
  }
  async function tryUnwrap(w, key, extractable) { try { return await unwrap(w, key, extractable); } catch (e) { return null; } }

  // 復旧コード：24文字（120ビット）。見間違えやすい I L O U は使わない
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function newRecoveryCode() {
    let out = '', val = 0, bits = 0;
    for (const x of rand(15)) {
      val = (val << 8) | x; bits += 8;
      while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
      val &= (1 << bits) - 1;
    }
    return out.match(/.{4}/g).join('-');
  }
  function normRecovery(s) { return String(s || '').toUpperCase().replace(/[\s\-ー－]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1'); }
  async function recoveryKey(code, saltB64) {
    const n = normRecovery(code);
    if (!/^[0-9A-HJKMNP-TV-Z]{24}$/.test(n)) throw bad('復旧コードは、紙に控えた24文字（4文字ずつ6つ）です');
    const hk = await subtle().importKey('raw', te.encode(n), 'HKDF', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unb64(saltB64), info: te.encode('yoyaku-recovery') }, hk, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  }
  async function deviceKey(devKey, deviceSecret) {
    return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unb64(deviceSecret), info: te.encode('yoyaku-device') }, devKey, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  }

  // ---------- 中身の暗号化（圧縮してから） ----------
  async function gz(u8, compress) {
    if (typeof CompressionStream === 'undefined') return null;
    const s = new Blob([u8]).stream().pipeThrough(compress ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function seal(dk, obj, aad) {
    let pt = te.encode(JSON.stringify(obj)), flag = 0;
    const z = await gz(pt, true);
    if (z) { pt = z; flag = 1; }
    const body = new Uint8Array(pt.length + 1); body[0] = flag; body.set(pt, 1);
    const iv = rand(12);
    return b64(cat(iv, new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, dk, body))));
  }
  async function unseal(dk, s, aad) {
    const u = unb64(s);
    let pt;
    try { pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12), additionalData: te.encode(aad) }, dk, u.subarray(12))); }
    catch (e) { throw bad('暗号を開けませんでした（鍵が違うか、書き換えられています）', 400, 'decrypt'); }
    let body = pt.subarray(1);
    if (pt[0] === 1) { body = await gz(body, false); if (!body) throw bad('この端末では開けない形です'); }
    return JSON.parse(td.decode(body));
  }

  // ---------- 変更の取り出しと当てはめ ----------
  const SKIP = new Set(['customers', 'reservations', 'log', 'seq', 'dayInfo']);
  const logKey = (x) => x.t + '|' + x.act + '|' + x.ref;
  function indexDb(db) {
    const m = (arr) => new Map((arr || []).map((x) => [x.id, JSON.stringify(x)]));
    const meta = new Map();
    for (const k of Object.keys(db)) if (!SKIP.has(k)) meta.set(k, JSON.stringify(db[k]));
    return { c: m(db.customers), r: m(db.reservations), meta, di: new Map(Object.entries(db.dayInfo || {}).map(([k, v]) => [k, JSON.stringify(v)])), seq: JSON.stringify(db.seq || {}), log: new Set((db.log || []).map(logKey)) };
  }
  // 前の状態（base）と今の台帳を比べ、変わったところだけを取り出す。base も今の状態に進める
  function diffDb(base, db) {
    const op = {};
    let any = false;
    const coll = (arr, key) => {
      const now = new Map(), puts = [];
      for (const x of arr || []) { const j = JSON.stringify(x); now.set(x.id, j); if (base[key].get(x.id) !== j) puts.push(JSON.parse(j)); }
      const dels = [...base[key].keys()].filter((id) => !now.has(id));
      if (puts.length || dels.length) { op[key] = { puts, dels }; any = true; }
      base[key] = now;
    };
    coll(db.customers, 'c'); coll(db.reservations, 'r');
    const meta = new Map();
    for (const k of Object.keys(db)) {
      if (SKIP.has(k)) continue;
      const j = JSON.stringify(db[k]); meta.set(k, j);
      if (base.meta.get(k) !== j) { (op.m = op.m || {})[k] = JSON.parse(j); any = true; }
    }
    for (const k of base.meta.keys()) if (!meta.has(k)) { (op.mdel = op.mdel || []).push(k); any = true; }
    base.meta = meta;
    const di = new Map(Object.entries(db.dayInfo || {}).map(([k, v]) => [k, JSON.stringify(v)]));
    const dputs = {}, ddels = [];
    for (const [k, j] of di) if (base.di.get(k) !== j) dputs[k] = JSON.parse(j);
    for (const k of base.di.keys()) if (!di.has(k)) ddels.push(k);
    if (Object.keys(dputs).length || ddels.length) { op.di = { puts: dputs, dels: ddels }; any = true; }
    base.di = di;
    const sj = JSON.stringify(db.seq || {});
    if (sj !== base.seq) { op.seq = JSON.parse(sj); base.seq = sj; any = true; }
    const logs = (db.log || []).filter((x) => !base.log.has(logKey(x)));
    if (logs.length) { op.log = JSON.parse(JSON.stringify(logs)); any = true; }
    base.log = new Set((db.log || []).map(logKey));
    return any ? op : null;
  }
  function applyOps(db, ops) {
    const cm = new Map((db.customers || []).map((x) => [x.id, x]));
    const rm = new Map((db.reservations || []).map((x) => [x.id, x]));
    const logAdd = [];
    for (const op of ops) {
      if (op.c) { for (const x of op.c.puts || []) cm.set(x.id, x); for (const id of op.c.dels || []) cm.delete(id); }
      if (op.r) { for (const x of op.r.puts || []) rm.set(x.id, x); for (const id of op.r.dels || []) rm.delete(id); }
      if (op.m) for (const [k, v] of Object.entries(op.m)) if (!SKIP.has(k)) db[k] = v;
      if (op.mdel) for (const k of op.mdel) if (!SKIP.has(k)) delete db[k];
      if (op.di) { db.dayInfo = db.dayInfo || {}; for (const [k, v] of Object.entries(op.di.puts || {})) db.dayInfo[k] = v; for (const k of op.di.dels || []) delete db.dayInfo[k]; }
      // 予約番号・お客様番号の数え上げは、大きいほうにそろえる
      if (op.seq) { db.seq = db.seq || {}; for (const [k, v] of Object.entries(op.seq)) db.seq[k] = Math.max(+db.seq[k] || 0, +v || 0); }
      if (op.log) logAdd.push(...op.log);
    }
    db.customers = [...cm.values()];
    db.reservations = [...rm.values()];
    if (logAdd.length) {
      db.log = db.log || [];
      const have = new Set(db.log.map(logKey));
      for (const x of logAdd) if (!have.has(logKey(x))) { db.log.push(x); have.add(logKey(x)); }
      db.log.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
      if (db.log.length > KEEP_LOG) db.log.splice(0, db.log.length - KEEP_LOG);
    }
    return db;
  }

  function deviceName() {
    const ua = (root.navigator && root.navigator.userAgent) || '';
    const touch = root.navigator && root.navigator.maxTouchPoints > 1;
    const kind = /iPad/.test(ua) || (/Macintosh/.test(ua) && touch) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : '端末';
    const d = new Date();
    return kind + '（' + d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' に登録）';
  }

  // ---------- アカウント ----------
  class Account {
    // storage: { get, set, del, keys }（iPadでは IndexedDB）、base: 受け口のアドレス
    constructor(storage, base, fetchFn) {
      this.s = storage; this.base = String(base || '').replace(/\/$/, ''); this.fetch = fetchFn || ((u, o) => root.fetch(u, o));
      this.st = null; this.dk = null; this.lastSeq = 0; this.pending = []; this.reset = null; this.syncing = null;
    }
    async load() { this.st = (await this.s.get('acct')) || null; return this.st; }
    get email() { return this.st ? this.st.email : ''; }
    get unlocked() { return !!this.dk; }
    async _saveSt() { await this.s.set('acct', this.st); }

    async call(method, path, body, opt) {
      opt = opt || {};
      if (!this.base) throw bad('受け口のアドレスが設定されていません', 0, 'offline');
      const headers = {};
      if (body !== undefined) headers['content-type'] = opt.raw ? 'text/plain' : 'application/json';
      if (opt.auth) { if (!this.st || !this.st.token) throw bad('もう一度ログインしてください', 401, 'login'); headers.authorization = 'Bearer ' + this.st.token; }
      let r;
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl && opt.timeout ? setTimeout(() => ctl.abort(), opt.timeout) : null;
      try { r = await this.fetch(this.base + path, { method, headers, body: body === undefined ? undefined : (opt.raw ? body : JSON.stringify(body)), cache: 'no-store', signal: ctl ? ctl.signal : undefined }); }
      catch (e) { throw bad('インターネットにつながっていないか、受け口に届きません', 0, 'offline'); }
      finally { if (timer) clearTimeout(timer); }
      if (opt.text && r.ok) return { text: await r.text(), headers: r.headers };
      let j = {};
      try { j = await r.json(); } catch (e) { /* 空 */ }
      if (!r.ok) throw bad(j.error || ('受け口でうまくいきませんでした（' + r.status + '）'), r.status, j.code || '');
      return j;
    }

    // 受け口からもらった値を、この端末に覚える（初めての端末なら端末の鍵も作る）
    async _adopt(r, email, dkExt) {
      const prev = this.st && this.st.email === email && this.st.deviceId === r.deviceId ? this.st : null;
      const st = { email, accountId: r.accountId, salt: r.salt, iter: r.iter, wrappedPw: r.wrappedPw, keyVer: r.keyVer, token: r.token, deviceId: r.deviceId, devKey: prev ? prev.devKey : null, wrappedDev: prev ? prev.wrappedDev : null };
      if (r.deviceSecret) {
        st.devKey = await subtle().importKey('raw', rand(32), 'HKDF', false, ['deriveKey']); // 取り出せない形で端末に残す
        st.wrappedDev = await wrap(dkExt, await deviceKey(st.devKey, r.deviceSecret));
      }
      this.st = st;
      await this._saveSt();
    }
    async _guard() { return (await this.s.get('guard')) || { fails: 0, until: 0 }; }
    async _failed() {
      const g = await this._guard(), fails = g.fails + 1;
      await this.s.set('guard', { fails, until: fails >= 5 ? Date.now() + Math.min(60000 * 2 ** (fails - 5), 30 * 60000) : 0 });
    }

    // 新しく登録する（1）確認コードを送る
    async signupStart(email) { await this.call('POST', '/auth/signup/start', { email: normEmail(email) }); }
    // 新しく登録する（2）確認コード・パスワード → 台帳の鍵と復旧コードを作る
    async signupFinish(email, code, password) {
      email = normEmail(email); checkPass(password);
      const salt = b64(rand(16)), m = await master(password, salt, ITER);
      const dk = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
      // 復旧コードは2つ：1つ目はお店で保管、2つ目は信頼できる人に預ける（どちらか1つあれば戻せる）
      const recoveryCodes = [newRecoveryCode(), newRecoveryCode()], rcSalt = b64(rand(16)), rcSalt2 = b64(rand(16));
      const r = await this.call('POST', '/auth/signup/finish', {
        email, code, salt, iter: ITER, authKey: m.authKey, wrappedPw: await wrap(dk, m.kek),
        wrappedRc: await wrap(dk, await recoveryKey(recoveryCodes[0], rcSalt)), rcSalt,
        wrappedRc2: await wrap(dk, await recoveryKey(recoveryCodes[1], rcSalt2)), rcSalt2, deviceName: deviceName(),
      });
      await this._adopt(r, email, dk);
      this.dk = await unwrap(r.wrappedPw, m.kek, false);
      await this.s.set('guard', { fails: 0, until: 0 });
      return { recoveryCodes };
    }

    // ほかの端末で作ったアカウントに、この端末でログインする
    async login(email, password) {
      email = normEmail(email);
      if (this.st && this.st.email !== email) throw bad('この端末は別のアカウントで使っています。先にログアウトしてください');
      const pre = await this.call('POST', '/auth/prelogin', { email });
      const m = await master(String(password || ''), pre.salt, pre.iter);
      const same = this.st && this.st.wrappedDev;
      const r = await this.call('POST', '/auth/login', { email, authKey: m.authKey, deviceId: same ? this.st.deviceId : undefined, deviceName: deviceName() });
      const dkExt = await tryUnwrap(r.wrappedPw, m.kek, !!r.deviceSecret);
      if (!dkExt) throw bad('台帳の鍵を開けませんでした');
      await this._adopt(r, email, dkExt);
      this.dk = r.deviceSecret ? await unwrap(r.wrappedPw, m.kek, false) : dkExt;
      await this.s.set('guard', { fails: 0, until: 0 });
    }

    // ふだん開く時（ロックを外す）。まず端末の中で確かめ、つながれば受け口でも確かめる
    async unlock(password) {
      if (!this.st) throw bad('ログインしてください', 401, 'login');
      const g = await this._guard();
      if (Date.now() < g.until) throw bad('続けて間違えたため、' + Math.ceil((g.until - Date.now()) / 1000) + '秒待ってください', 429);
      const st = this.st, pass = String(password || '');
      const m = await master(pass, st.salt, st.iter);
      const local = await tryUnwrap(st.wrappedPw, m.kek, false);
      let pre;
      try { pre = await this.call('POST', '/auth/prelogin', { email: st.email }, { timeout: 6000 }); }
      catch (e) {
        if (e.code !== 'offline') throw e;
        if (!local) { await this._failed(); throw bad('パスワードが違います（インターネットにつながっていません）', 403); }
        this.dk = local; await this.s.set('guard', { fails: 0, until: 0 });
        return { offline: true };
      }
      const m2 = pre.salt === st.salt && pre.iter === st.iter ? m : await master(pass, pre.salt, pre.iter);
      let r;
      try { r = await this.call('POST', '/auth/login', { email: st.email, authKey: m2.authKey, deviceId: st.wrappedDev ? st.deviceId : undefined, deviceName: deviceName() }, { timeout: 10000 }); }
      catch (e) {
        if (e.code === 'offline' && local) { this.dk = local; await this.s.set('guard', { fails: 0, until: 0 }); return { offline: true }; }
        if (e.code === 'bad_login') {
          await this._failed();
          throw bad(local ? 'パスワードが変更されています。新しいパスワードを入れてください' : 'パスワードが違います', 403);
        }
        throw e;
      }
      const dkExt = await tryUnwrap(r.wrappedPw, m2.kek, !!r.deviceSecret);
      if (!dkExt) throw bad('台帳の鍵を開けませんでした');
      await this._adopt(r, st.email, dkExt);
      this.dk = r.deviceSecret ? await unwrap(r.wrappedPw, m2.kek, false) : dkExt;
      await this.s.set('guard', { fails: 0, until: 0 });
      return { offline: false };
    }
    lock() { this.dk = null; }

    async changePassword(oldPass, newPass) {
      checkPass(newPass);
      const st = this.st;
      const mo = await master(String(oldPass || ''), st.salt, st.iter);
      const dkExt = await tryUnwrap(st.wrappedPw, mo.kek, true);
      if (!dkExt) throw bad('今のパスワードが違います', 403);
      const salt = b64(rand(16)), mn = await master(newPass, salt, ITER), wrappedPw = await wrap(dkExt, mn.kek);
      const r = await this.call('POST', '/auth/password', { oldAuthKey: mo.authKey, salt, iter: ITER, authKey: mn.authKey, wrappedPw }, { auth: true });
      Object.assign(st, { salt, iter: ITER, wrappedPw, keyVer: r.keyVer });
      await this._saveSt();
    }
    async newRecoveryCode(password, slot) {
      const st = this.st;
      const m = await master(String(password || ''), st.salt, st.iter);
      const dkExt = await tryUnwrap(st.wrappedPw, m.kek, true);
      if (!dkExt) throw bad('パスワードが違います', 403);
      const recoveryCode = newRecoveryCode(), rcSalt = b64(rand(16));
      await this.call('POST', '/auth/recovery', { slot: slot === 2 ? 2 : 1, authKey: m.authKey, wrappedRc: await wrap(dkExt, await recoveryKey(recoveryCode, rcSalt)), rcSalt }, { auth: true });
      return { recoveryCode };
    }

    // ---------- パスワードを忘れた時 ----------
    async resetStart(email) { await this.call('POST', '/auth/reset/start', { email: normEmail(email) }); }
    async resetVerify(email, code) {
      email = normEmail(email);
      const mine = this.st && this.st.email === email && this.st.wrappedDev && this.st.devKey;
      const r = await this.call('POST', '/auth/reset/verify', { email, code, deviceId: mine ? this.st.deviceId : undefined });
      this.reset = { email, ticket: r.ticket, deviceSecret: r.deviceSecret, rcs: [[r.wrappedRc, r.rcSalt], [r.wrappedRc2, r.rcSalt2]].filter((x) => x[0] && x[1]) };
      return { usesDevice: !!(mine && r.deviceSecret) };
    }
    async resetFinish(password, recoveryCode) {
      const R = this.reset;
      if (!R) throw bad('はじめからやり直してください');
      checkPass(password);
      const mine = this.st && this.st.email === R.email && this.st.wrappedDev && this.st.devKey;
      let dkExt = null;
      if (mine && R.deviceSecret) dkExt = await tryUnwrap(this.st.wrappedDev, await deviceKey(this.st.devKey, R.deviceSecret), true);
      if (!dkExt) {
        if (!recoveryCode) throw bad('この端末だけでは戻せません。紙に控えた復旧コードを入れてください', 400, 'need_rc');
        for (const [w, salt] of R.rcs) { dkExt = await tryUnwrap(w, await recoveryKey(recoveryCode, salt), true); if (dkExt) break; }
        if (!dkExt) throw bad('復旧コードが違います', 403);
      }
      const salt = b64(rand(16)), m = await master(password, salt, ITER), wrappedPw = await wrap(dkExt, m.kek);
      const r = await this.call('POST', '/auth/reset/finish', { ticket: R.ticket, salt, iter: ITER, authKey: m.authKey, wrappedPw, deviceId: mine ? this.st.deviceId : undefined, deviceName: deviceName() });
      await this._adopt(r, R.email, dkExt);
      this.dk = await unwrap(r.wrappedPw, m.kek, false);
      this.reset = null;
      await this.s.set('guard', { fails: 0, until: 0 });
    }

    async devices() { return (await this.call('GET', '/devices', undefined, { auth: true })).devices; }
    async removeDevice(id) { await this.call('POST', '/devices/remove', { id }, { auth: true }); }

    // この端末からアカウントと台帳を消す（受け口の台帳は残る）
    async logout() {
      try { await this.call('POST', '/auth/logout', {}, { auth: true, timeout: 6000 }); } catch (e) { /* つながらなくても端末からは消す */ }
      for (const k of await this.s.keys()) await this.s.del(k);
      this.st = null; this.dk = null; this.lastSeq = 0; this.pending = [];
    }

    // ---------- 端末の中の台帳（暗号化して保存） ----------
    _aad(kind) { return 'yoyaku-' + kind + ':' + this.st.accountId; }
    async loadLocal() {
      const x = await this.s.get('ledger');
      this.pending = (await this.s.get('pending')) || [];
      if (!x) { this.lastSeq = 0; return null; }
      this.lastSeq = x.seq || 0;
      return unseal(this.dk, x.data, this._aad('local'));
    }
    async saveLocal(db) {
      if (!this.dk) throw bad('ロックされています', 401);
      const cur = await this.s.get('ledger');
      if (cur) {
        const k = 'snap:' + today();
        if (!(await this.s.get(k))) {
          await this.s.set(k, cur);
          const snaps = (await this.s.keys()).filter((x) => /^snap:\d{4}-\d{2}-\d{2}$/.test(x)).sort();
          for (const x of snaps.slice(0, Math.max(0, snaps.length - KEEP_SNAPS))) await this.s.del(x);
        }
      }
      await this.s.set('ledger', { seq: this.lastSeq, savedAt: new Date().toISOString(), data: await seal(this.dk, db, this._aad('local')) });
    }
    async snapshots() { return (await this.s.keys()).filter((x) => /^snap:\d{4}-\d{2}-\d{2}$/.test(x)).sort().reverse().map((k) => k.slice(5)); }

    // 変更を「まだ送っていない変更」に積む（暗号化してから）
    async record(op) {
      this.pending.push({ cid: b64url(rand(12)), blob: await seal(this.dk, op, this._aad('op')) });
      await this.s.set('pending', this.pending);
    }

    // 受け口と台帳をそろえる。戻り値の db は、そろえたあとの台帳（ほかの端末の変更が入っていれば changed: true）
    async sync(db) {
      if (!this.dk) throw bad('ロックされています', 401);
      const mine = new Set();
      // 1. 送っていない変更を送る
      while (this.pending.length) {
        const batch = this.pending.slice(0, 50);
        await this.call('POST', '/sync/push', { ops: batch }, { auth: true, timeout: 20000 });
        batch.forEach((x) => mine.add(x.cid));
        this.pending = this.pending.slice(batch.length);
        await this.s.set('pending', this.pending);
      }
      // 2. ほかの端末の変更を受け取る
      let changed = false, r;
      for (let guard = 0; guard < 1000; guard++) {
        r = await this.call('GET', '/sync/pull?after=' + this.lastSeq, undefined, { auth: true, timeout: 20000 });
        if (!db || r.needSnapshot) {
          if (!r.hasSnap) { if (!db) throw bad('受け口に台帳がまだありません', 404, 'no_snap'); break; }
          const s = await this.call('GET', '/sync/snapshot', undefined, { auth: true, text: true, timeout: 60000 });
          db = await unseal(this.dk, s.text, this._aad('snap'));
          this.lastSeq = Number(s.headers.get('x-snap-seq')) || 0;
          changed = true;
          if (this.pending.length) applyOps(db, await Promise.all(this.pending.map((x) => unseal(this.dk, x.blob, this._aad('op')))));
          continue;
        }
        if (r.ops.length) {
          const ops = await Promise.all(r.ops.map((x) => unseal(this.dk, x.blob, this._aad('op'))));
          applyOps(db, ops);
          // まだ送れていない手元の変更は、受け取った変更のあとに当て直す（送った順で受け口と同じになる）
          if (this.pending.length) applyOps(db, await Promise.all(this.pending.map((x) => unseal(this.dk, x.blob, this._aad('op')))));
          if (r.ops.some((x) => !mine.has(x.cid))) changed = true;
          this.lastSeq = r.ops[r.ops.length - 1].seq;
        }
        if (!r.more) { this.lastSeq = Math.max(this.lastSeq, r.head); break; }
      }
      // 3. 変更の記録がたまったら、台帳まるごとの控えを預ける（新しい端末が早く開けるように）
      // （登録の途中で通信が切れて、受け口に台帳がまだない時も、ここで預ける）
      if (r && !this.pending.length && (!r.hasSnap || this.lastSeq - r.snapSeq >= SNAP_EVERY)) {
        try { await this.uploadSnapshot(db); } catch (e) { /* 次の機会に */ }
      }
      await this.saveLocal(db);
      return { db, changed };
    }
    async uploadSnapshot(db) {
      await this.call('PUT', '/sync/snapshot?seq=' + this.lastSeq, await seal(this.dk, db, this._aad('snap')), { auth: true, raw: true, timeout: 120000 });
    }

    // ---------- バックアップ（ファイル） ----------
    // そのファイルは、書き出した時のパスワードで開ける（暗号化したまま）
    async exportBackup(db) {
      const st = this.st;
      return JSON.stringify({ format: 'yoyaku-daicho-account', v: 1, kdf: { name: 'PBKDF2-SHA256', iter: st.iter, salt: st.salt }, wrappedPw: st.wrappedPw, savedAt: new Date().toISOString(), data: await seal(this.dk, db, 'yoyaku-backup') });
    }
    async exportSnapshot(date) {
      const x = await this.s.get('snap:' + date);
      if (!x) throw bad('控えが見つかりません', 404);
      return this.exportBackup(await unseal(this.dk, x.data, this._aad('local')));
    }
  }
  async function openBackup(text, password) {
    let j;
    try { j = JSON.parse(text); } catch (e) { throw bad('台帳のファイルではありません'); }
    if (!j || j.format !== 'yoyaku-daicho-account' || j.v !== 1 || !j.kdf || typeof j.kdf.salt !== 'string' || typeof j.wrappedPw !== 'string' || typeof j.data !== 'string') return null;
    const m = await master(String(password || ''), j.kdf.salt, j.kdf.iter);
    const dk = await tryUnwrap(j.wrappedPw, m.kek, false);
    if (!dk) throw bad('このバックアップを書き出した時のパスワードが違います', 403);
    return unseal(dk, j.data, 'yoyaku-backup');
  }

  const api = { Account, openBackup, indexDb, diffDb, applyOps, newRecoveryCode, normRecovery, normEmail, MIN_PASS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YoyakuAccount = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
