const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DATA_DIR = process.env.TRUSTOKEN_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const BRIDGE_SCRIPT = path.join(__dirname, 'trustoken_bridge.py');
const MEETINGS_FILE = path.join(DATA_DIR, 'meetings.json');
const SIGNUP_CODE_FILE = path.join(DATA_DIR, 'signup-code.txt');

const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_PARTICIPANTS = 8;
const MAX_WAITING = 30;
const MAX_CHAT_LENGTH = 4000;
const MAX_MINUTES_LENGTH = 100000;
const MINUTE = 60 * 1000;
const RECONNECT_GRACE_MS = MINUTE; // A dropped participant can return to a locked meeting
// A participant who joined with a token stays only while their client keeps
// reporting it as plugged in. No report within this window removes them.
const TOKEN_LEASE_MS = Number(process.env.TOKEN_LEASE_MS) || 8000;

// How much a participant's USB token proves.
// DETECTED means a device with the right USB ID was reported by their computer,
// which a modified client can fake. VERIFIED is reserved for the day the token's
// chip signs a server challenge: only assessToken() has to change for that.
const ASSURANCE = { VERIFIED: 'verified', DETECTED: 'token-detected', UNVERIFIED: 'unverified' };

function assessToken(tokenPresent) {
  return tokenPresent === true ? ASSURANCE.DETECTED : ASSURANCE.UNVERIFIED;
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// =============================================================================
// BRANDING (per installation)
// =============================================================================
// Each institute sets its own name and logo with set-branding.py, which writes
// data/branding/branding.json and the logo files. Without it, the defaults below
// and the logo in public/assets are used.
const BRANDING_DIR = path.join(DATA_DIR, 'branding');
const BRANDING_DEFAULTS = {
  name: 'de.ci.phe.red. Lab, IIT Bhilai',
  subtitle: 'TrusMeet \u2022 Video meetings with TrusToken check',
  organisation: 'Indian Institute of Technology Bhilai',
  department: 'de.ci.phe.red. Lab'
};
const BRANDING_FILES = { 'logo.png': 'lab-logo.png', 'favicon.png': 'favicon.png', 'logo-pdf.jpg': 'lab-logo-pdf.jpg' };

function loadBranding() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(path.join(BRANDING_DIR, 'branding.json'), 'utf8'));
  } catch {
    // no branding file: defaults
  }
  const pick = (key, max) => (typeof saved[key] === 'string' && saved[key].length <= max ? saved[key] : BRANDING_DEFAULTS[key]);
  return { name: pick('name', 120), subtitle: pick('subtitle', 160), organisation: pick('organisation', 200), department: pick('department', 200) };
}

app.get('/api/branding', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ success: true, ...loadBranding() });
});

app.get('/branding/:file', (req, res) => {
  const fallback = BRANDING_FILES[req.params.file];
  if (!fallback) return res.status(404).end();
  const custom = path.join(BRANDING_DIR, req.params.file);
  res.set('Cache-Control', 'no-cache');
  res.sendFile(fs.existsSync(custom) ? custom : path.join(__dirname, 'public', 'assets', fallback));
});

const certPath = path.join(__dirname, 'server.crt');
const keyPath = path.join(__dirname, 'server.key');
let server;
let isHttps = false;

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app);
  isHttps = true;
} else {
  server = http.createServer(app);
}

// Browsers may only open a meeting socket from a page served by this server.
function allowSameOrigin(req, callback) {
  const { origin, host } = req.headers;
  if (!origin) return callback(null, true);
  try {
    callback(null, new URL(origin).host === host);
  } catch {
    callback(null, false);
  }
}

const socketOptions = { allowRequest: allowSameOrigin, maxHttpBufferSize: 1e6 };
const io = new Server(server, socketOptions);

const activeSessions = new Map(); // token -> { user_id, name, has_token, expiresAt }
const meetings = new Map(); // id -> meeting
const clients = new Map(); // socket.id -> controls for that connection
const tokenLeases = new Map(); // socket.id -> { expiresAt, evict }
const rateBuckets = new Map(); // key -> { count, resetAt }

// =============================================================================
// SIGN-UP CODE, RATE LIMITS, SESSIONS
// =============================================================================

function loadSignupCode() {
  if (process.env.SIGNUP_CODE) return process.env.SIGNUP_CODE;
  try {
    return fs.readFileSync(SIGNUP_CODE_FILE, 'utf8').trim();
  } catch {
    const code = crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(SIGNUP_CODE_FILE, `${code}\n`, { mode: 0o600 });
    return code;
  }
}
const SIGNUP_CODE = loadSignupCode();

function signupCodeMatches(candidate) {
  if (typeof candidate !== 'string') return false;
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(candidate.trim()), digest(SIGNUP_CODE));
}

function overLimit(key, max, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count > max;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Tunnel traffic arrives from loopback, so the real address is in Cloudflare's header.
function clientIp(req) {
  const remote = req.socket.remoteAddress;
  const forwarded = req.get('cf-connecting-ip');
  return LOOPBACK.has(remote) && forwarded ? forwarded : remote;
}

// Audit trail for approvals: where and when each decision came from, as seen
// by this server. Kept with the signature and in a private log file; it is not
// printed on the minutes.
const AUDIT_FILE = path.join(DATA_DIR, 'minutes-audit.log');

function auditInfo(req) {
  const remote = String(req.socket.remoteAddress || '');
  const forwarded = LOOPBACK.has(remote) && req.get('cf-connecting-ip');
  const ip = String(forwarded || remote).replace(/^::ffff:/, '').slice(0, 64);
  const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
  return {
    ip,
    connection: forwarded ? 'Cloudflare link' : (tailscale ? 'Tailscale' : (LOOPBACK.has(remote) ? 'This computer' : 'Direct (campus network)')),
    recorded_at: new Date().toISOString(),
    recorded_by: 'TrusMeet server'
  };
}

function writeAudit(entry) {
  fs.appendFile(AUDIT_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 }, (err) => {
    if (err) console.warn('[audit] Could not write the audit log:', err.message);
  });
}

function createSession(profile) {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const session = { ...profile, expiresAt: Date.now() + SESSION_MS };
  activeSessions.set(sessionToken, session);
  return { sessionToken, ...session };
}

function getSession(token) {
  if (typeof token !== 'string') return null;
  const session = activeSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return null;
  }
  return session;
}

function requireSession(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ success: false, error: 'Please log in first.' });
  }
  req.authSession = session;
  req.authToken = token;
  next();
}

function sweepSessions() {
  const now = Date.now();
  for (const [token, session] of activeSessions) {
    if (now > session.expiresAt) activeSessions.delete(token);
  }
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
  for (const client of clients.values()) {
    client.endIfLoggedOut();
  }
}
setInterval(sweepSessions, MINUTE);

setInterval(() => {
  const now = Date.now();
  for (const lease of tokenLeases.values()) {
    if (now > lease.expiresAt) {
      lease.evict('No TrusToken presence report was received.');
    }
  }
}, 1000);

// Accounts, passwords and signing keys live behind the Python bridge. Everything
// goes over stdin so that passwords never appear on a command line.
function runBridge(command, payload = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [BRIDGE_SCRIPT, command]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.stdin.on('error', () => {});
    proc.on('error', reject);
    proc.on('close', () => {
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(stderr || `Bridge command ${command} returned no result`));
      }
    });
    proc.stdin.end(JSON.stringify(payload));
  });
}

function bridgeFailure(res, err) {
  console.error('[Bridge]', err.message);
  res.status(500).json({ success: false, error: 'The server could not complete that request.' });
}

// =============================================================================
// MEETING STORE
// =============================================================================

const MINUTES_TEXT_FIELDS = {
  title: 200, date: 10, startTime: 5, endTime: 5, timeZone: 40, venue: 200, chair: 200,
  minuteTaker: 200, present: 5000, absent: 5000, agenda: 20000, discussion: 50000,
  decisions: 20000, nextMeeting: 500,
  // Indian official format
  organisation: 200, department: 200, refNo: 100, chairDesignation: 200,
  minuteTakerDesignation: 200, copyTo: 2000
};

// Returns the cleaned value, or undefined if the field or value isn't allowed.
function cleanMinutesField(field, value) {
  if (Object.prototype.hasOwnProperty.call(MINUTES_TEXT_FIELDS, field)) {
    return typeof value === 'string' && value.length <= MINUTES_TEXT_FIELDS[field] ? value : undefined;
  }
  if (field === 'actions') {
    if (!Array.isArray(value) || value.length > 100) return undefined;
    const rows = value.map((row) => ({
      task: row && typeof row.task === 'string' ? row.task.slice(0, 1000) : '',
      owner: row && typeof row.owner === 'string' ? row.owner.slice(0, 200) : '',
      due: row && typeof row.due === 'string' ? row.due.slice(0, 10) : ''
    }));
    return rows;
  }
  return undefined;
}

function hydrateMeeting(saved) {
  return {
    ...saved,
    admitted: new Set(saved.admitted || []),
    removed: new Set(saved.removed || []),
    droppedUntil: new Map(), // user_id -> time their reconnect grace ends
    members: new Map(),
    waiting: new Map(),
    minutesDoc: {}, // structured minutes, edited together field by field
    attendees: new Map(), // user_id -> name of everyone admitted to this meeting
    signatures: []
  };
}

function loadMeetings() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(MEETINGS_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw new Error(`Cannot read ${MEETINGS_FILE}: ${err.message}`);
  }
  for (const meeting of saved) {
    meetings.set(meeting.id, hydrateMeeting(meeting));
  }
}

function saveMeetings() {
  const records = [...meetings.values()].map((m) => ({
    id: m.id,
    name: m.name,
    hostUserId: m.hostUserId,
    hostName: m.hostName,
    createdAt: m.createdAt,
    endedAt: m.endedAt,
    isLocked: m.isLocked,
    admitted: [...m.admitted],
    removed: [...m.removed]
  }));
  const temporary = `${MEETINGS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(records, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, MEETINGS_FILE);
}

function emitToHosts(room, event, payload) {
  for (const [socketId, member] of room.members) {
    if (member.user_id === room.hostUserId) io.to(socketId).emit(event, payload);
  }
}

// =============================================================================
// ACCOUNTS
// =============================================================================

app.post('/api/auth/register', async (req, res) => {
  if (overLimit(`register:${clientIp(req)}`, 10, 60 * MINUTE)) {
    return res.status(429).json({ success: false, error: 'Too many sign-up attempts. Try again later.' });
  }
  const { username, name, password, signupCode } = req.body || {};
  if (!signupCodeMatches(signupCode)) {
    return res.status(403).json({ success: false, error: 'That sign-up code is not correct.' });
  }
  try {
    const result = await runBridge('register', { username, name, password });
    if (!result.success) return res.status(400).json(result);
    res.json({ success: true, session: createSession(result.profile) });
  } catch (err) {
    bridgeFailure(res, err);
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (overLimit(`login:${clientIp(req)}`, 30, 15 * MINUTE)) {
    return res.status(429).json({ success: false, error: 'Too many login attempts. Try again later.' });
  }
  const { username, password } = req.body || {};
  try {
    const result = await runBridge('login', { username, password });
    if (!result.success) return res.status(401).json(result);
    res.json({ success: true, session: createSession(result.profile) });
  } catch (err) {
    bridgeFailure(res, err);
  }
});

app.post('/api/auth/logout', requireSession, (req, res) => {
  activeSessions.delete(req.authToken);
  sweepSessions();
  res.json({ success: true });
});

app.get('/api/auth/me', requireSession, (req, res) => {
  res.json({ success: true, session: { sessionToken: req.authToken, ...req.authSession } });
});

app.post('/api/profile/token', requireSession, async (req, res) => {
  const { hasToken } = req.body || {};
  if (typeof hasToken !== 'boolean') {
    return res.status(400).json({ success: false, error: 'hasToken must be true or false' });
  }
  try {
    const result = await runBridge('set-token-choice', { username: req.authSession.user_id, has_token: hasToken });
    if (!result.success) return res.status(400).json(result);
    req.authSession.has_token = hasToken;
    res.json({ success: true, has_token: hasToken });
  } catch (err) {
    bridgeFailure(res, err);
  }
});

app.get('/api/trustoken/hardware', requireSession, async (req, res) => {
  try {
    res.json({ success: true, data: await runBridge('hardware-status'), isHttps });
  } catch (err) {
    bridgeFailure(res, err);
  }
});

// =============================================================================
// RELAY (TURN) SERVERS
// =============================================================================
// Video goes straight between browsers. When two networks block that, a relay
// (Metered's TURN service) carries it instead; the call stays encrypted end to end.
// Configure with METERED_DOMAIN + METERED_API_KEY, or data/metered.json
// ({ "domain": "yourapp.metered.live", "apiKey": "..." }). Without it, only STUN is used.

const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' }
];
const RELAY_CACHE_MS = 10 * MINUTE;
let relayCache = { servers: null, expiresAt: 0 };

function loadMeteredConfig() {
  let domain = process.env.METERED_DOMAIN;
  let apiKey = process.env.METERED_API_KEY;
  if (!domain || !apiKey) {
    try {
      const file = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'metered.json'), 'utf8'));
      // Fixed passwords copied from the dashboard ("Show ICE Servers Array") also work.
      if (!apiKey && Array.isArray(file.iceServers)) {
        const fixed = file.iceServers.map(validIceServer).filter(Boolean)
          .filter((x) => x.username && x.credential && x.urls.some((u) => !u.startsWith('stun:')));
        if (fixed.length) return { domain: file.domain || 'fixed passwords', fixed };
        console.warn('[relay] metered.json has no usable TURN entries.');
        return null;
      }
      domain = domain || file.domain;
      apiKey = apiKey || file.apiKey;
    } catch {
      return null;
    }
  }
  domain = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  apiKey = String(apiKey || '').trim();
  if (!/^[a-z0-9-]{1,63}\.metered\.live$/.test(domain) || !/^[\w-]{8,200}$/.test(apiKey)) {
    console.warn('[relay] Metered settings ignored: the domain must look like yourapp.metered.live.');
    return null;
  }
  return { domain, apiKey };
}
const METERED = loadMeteredConfig();

function validIceServer(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const urls = (Array.isArray(entry.urls) ? entry.urls : [entry.urls])
    .filter((u) => typeof u === 'string' && /^(stun|turn|turns):[\w.:?=&\-[\]]+$/.test(u));
  if (!urls.length) return null;
  const server = { urls };
  if (typeof entry.username === 'string') server.username = entry.username;
  if (typeof entry.credential === 'string') server.credential = entry.credential;
  return server;
}

// Our own coturn (start-turn.sh writes data/turn.json). Passwords are made per
// login and expire, using coturn's shared-secret scheme (use-auth-secret).
const LOCAL_TURN_TTL_S = 12 * 60 * 60;
function loadLocalTurn() {
  let urls = process.env.TURN_URLS ? process.env.TURN_URLS.split(',') : null;
  let secret = process.env.TURN_SECRET;
  if (!urls || !secret) {
    try {
      const file = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'turn.json'), 'utf8'));
      urls = urls || file.urls;
      secret = secret || file.secret;
    } catch {
      return null;
    }
  }
  urls = (Array.isArray(urls) ? urls : []).map((u) => String(u).trim()).filter((u) => /^turns?:[\w.:?=\-[\]]+$/.test(u));
  if (!urls.length || typeof secret !== 'string' || secret.length < 16) {
    console.warn('[relay] Local TURN settings ignored: they need turn: addresses and a secret of 16+ characters.');
    return null;
  }
  return { urls, secret };
}
const LOCAL_TURN = loadLocalTurn();

function localTurnServer(userId) {
  if (!LOCAL_TURN) return null;
  const username = `${Math.floor(Date.now() / 1000) + LOCAL_TURN_TTL_S}:${String(userId).replace(/:/g, '')}`;
  const credential = crypto.createHmac('sha1', LOCAL_TURN.secret).update(username).digest('base64');
  return { urls: LOCAL_TURN.urls, username, credential };
}

async function relayServers() {
  if (!METERED) return null;
  if (METERED.fixed) return METERED.fixed;
  if (relayCache.servers && Date.now() < relayCache.expiresAt) return relayCache.servers;
  const url = `https://${METERED.domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED.apiKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Metered answered ${res.status}`);
  const list = await res.json();
  const servers = (Array.isArray(list) ? list : []).map(validIceServer).filter(Boolean)
    .filter((s) => s.urls.some((u) => !u.startsWith('stun:')));
  if (!servers.length) throw new Error('Metered returned no relay servers');
  relayCache = { servers, expiresAt: Date.now() + RELAY_CACHE_MS };
  return servers;
}

app.get('/api/ice-servers', requireSession, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (overLimit(`ice:${req.authSession.user_id}`, 60, 15 * MINUTE)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Try again later.' });
  }
  const relays = [];
  const local = localTurnServer(req.authSession.user_id);
  if (local) relays.push(local);
  try {
    relays.push(...((await relayServers()) || []));
  } catch (err) {
    console.warn('[relay] Could not get Metered relay servers:', err.message);
  }
  res.json({ success: true, relay: relays.length > 0, iceServers: [...STUN_SERVERS, ...relays] });
});

// =============================================================================
// MEETINGS AND SIGNED MINUTES
// =============================================================================

app.post('/api/meetings', requireSession, (req, res) => {
  if (overLimit(`meetings:${req.authSession.user_id}`, 30, 60 * MINUTE)) {
    return res.status(429).json({ success: false, error: 'Too many new meetings. Try again later.' });
  }
  const session = req.authSession;
  const id = crypto.randomBytes(16).toString('base64url');
  const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const meeting = hydrateMeeting({
    id,
    name: rawName.slice(0, 120) || `${session.name}'s Meeting`,
    hostUserId: session.user_id,
    hostName: session.name,
    createdAt: new Date().toISOString(),
    endedAt: null,
    isLocked: false
  });
  meetings.set(id, meeting);
  saveMeetings();
  res.json({ success: true, meeting: { id, name: meeting.name, hostName: meeting.hostName, link: `/?room=${id}` } });
});

app.get('/api/meetings/mine', requireSession, (req, res) => {
  const mine = [...meetings.values()]
    .filter((m) => m.hostUserId === req.authSession.user_id && !m.endedAt)
    .map((m) => ({ id: m.id, name: m.name, createdAt: m.createdAt, memberCount: m.members.size, link: `/?room=${m.id}` }));
  res.json({ success: true, meetings: mine });
});

app.post('/api/minutes/sign', requireSession, async (req, res) => {
  const session = req.authSession;
  if (overLimit(`sign:${session.user_id}`, 30, 15 * MINUTE)) {
    return res.status(429).json({ success: false, error: 'Too many signing attempts. Try again later.' });
  }
  const { roomId, password, minutesText, decision = 'approved', reason = '' } = req.body || {};
  if (typeof roomId !== 'string' || typeof password !== 'string' || typeof minutesText !== 'string'
    || !minutesText || minutesText.length > MAX_MINUTES_LENGTH) {
    return res.status(400).json({ success: false, error: 'roomId, password and minutesText are required' });
  }
  if (!['approved', 'not_approved'].includes(decision) || typeof reason !== 'string' || reason.length > 1000) {
    return res.status(400).json({ success: false, error: 'decision must be approved or not_approved, with a reason of up to 1000 characters' });
  }
  const room = meetings.get(roomId);
  const member = room && [...room.members.values()].find((m) => m.user_id === session.user_id);
  if (!member) {
    return res.status(403).json({ success: false, error: 'You can only sign minutes for a meeting you are in' });
  }
  try {
    const receipt = await runBridge('sign-minutes', {
      username: session.user_id,
      password,
      minutes_text: minutesText,
      meeting_id: roomId,
      assurance: member.assurance,
      decision,
      reason
    });
    if (!receipt.success) return res.status(401).json(receipt);
    // The exact signed text is kept with each signature, so anyone in the
    // meeting can later download the signed minutes as a PDF.
    receipt.minutes_text = minutesText;
    receipt.user_id = session.user_id;
    receipt.audit = auditInfo(req);
    writeAudit({
      ...receipt.audit,
      meeting_id: roomId,
      user_id: session.user_id,
      name: receipt.signed_by,
      decision: receipt.decision,
      minutes_sha256: receipt.document_sha256,
      signature_sha256: crypto.createHash('sha256').update(receipt.signature_b64).digest('hex')
    });
    room.signatures.push(receipt);
    io.to(roomId).emit('minutes-signed-broadcast', { roomId, signatureReceipt: receipt, minutesText });
    res.json(receipt);
  } catch (err) {
    bridgeFailure(res, err);
  }
});

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ success: false, error: 'Invalid request.' });
});

// =============================================================================
// WEBRTC SIGNALING, WAITING ROOM & COLLABORATION (SOCKET.IO)
// =============================================================================

io.on('connection', (socket) => {
  let currentRoom = null;
  let waitingRoom = null;
  let currentUser = null;
  let currentSessionToken = null;

  // A malformed message must never be able to bring the server down.
  function on(event, handler) {
    socket.on(event, (payload) => {
      try {
        handler(payload && typeof payload === 'object' ? payload : {});
      } catch (err) {
        console.error(`[Socket] ${event} failed:`, err.message);
      }
    });
  }

  const hostedRoom = () => {
    const room = currentRoom && meetings.get(currentRoom);
    return room && room.hostUserId === currentUser.user_id ? room : null;
  };

  function leaveCurrentRoom(reason) {
    if (!currentRoom) return;
    const roomId = currentRoom;
    currentRoom = null;
    tokenLeases.delete(socket.id);
    const room = meetings.get(roomId);
    if (room) room.members.delete(socket.id);
    socket.to(roomId).emit('user-left', {
      peerId: socket.id,
      userName: currentUser ? currentUser.name : 'Member',
      reason
    });
    socket.leave(roomId);
  }

  function leaveWaitingRoom() {
    if (!waitingRoom) return;
    const room = meetings.get(waitingRoom);
    waitingRoom = null;
    if (room) {
      room.waiting.delete(socket.id);
      emitToHosts(room, 'admission-resolved', { peerId: socket.id });
    }
  }

  // Being taken out for a missing token does not end the login. The person can
  // plug it back in, or ask the host to accept them as unverified.
  function evictForTokenLoss(message) {
    if (!currentRoom) return;
    const roomId = currentRoom;
    leaveCurrentRoom('token-removed');
    socket.emit('token-removed', { roomId, message });
  }

  function enterMeeting(room) {
    waitingRoom = null;
    currentRoom = room.id;
    if (currentUser.assurance === ASSURANCE.DETECTED) {
      tokenLeases.set(socket.id, { expiresAt: Date.now() + TOKEN_LEASE_MS, evict: evictForTokenLoss });
    }

    const isHost = room.hostUserId === currentUser.user_id;
    const existingPeers = [...room.members].map(([peerId, user]) => ({ peerId, user }));

    socket.join(room.id);
    room.members.set(socket.id, currentUser);
    room.attendees.set(currentUser.user_id, currentUser.name);
    socket.to(room.id).emit('user-joined', { peerId: socket.id, user: currentUser });
    socket.emit('room-joined-success', {
      roomId: room.id,
      roomName: room.name,
      isHost,
      isLocked: room.isLocked,
      assurance: currentUser.assurance,
      existingPeers,
      minutesDoc: room.minutesDoc,
      attendees: [...room.attendees].map(([user_id, name]) => ({ user_id, name })),
      signatures: room.signatures,
      waiting: isHost ? [...room.waiting].map(([peerId, user]) => ({
        peerId, user, removedEarlier: room.removed.has(user.user_id)
      })) : []
    });
  }

  function placeInWaitingRoom(room) {
    if (room.waiting.size >= MAX_WAITING) {
      socket.emit('room-error', { message: 'Too many people are waiting for this meeting. Try again shortly.' });
      return;
    }
    waitingRoom = room.id;
    room.waiting.set(socket.id, currentUser);
    const removedEarlier = room.removed.has(currentUser.user_id);
    socket.emit('waiting-for-host', { roomId: room.id, roomName: room.name, removedEarlier });
    emitToHosts(room, 'admission-request', { peerId: socket.id, user: currentUser, removedEarlier });
  }

  clients.set(socket.id, {
    userId: () => currentUser && currentUser.user_id,
    admit() {
      const room = meetings.get(waitingRoom);
      room.waiting.delete(socket.id);
      emitToHosts(room, 'admission-resolved', { peerId: socket.id });
      enterMeeting(room);
    },
    decline() {
      const roomId = waitingRoom;
      leaveWaitingRoom();
      socket.emit('admission-declined', { roomId, message: 'The host did not accept your request. You can ask again.' });
    },
    removeByHost() {
      const roomId = currentRoom;
      leaveCurrentRoom('removed-by-host');
      socket.emit('removed-by-host', { roomId, message: 'The host removed you from this meeting. You can ask the host to let you back in.' });
    },
    meetingEnded() {
      const roomId = currentRoom || waitingRoom;
      leaveCurrentRoom('meeting-ended');
      waitingRoom = null;
      socket.emit('meeting-ended', { roomId, message: 'The host ended this meeting.' });
    },
    endIfLoggedOut() {
      if ((currentRoom || waitingRoom) && !getSession(currentSessionToken)) {
        leaveCurrentRoom('logged-out');
        leaveWaitingRoom();
        socket.emit('room-error', { message: 'Your login has expired. Please log in again.' });
      }
    }
  });

  on('join-room', ({ roomId, sessionToken, tokenPresent }) => {
    const refuse = (message) => socket.emit('room-error', { message });

    if (typeof roomId !== 'string' || currentRoom || waitingRoom) {
      return refuse('Could not join this meeting.');
    }
    const session = getSession(sessionToken);
    if (!session) return refuse('Your login has expired. Please log in again.');

    const room = meetings.get(roomId);
    if (!room || room.endedAt) return refuse('This meeting does not exist or has ended.');

    // The identity comes from the server's session, never from the client.
    const user = { user_id: session.user_id, name: session.name, assurance: assessToken(tokenPresent) };
    const isHost = room.hostUserId === user.user_id;

    const justDropped = Date.now() < (room.droppedUntil.get(user.user_id) || 0);
    if (room.isLocked && !isHost && !justDropped) return refuse('The host has locked this meeting.');

    currentUser = user;
    currentSessionToken = sessionToken;

    const acceptedAlready = !room.removed.has(user.user_id)
      && (user.assurance !== ASSURANCE.UNVERIFIED || room.admitted.has(user.user_id));

    if (!isHost && !acceptedAlready) return placeInWaitingRoom(room);
    if (room.members.size >= MAX_PARTICIPANTS) return refuse(`This meeting is full (${MAX_PARTICIPANTS} people).`);
    enterMeeting(room);
  });

  on('admission-decision', ({ peerId, accept }) => {
    const room = hostedRoom();
    if (!room) {
      return socket.emit('host-action-denied', { message: 'Only the meeting host can do that.' });
    }
    if (typeof peerId !== 'string' || !room.waiting.has(peerId)) return;

    const applicant = clients.get(peerId);
    if (accept !== true) return applicant.decline();

    if (room.members.size >= MAX_PARTICIPANTS) {
      return socket.emit('host-action-denied', { message: `This meeting is full (${MAX_PARTICIPANTS} people).` });
    }
    const applicantId = room.waiting.get(peerId).user_id;
    room.admitted.add(applicantId);
    room.removed.delete(applicantId);
    saveMeetings();
    applicant.admit();
  });

  // WebRTC Signaling: Offer, Answer, ICE Candidate
  on('signal', ({ targetPeerId, signalData }) => {
    const room = currentRoom && meetings.get(currentRoom);
    if (!room || typeof targetPeerId !== 'string' || !room.members.has(targetPeerId)) return;
    if (!signalData || typeof signalData !== 'object') return;
    io.to(targetPeerId).emit('signal', { fromPeerId: socket.id, signalData, fromUser: currentUser });
  });

  // Real-time Voice Relay Channel
  on('voice-packet', ({ audioData, mimeType }) => {
    if (!currentRoom || typeof audioData !== 'string') return;
    socket.to(currentRoom).emit('voice-packet-broadcast', {
      senderId: socket.id,
      senderName: currentUser.name,
      audioData,
      mimeType: typeof mimeType === 'string' && /^audio\/[a-z0-9.;=+ -]{1,60}$/i.test(mimeType) ? mimeType : undefined
    });
  });

  on('toggle-media-state', ({ type, enabled }) => {
    if (!currentRoom || !['audio', 'video', 'screen', 'recording'].includes(type) || typeof enabled !== 'boolean') return;
    socket.to(currentRoom).emit('peer-media-state-changed', { peerId: socket.id, type, enabled });
  });

  on('chat-message', ({ text }) => {
    if (!currentRoom || typeof text !== 'string' || !text.trim() || text.length > MAX_CHAT_LENGTH) return;
    io.to(currentRoom).emit('chat-broadcast', {
      id: crypto.randomUUID(),
      senderId: socket.id,
      senderName: currentUser.name,
      assurance: currentUser.assurance,
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // One field of the minutes at a time, so people editing different sections
  // don't overwrite each other.
  on('minutes-patch', ({ field, value }) => {
    const room = currentRoom && meetings.get(currentRoom);
    if (!room) return;
    const clean = cleanMinutesField(field, value);
    if (clean === undefined) return;
    const next = { ...room.minutesDoc, [field]: clean };
    if (JSON.stringify(next).length > MAX_MINUTES_LENGTH) return;
    room.minutesDoc = next;
    socket.to(currentRoom).emit('minutes-patch', { field, value: clean });
  });

  on('token-presence', ({ present }) => {
    const lease = tokenLeases.get(socket.id);
    if (!lease) return;
    if (present === true) {
      lease.expiresAt = Date.now() + TOKEN_LEASE_MS;
    } else {
      evictForTokenLoss('The TrusToken was unplugged.');
    }
  });

  on('host-action', ({ action, targetPeerId }) => {
    if (!currentRoom) return;
    const room = hostedRoom();
    if (!room) {
      return socket.emit('host-action-denied', { message: 'Only the meeting host can do that.' });
    }

    if (action === 'lock-room') {
      room.isLocked = !room.isLocked;
      saveMeetings();
      io.to(room.id).emit('room-lock-changed', { isLocked: room.isLocked });
    } else if (action === 'mute-peer' && room.members.has(targetPeerId)) {
      io.to(targetPeerId).emit('force-mute');
    } else if (action === 'ask-unmute' && room.members.has(targetPeerId)) {
      // A request only: nobody's microphone is turned on without their consent.
      io.to(targetPeerId).emit('unmute-request');
    } else if (action === 'kick-peer' && room.members.has(targetPeerId)) {
      const targetId = room.members.get(targetPeerId).user_id;
      if (targetId === room.hostUserId) return;
      room.removed.add(targetId);
      room.admitted.delete(targetId);
      saveMeetings();
      // Every tab that person has open in this meeting goes.
      [...room.members].filter(([, user]) => user.user_id === targetId)
        .forEach(([peerId]) => clients.get(peerId).removeByHost());
    } else if (action === 'end-meeting') {
      room.endedAt = new Date().toISOString();
      saveMeetings();
      [...room.members.keys(), ...room.waiting.keys()].forEach((peerId) => clients.get(peerId).meetingEnded());
      room.waiting.clear();
    }
  });

  socket.on('disconnect', () => {
    const droppedFrom = currentRoom && meetings.get(currentRoom);
    if (droppedFrom) droppedFrom.droppedUntil.set(currentUser.user_id, Date.now() + RECONNECT_GRACE_MS);
    leaveCurrentRoom();
    leaveWaitingRoom();
    clients.delete(socket.id);
  });
});

// =============================================================================
// STARTUP
// =============================================================================

const PORT = process.env.PORT || 8443;
const HTTP_PORT = process.env.HTTP_PORT || 8080;

async function start() {
  const init = await runBridge('init');
  if (!init.success) throw new Error(init.error);
  loadMeetings();

  // Plain HTTP stays on this computer (for the public tunnel), so passwords
  // are never sent unencrypted across the network.
  server.listen(PORT, isHttps ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`TrusMeet running at ${isHttps ? 'https' : 'http'}://localhost:${PORT}`);
    const relayNames = [LOCAL_TURN && `this computer (${LOCAL_TURN.urls[0]})`, METERED && `Metered (${METERED.domain})`].filter(Boolean);
    console.log(relayNames.length ? `Relay (TURN): ${relayNames.join(' + ')}` : 'Relay (TURN): not set up, so video may not connect across some networks');
    console.log(process.env.SIGNUP_CODE
      ? 'Sign-up code: set by SIGNUP_CODE'
      : `Sign-up code: see ${SIGNUP_CODE_FILE}`);
  });

  if (isHttps) {
    const httpServer = http.createServer(app);
    io.attach(httpServer, socketOptions);
    httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
      console.log(`Local HTTP (for the tunnel): http://localhost:${HTTP_PORT}`);
    });
  }
}

start().catch((err) => {
  console.error('Could not start:', err.message);
  process.exit(1);
});
