'use strict';
// Λειτουργία «Τάξη»: ο καθηγητής βλέπει ζωντανά τον κώδικα των μαθητών και τα «σηκωμένα χέρια».
//
//  - Εύρεση: ο μαθητής στέλνει UDP broadcast «υπάρχει καθηγητής;» και ο καθηγητής απαντά unicast
//    (τα Windows δέχονται την απάντηση χωρίς κανόνα firewall στον υπολογιστή του μαθητή).
//  - Σύνδεση: TLS. Ο μαθητής συνεχίζει μόνο αν το δημόσιο κλειδί του server είναι ένα από τα αποτυπώματα
//    του classroom.json, που έβαλε ο διαχειριστής στον υπολογιστή (ο μαθητής δεν μπορεί να το αλλάξει).
//    Έτσι κανείς άλλος (ούτε μαθητής με την εφαρμογή σε «λειτουργία καθηγητή») δεν βλέπει τον κώδικα.
//  - Ο καθηγητής δέχεται μαθητή μόνο με το PIN που δείχνει η οθόνη του.
//  - Μηνύματα JSON, ένα ανά γραμμή.

const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { EventEmitter } = require('events');
const { fingerprint, normalizeFingerprint } = require('./classroomCert');

const APP = 'python2-epal';
const PROTOCOL = 1;
const DEFAULT_PORT = 47800;
const DISCOVERY_PORT = 47801;
const MAX_LINE = 512 * 1024;
const MAX_TEXT = 200 * 1024;
const DISCOVER_EVERY = 3000;
const HELLO_TIMEOUT = 10000;
const PIN_TRIES = 5;
const PIN_BLOCK = 60000;
const IMPOSTOR_BLOCK = 30000;

/** Χωρίζει τη ροή σε γραμμές JSON. Γραμμή-τέρας (πάνω από MAX_LINE) → onOverflow. */
function frameReader(onMessage, onOverflow) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg && typeof msg === 'object') onMessage(msg);
    }
    if (buf.length > MAX_LINE) { buf = ''; onOverflow(); }
  };
}

function sendLine(sock, obj) {
  if (sock && !sock.destroyed && sock.writable) sock.write(JSON.stringify(obj) + '\n');
}

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

/** Οι διευθύνσεις IPv4 του υπολογιστή (για να τις δει ο καθηγητής) και οι αντίστοιχες broadcast. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.push({ address: a.address, broadcast: ip.map((b, k) => (b | (~mask[k] & 255))).join('.') });
    }
  }
  return out;
}

// ---------------------------------------------------------------- classroom.json

/** Το αρχείο εμπιστοσύνης του υπολογιστή: γράφεται από τον διαχειριστή, όχι από τον μαθητή. */
function trustFilePath() {
  if (process.env.EPAL_CLASSROOM) return process.env.EPAL_CLASSROOM;
  if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Python2-EPAL', 'classroom.json');
  return '/etc/python2-epal/classroom.json';
}

/**
 * { ok, file, teachers: [{ name, room, fingerprint }], port, discoveryPort, hosts }
 * ή { ok: false, file, error: 'missing' | 'invalid', detail }.
 */
function loadTrust(file = trustFilePath()) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ok: false, file, error: e.code === 'ENOENT' ? 'missing' : 'invalid', detail: e.message };
  }
  const teachers = (Array.isArray(data && data.teachers) ? data.teachers : [])
    .map((t) => ({ name: clip(t && t.name, 80) || 'Καθηγητής', room: clip(t && t.room, 80), fingerprint: normalizeFingerprint(t && t.fingerprint) }))
    .filter((t) => t.fingerprint.length === 64);
  if (!teachers.length) return { ok: false, file, error: 'invalid', detail: 'Δεν υπάρχει έγκυρο αποτύπωμα καθηγητή (teachers[].fingerprint).' };
  return {
    ok: true,
    file,
    teachers,
    port: Number(data.port) || DEFAULT_PORT,
    discoveryPort: Number(data.discoveryPort) || DISCOVERY_PORT,
    hosts: (Array.isArray(data.hosts) ? data.hosts : []).map(String).filter((h) => /^[\w.:-]+$/.test(h)),
  };
}

/** Το classroom.json με τον καθηγητή μέσα. Αν υπάρχει ήδη αρχείο, κρατά τους άλλους καθηγητές του. */
function buildTrustFile(existing, teacher, hosts = []) {
  const prev = existing && typeof existing === 'object' ? existing : {};
  const fp = normalizeFingerprint(teacher.fingerprint);
  const others = (Array.isArray(prev.teachers) ? prev.teachers : [])
    .filter((t) => t && normalizeFingerprint(t.fingerprint) !== fp);
  return {
    app: APP,
    teachers: [...others, { name: teacher.name, room: teacher.room || '', fingerprint: teacher.fingerprint }],
    port: Number(prev.port) || DEFAULT_PORT,
    discoveryPort: Number(prev.discoveryPort) || DISCOVERY_PORT,
    hosts: [...new Set([...(Array.isArray(prev.hosts) ? prev.hosts : []), ...hosts])],
  };
}

const newPin = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

// ---------------------------------------------------------------- καθηγητής

class TeacherServer extends EventEmitter {
  constructor({ keyPem, certPem, port = DEFAULT_PORT, discoveryPort = DISCOVERY_PORT, pin = newPin() }) {
    super();
    this.keyPem = keyPem;
    this.certPem = certPem;
    this.fingerprint = fingerprint(crypto.createPrivateKey(keyPem));
    this.port = port;
    this.discoveryPort = discoveryPort;
    this.pin = pin;
    this.students = new Map();   // κλειδί «υπολογιστής|χρήστης» → μαθητής
    this.failures = new Map();   // IP → { count, until }
    this.nextId = 1;
    this.server = null;
    this.udp = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = tls.createServer({ key: this.keyPem, cert: this.certPem, minVersion: 'TLSv1.2' }, (sock) => this._onSocket(sock));
      this.server.on('tlsClientError', () => { /* π.χ. σύνδεση που έκλεισε στη μέση της χειραψίας */ });
      this.server.once('error', reject);
      this.server.listen(this.port, () => {
        this.server.removeListener('error', reject);
        this.server.on('error', (e) => this.emit('error', e));
        this.port = this.server.address().port;
        this._startDiscovery().then(() => resolve({ port: this.port, discoveryPort: this.discoveryPort }), (e) => {
          this.stop();
          reject(e);
        });
      });
    });
  }

  _startDiscovery() {
    return new Promise((resolve, reject) => {
      const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.udp = udp;
      udp.once('error', reject);
      udp.on('message', (buf, rinfo) => {
        let msg;
        try { msg = JSON.parse(String(buf)); } catch (_) { return; }
        if (!msg || msg.app !== APP || msg.type !== 'discover') return;
        const reply = Buffer.from(JSON.stringify({ app: APP, type: 'teacher', v: PROTOCOL, port: this.port, fp: this.fingerprint }));
        udp.send(reply, rinfo.port, rinfo.address, () => {});
      });
      udp.bind(this.discoveryPort, () => {
        udp.removeListener('error', reject);
        udp.on('error', (e) => this.emit('error', e));
        this.discoveryPort = udp.address().port;
        resolve();
      });
    });
  }

  _blocked(ip) {
    const f = this.failures.get(ip);
    return !!f && f.until > Date.now();
  }

  _failed(ip) {
    const f = this.failures.get(ip) || { count: 0, until: 0 };
    f.count++;
    if (f.count >= PIN_TRIES) { f.until = Date.now() + PIN_BLOCK; f.count = 0; }
    this.failures.set(ip, f);
  }

  _onSocket(sock) {
    const ip = (sock.remoteAddress || '').replace(/^::ffff:/, '');
    let student = null;
    sock.setEncoding('utf-8');
    sock.setKeepAlive(true, 5000);
    sock.setNoDelay(true);
    sock.on('error', () => {});
    const helloTimer = setTimeout(() => { if (!student) sock.destroy(); }, HELLO_TIMEOUT);

    sock.on('data', frameReader((msg) => {
      if (!student) {
        if (msg.type !== 'hello') return;
        clearTimeout(helloTimer);
        if (this._blocked(ip)) { sendLine(sock, { type: 'reject', reason: 'blocked' }); sock.end(); return; }
        if (msg.v !== PROTOCOL) { sendLine(sock, { type: 'reject', reason: 'version' }); sock.end(); return; }
        if (String(msg.pin) !== this.pin) {
          this._failed(ip);
          sendLine(sock, { type: 'reject', reason: 'pin' });
          sock.end();
          return;
        }
        this.failures.delete(ip);
        student = this._join(sock, ip, msg);
        return;
      }
      this._onMessage(student, msg);
    }, () => sock.destroy()));

    sock.on('close', () => {
      clearTimeout(helloTimer);
      if (student && student.socket === sock) {
        student.socket = null;
        student.online = false;
        this._changed(student);
      }
    });
  }

  _join(sock, ip, hello) {
    const user = clip(hello.user, 60);
    const host = clip(hello.host, 60);
    const key = `${host}|${user}`;
    let s = this.students.get(key);
    if (s && s.socket && s.socket !== sock) s.socket.destroy();   // ο ίδιος μαθητής ξανασυνδέθηκε
    if (!s) {
      s = { id: this.nextId++, key, text: '', file: '', cursor: null, errors: [], hand: false, handAt: 0, joinedAt: Date.now() };
      this.students.set(key, s);
    }
    Object.assign(s, { name: clip(hello.name, 80) || user || host, user, host, ip, socket: sock, online: true, seenAt: Date.now() });
    sendLine(sock, { type: 'welcome', id: s.id });
    this._changed(s);
    return s;
  }

  _onMessage(s, msg) {
    s.seenAt = Date.now();
    if (msg.type === 'code') {
      s.text = clip(msg.text, MAX_TEXT);
      s.file = clip(msg.file, 200);
      s.cursor = msg.cursor && Number.isFinite(msg.cursor.line) ? { line: msg.cursor.line, column: Number(msg.cursor.column) || 1 } : null;
      s.errors = (Array.isArray(msg.errors) ? msg.errors : []).slice(0, 10)
        .map((e) => ({ line: Number(e && e.line) || 0, message: clip(e && e.message, 300) }));
      s.updatedAt = Date.now();
      this._changed(s);
    } else if (msg.type === 'hand') {
      const up = !!msg.up;
      if (up === s.hand) return;
      s.hand = up;
      s.handAt = up ? Date.now() : 0;
      this._changed(s);
      if (up) this.emit('hand', this.snapshot(s));
    }
  }

  _changed(s) { this.emit('student', this.snapshot(s)); }

  snapshot(s) {
    const { socket, key, ...rest } = s;
    return rest;
  }

  list() { return [...this.students.values()].map((s) => this.snapshot(s)); }

  _byId(id) { return [...this.students.values()].find((s) => s.id === id) || null; }

  lowerHand(id) {
    const s = this._byId(id);
    if (!s || !s.hand) return;
    s.hand = false;
    s.handAt = 0;
    sendLine(s.socket, { type: 'hand', up: false });
    this._changed(s);
  }

  /** Αποσυνδέει τον μαθητή και τον βγάζει από τη λίστα. */
  remove(id) {
    const s = this._byId(id);
    if (!s) return;
    this.students.delete(s.key);
    if (s.socket) { sendLine(s.socket, { type: 'kick' }); s.socket.end(); }
    this.emit('remove', { id });
  }

  stop() {
    for (const s of this.students.values()) if (s.socket) s.socket.destroy();
    this.students.clear();
    if (this.server) { this.server.close(); this.server = null; }
    if (this.udp) { try { this.udp.close(); } catch (_) { /* ήδη κλειστό */ } this.udp = null; }
  }
}

// ---------------------------------------------------------------- μαθητής

/**
 * Καταστάσεις (γεγονός 'status'): off, searching, connecting, connected, rejected (reason: pin | blocked | version), kicked.
 * Μετά από διακοπή της σύνδεσης ξαναψάχνει μόνος του τον καθηγητή.
 */
class StudentClient extends EventEmitter {
  constructor({ trust, name, user = os.userInfo().username, host = os.hostname(), pin }) {
    super();
    this.trust = trust;
    this.name = name;
    this.user = user;
    this.host = host;
    this.pin = String(pin);
    this.state = 'off';
    this.teacher = null;
    this.hand = false;
    this.lastCode = null;
    this.bad = new Map();   // IP που δεν απέδειξε ότι είναι ο καθηγητής → μέχρι πότε αγνοείται
    this.sock = null;
    this.udp = null;
    this.timer = null;
  }

  status(extra = {}) {
    return { state: this.state, teacher: this.teacher, hand: this.hand, ...extra };
  }

  _set(state, extra) {
    this.state = state;
    this.emit('status', this.status(extra));
  }

  start() {
    this.stopped = false;
    this._set('searching');
    const udp = dgram.createSocket('udp4');
    this.udp = udp;
    udp.on('error', () => {});
    udp.on('message', (buf, rinfo) => {
      let msg;
      try { msg = JSON.parse(String(buf)); } catch (_) { return; }
      if (!msg || msg.app !== APP || msg.type !== 'teacher' || this.state !== 'searching') return;
      if (!this._trusted(msg.fp) || (this.bad.get(rinfo.address) || 0) > Date.now()) return;
      this._connect(rinfo.address, Number(msg.port) || this.trust.port);
    });
    udp.bind(0, () => {
      try { udp.setBroadcast(true); } catch (_) { /* χωρίς broadcast μένουν οι σταθερές διευθύνσεις (hosts) */ }
      this._discover();
      this.timer = setInterval(() => this._discover(), DISCOVER_EVERY);
    });
  }

  _trusted(fp) {
    const n = normalizeFingerprint(fp);
    return this.trust.teachers.find((t) => t.fingerprint === n) || null;
  }

  _discover() {
    if (this.state !== 'searching' || !this.udp) return;
    const msg = Buffer.from(JSON.stringify({ app: APP, type: 'discover', v: PROTOCOL }));
    const targets = new Set(['255.255.255.255', ...lanAddresses().map((a) => a.broadcast), ...this.trust.hosts]);
    for (const t of targets) this.udp.send(msg, this.trust.discoveryPort, t, () => {});
  }

  _connect(ip, port) {
    this._set('connecting');
    const sock = tls.connect({ host: ip, port, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    this.sock = sock;
    sock.setEncoding('utf-8');
    sock.setKeepAlive(true, 5000);
    sock.setNoDelay(true);
    sock.on('error', () => {});
    const giveUp = setTimeout(() => sock.destroy(), HELLO_TIMEOUT);

    sock.on('secureConnect', () => {
      // Πριν σταλεί οτιδήποτε: είναι πράγματι ο καθηγητής του classroom.json;
      let teacher = null;
      try { teacher = this._trusted(fingerprint(sock.getPeerX509Certificate().publicKey)); } catch (_) { /* χωρίς πιστοποιητικό */ }
      if (!teacher) {
        this.bad.set(ip, Date.now() + IMPOSTOR_BLOCK);
        this.emit('impostor', { ip });
        sock.destroy();
        return;
      }
      this.pendingTeacher = { name: teacher.name, room: teacher.room };
      sendLine(sock, { type: 'hello', v: PROTOCOL, pin: this.pin, name: this.name, user: this.user, host: this.host });
    });

    sock.on('data', frameReader((msg) => {
      if (msg.type === 'welcome') {
        clearTimeout(giveUp);
        this.teacher = this.pendingTeacher;
        this._set('connected');
        if (this.lastCode) sendLine(sock, this.lastCode);
        if (this.hand) sendLine(sock, { type: 'hand', up: true });
      } else if (msg.type === 'reject') {
        this.stop();
        this._set('rejected', { reason: String(msg.reason || '') });
      } else if (msg.type === 'kick') {
        this.stop();
        this._set('kicked');
      } else if (msg.type === 'hand' && msg.up === false && this.hand) {
        this.hand = false;
        this.emit('status', this.status({ lowered: true }));
      }
    }, () => sock.destroy()));

    sock.on('close', () => {
      clearTimeout(giveUp);
      if (this.sock !== sock) return;
      this.sock = null;
      this.teacher = null;
      if (!this.stopped) this._set('searching');
    });
  }

  sendCode({ file, text, cursor, errors }) {
    this.lastCode = { type: 'code', file, text: clip(text, MAX_TEXT), cursor, errors };
    if (this.state === 'connected') sendLine(this.sock, this.lastCode);
  }

  setHand(up) {
    this.hand = !!up;
    if (this.state === 'connected') sendLine(this.sock, { type: 'hand', up: this.hand });
    this.emit('status', this.status());
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    if (this.udp) { try { this.udp.close(); } catch (_) { /* ήδη κλειστό */ } this.udp = null; }
    if (this.sock) { const s = this.sock; this.sock = null; s.destroy(); }
    this.teacher = null;
    this.hand = false;
    this.state = 'off';
  }

  /** Αποσύνδεση με επιλογή του μαθητή. */
  leave() {
    this.stop();
    this._set('off');
  }
}

module.exports = {
  TeacherServer, StudentClient, loadTrust, buildTrustFile, trustFilePath, lanAddresses, frameReader, newPin,
  DEFAULT_PORT, DISCOVERY_PORT,
};
