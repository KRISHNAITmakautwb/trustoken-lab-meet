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

function hydrateMeeting(saved) {
  return {
    ...saved,
    admitted: new Set(saved.admitted || []),
    removed: new Set(saved.removed || []),
    droppedUntil: new Map(), // user_id -> time their reconnect grace ends
    members: new Map(),
    waiting: new Map(),
    minutes: '### Meeting Minutes\n\n',
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
  const { roomId, password, minutesText } = req.body || {};
  if (typeof roomId !== 'string' || typeof password !== 'string' || typeof minutesText !== 'string'
    || !minutesText || minutesText.length > MAX_MINUTES_LENGTH) {
    return res.status(400).json({ success: false, error: 'roomId, password and minutesText are required' });
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
      assurance: member.assurance
    });
    if (!receipt.success) return res.status(401).json(receipt);
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
    socket.to(room.id).emit('user-joined', { peerId: socket.id, user: currentUser });
    socket.emit('room-joined-success', {
      roomId: room.id,
      roomName: room.name,
      isHost,
      isLocked: room.isLocked,
      assurance: currentUser.assurance,
      existingPeers,
      minutes: room.minutes,
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
    if (!currentRoom || !['audio', 'video', 'screen'].includes(type) || typeof enabled !== 'boolean') return;
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

  on('minutes-update', ({ text }) => {
    const room = currentRoom && meetings.get(currentRoom);
    if (!room || typeof text !== 'string' || text.length > MAX_MINUTES_LENGTH) return;
    room.minutes = text;
    socket.to(currentRoom).emit('minutes-broadcast', { text });
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
