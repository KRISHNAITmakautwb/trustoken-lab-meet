const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const HTTP_PORT = 18080;
const AGENT_PORT = 18765;
const LEASE_MS = 2000;
const SIGNUP_CODE = 'test-signup-code';
const PASSWORD = 'correct-horse-battery';
const BASE = `http://127.0.0.1:${HTTP_PORT}`;
const AGENT = `http://127.0.0.1:${AGENT_PORT}/status`;

let server;
let agent;
let sysfs;
let dataDir;
let serverEnv;
const sockets = [];
let userCounter = 0;
let ipCounter = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function once(socket, event, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function waitForHttp(url) {
  for (let i = 0; i < 300; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`${url} did not start`);
}

function startServer() {
  server = spawn('node', ['server.js'], { cwd: ROOT, env: serverEnv, stdio: 'ignore' });
  return waitForHttp(BASE);
}

async function connect(options = {}) {
  const socket = io(BASE, { transports: ['websocket'], reconnection: false, ...options });
  sockets.push(socket);
  await once(socket, 'connect');
  return socket;
}

// Each call looks like a different computer, unless a test asks for a fixed address.
function request(url, { method = 'POST', body, token, ip } = {}) {
  ipCounter += 1;
  const headers = { 'CF-Connecting-IP': ip || `10.1.${Math.floor(ipCounter / 250)}.${ipCounter % 250}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const post = (url, body, token) => request(url, { body, token }).then((r) => r.json());

function bridge(args, input = '') {
  return spawnSync('python3', ['trustoken_bridge.py', ...args], { cwd: ROOT, env: serverEnv, input, encoding: 'utf8' });
}

async function newUser(label = 'user') {
  userCounter += 1;
  const username = `${label}${userCounter}`;
  const name = `${label} Person ${userCounter}`;
  const { session } = await post('/api/auth/register', { username, name, password: PASSWORD, signupCode: SIGNUP_CODE });
  return { username, name, token: session.sessionToken };
}

async function newMeeting(host, name = 'Test Meeting') {
  return (await post('/api/meetings', { name }, host.token)).meeting;
}

async function joinDirect(roomId, account, tokenPresent = true) {
  const socket = await connect();
  const joined = once(socket, 'room-joined-success');
  socket.emit('join-room', { roomId, sessionToken: account.token, tokenPresent });
  return { socket, account, joined: await joined };
}

async function joinWaiting(roomId, account, host) {
  const socket = await connect();
  const request = host ? once(host.socket, 'admission-request') : null;
  const waiting = once(socket, 'waiting-for-host');
  socket.emit('join-room', { roomId, sessionToken: account.token, tokenPresent: false });
  return { socket, account, waiting: await waiting, request: request ? await request : null };
}

// A host and a meeting they are already in, on an unverified connection (no lease to keep up).
async function hostedMeeting() {
  const account = await newUser('host');
  const meeting = await newMeeting(account);
  const host = await joinDirect(meeting.id, account, false);
  return { meeting, host };
}

function addFakeToken() {
  const dir = path.join(sysfs, '1-2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'idVendor'), '288d\n');
  fs.writeFileSync(path.join(dir, 'idProduct'), '0040\n');
}

before(async () => {
  // A throwaway data folder, so tests never read or change real accounts and keys.
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustoken-data-'));
  serverEnv = {
    ...process.env,
    TRUSTOKEN_DATA_DIR: dataDir,
    SIGNUP_CODE,
    PORT: '18443',
    HTTP_PORT: String(HTTP_PORT),
    TOKEN_LEASE_MS: String(LEASE_MS)
  };
  await startServer();

  sysfs = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-usb-'));
  agent = spawn('python3', ['trustoken_agent.py', '--port', String(AGENT_PORT), '--sysfs-root', sysfs], {
    cwd: ROOT,
    stdio: 'ignore'
  });
  await waitForHttp(AGENT);
});

after(() => {
  sockets.forEach((s) => s.close());
  server.kill();
  agent.kill();
  fs.rmSync(sysfs, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

test('a fresh install has no fixed users', async () => {
  const res = await request('/api/auth/login', { body: { username: 'krishna_saha', password: PASSWORD } });
  assert.strictEqual(res.status, 401);
  const count = spawnSync('python3', ['-c', `import sqlite3; print(sqlite3.connect('${dataDir}/trusmeet.db').execute('select count(*) from users').fetchone()[0])`], { encoding: 'utf8' });
  assert.strictEqual(count.stdout.trim(), '0');
  assert.strictEqual(fs.readFileSync(path.join(ROOT, 'trustoken_bridge.py'), 'utf8').includes('dhiman_saha'), false);
});

test('signing up needs the right code, a valid username and a long password', async () => {
  const details = { username: 'newperson', name: 'New Person', password: PASSWORD, signupCode: SIGNUP_CODE };

  assert.strictEqual((await request('/api/auth/register', { body: { ...details, signupCode: 'wrong' } })).status, 403);
  assert.strictEqual((await request('/api/auth/register', { body: { ...details, password: 'short' } })).status, 400);
  assert.strictEqual((await request('/api/auth/register', { body: { ...details, username: 'a b' } })).status, 400);

  const created = await post('/api/auth/register', details);
  assert.strictEqual(created.session.user_id, 'newperson');
  assert.strictEqual(created.session.has_token, null);

  assert.match((await post('/api/auth/register', details)).error, /taken/);
});

test('a new profile can log in, and passwords are stored only as salted hashes', async () => {
  const a = await newUser('hash');
  const login = await post('/api/auth/login', { username: a.username, password: PASSWORD });
  assert.strictEqual(login.session.name, a.name);

  const dbFile = path.join(dataDir, 'trusmeet.db');
  assert.strictEqual(fs.readFileSync(dbFile).includes(PASSWORD), false);
  assert.strictEqual(fs.statSync(dbFile).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.join(dataDir, 'lab_ca.key')).mode & 0o777, 0o600);
});

test('five wrong passwords lock an account temporarily, and parallel guesses cannot exceed that', async () => {
  const a = await newUser('lock');
  await Promise.all(Array.from({ length: 12 }, () => post('/api/auth/login', { username: a.username, password: 'wrong-password-1' })));

  const blocked = await post('/api/auth/login', { username: a.username, password: PASSWORD });
  assert.match(blocked.error, /15 minutes/);

  spawnSync('python3', ['-c', `import sqlite3; c=sqlite3.connect('${dataDir}/trusmeet.db'); c.execute("update users set locked_until=0 where username='${a.username}'"); c.commit()`]);
  const later = await post('/api/auth/login', { username: a.username, password: PASSWORD });
  assert.strictEqual(later.success, true);
});

test('wrong username and wrong password give the same answer', async () => {
  const a = await newUser('same');
  const wrongPassword = await post('/api/auth/login', { username: a.username, password: 'wrong-password-1' });
  const noUser = await post('/api/auth/login', { username: 'nobody-here', password: 'wrong-password-1' });
  assert.strictEqual(wrongPassword.error, noUser.error);
});

test('repeated logins from one address are rate limited', async () => {
  let last;
  for (let i = 0; i < 31; i++) {
    last = await request('/api/auth/login', { body: {}, ip: '10.200.200.200' });
  }
  assert.strictEqual(last.status, 429);
});

test('logging out ends the session', async () => {
  const a = await newUser('bye');
  assert.strictEqual((await request('/api/auth/me', { method: 'GET', token: a.token })).status, 200);
  await post('/api/auth/logout', {}, a.token);
  assert.strictEqual((await request('/api/auth/me', { method: 'GET', token: a.token })).status, 401);
});

test('the USB token answer is saved on the profile', async () => {
  const a = await newUser('choice');
  await post('/api/profile/token', { hasToken: true }, a.token);
  const login = await post('/api/auth/login', { username: a.username, password: PASSWORD });
  assert.strictEqual(login.session.has_token, true);
});

test('private data needs a login, and the old public lists are gone', async () => {
  assert.strictEqual((await request('/api/trustoken/hardware', { method: 'GET' })).status, 401);
  assert.strictEqual((await request('/api/meetings/mine', { method: 'GET' })).status, 401);
  assert.strictEqual((await request('/api/meetings', { body: { name: 'x' } })).status, 401);
  assert.strictEqual((await request('/api/trustoken/tokens', { method: 'GET' })).status, 404);
  assert.strictEqual((await request('/api/rooms', { method: 'GET' })).status, 404);
});

test('the admin reset issues a new password and clears a lock', async () => {
  const a = await newUser('reset');
  const result = JSON.parse(bridge(['admin-reset', a.username]).stdout);
  assert.strictEqual(result.success, true);
  const login = await post('/api/auth/login', { username: a.username, password: result.temporary_password });
  assert.strictEqual(login.success, true);
  const old = await post('/api/auth/login', { username: a.username, password: PASSWORD });
  assert.strictEqual(old.success, false);
});

// ---------------------------------------------------------------------------
// Meetings and the waiting room
// ---------------------------------------------------------------------------

test('anyone with a profile can host, and the link is long and random', async () => {
  const a = await newUser('anyhost');
  const first = await newMeeting(a);
  const second = await newMeeting(a);
  assert.match(first.id, /^[A-Za-z0-9_-]{22}$/);
  assert.notStrictEqual(first.id, second.id);
  assert.strictEqual(first.link, `/?room=${first.id}`);
  assert.strictEqual(first.hostName, a.name);

  const list = await (await request('/api/meetings/mine', { method: 'GET', token: a.token })).json();
  assert.strictEqual(list.meetings.length, 2);

  const other = await newUser('other');
  const theirs = await (await request('/api/meetings/mine', { method: 'GET', token: other.token })).json();
  assert.strictEqual(theirs.meetings.length, 0);
});

test('a meeting cannot be conjured by joining an unknown link', async () => {
  const a = await newUser('conjure');
  const socket = await connect();
  const error = once(socket, 'room-error');
  socket.emit('join-room', { roomId: 'made-up-room', sessionToken: a.token, tokenPresent: true });
  assert.match((await error).message, /does not exist/);
});

test('joining without a valid session is refused', async () => {
  const { meeting } = await hostedMeeting();
  const socket = await connect();
  const error = once(socket, 'room-error');
  socket.emit('join-room', { roomId: meeting.id, sessionToken: 'made-up', tokenPresent: true });
  assert.match((await error).message, /log in again/);
});

test('a user with a token enters directly and is badged Token Detected, never Verified', async () => {
  const { meeting, host } = await hostedMeeting();
  const announced = once(host.socket, 'user-joined');
  const member = await joinDirect(meeting.id, await newUser('tokened'), true);
  assert.strictEqual(member.joined.assurance, 'token-detected');
  const { user } = await announced;
  assert.strictEqual(user.assurance, 'token-detected');
  assert.strictEqual(user.sessionToken, undefined);
});

test('an unverified user waits and receives nothing until the host accepts', async () => {
  const { meeting, host } = await hostedMeeting();
  const guest = await joinWaiting(meeting.id, await newUser('guest'), host);
  assert.strictEqual(guest.request.user.assurance, 'unverified');
  assert.strictEqual(guest.waiting.removedEarlier, false);

  // Nothing reaches the waiting person, and nothing they send reaches the room.
  let leaked = 0;
  ['chat-broadcast', 'minutes-broadcast', 'user-joined', 'signal'].forEach((e) => guest.socket.on(e, () => { leaked += 1; }));
  let heard = 0;
  ['chat-broadcast', 'signal', 'voice-packet-broadcast'].forEach((e) => host.socket.on(e, () => { heard += 1; }));
  host.socket.emit('chat-message', { text: 'private' });
  await sleep(150);
  assert.strictEqual(leaked, 0);
  heard = 0;
  guest.socket.emit('chat-message', { text: 'sneaky' });
  guest.socket.emit('voice-packet', { audioData: 'x', sampleRate: 1 });
  guest.socket.emit('signal', { targetPeerId: host.socket.id, signalData: { type: 'offer' } });
  await sleep(200);
  assert.strictEqual(heard, 0);

  const joined = once(guest.socket, 'room-joined-success');
  host.socket.emit('admission-decision', { peerId: guest.request.peerId, accept: true });
  const entered = await joined;
  assert.strictEqual(entered.assurance, 'unverified');
  assert.strictEqual(entered.existingPeers.length, 1);
  assert.strictEqual(entered.isHost, false);
});

test('the host can decline, and the person can ask again', async () => {
  const { meeting, host } = await hostedMeeting();
  const account = await newUser('declined');
  const guest = await joinWaiting(meeting.id, account, host);

  const declined = once(guest.socket, 'admission-declined');
  host.socket.emit('admission-decision', { peerId: guest.request.peerId, accept: false });
  assert.match((await declined).message, /ask again/);

  const again = once(host.socket, 'admission-request');
  const waiting = once(guest.socket, 'waiting-for-host');
  guest.socket.emit('join-room', { roomId: meeting.id, sessionToken: account.token, tokenPresent: false });
  await waiting;
  assert.strictEqual((await again).peerId, guest.socket.id);
});

test('only the host can accept or use host controls', async () => {
  const { meeting, host } = await hostedMeeting();
  const member = await joinDirect(meeting.id, await newUser('member'), false)
    .catch(() => null);
  assert.strictEqual(member, null); // Unverified, so they had to wait: no direct entry.

  const tokened = await joinDirect(meeting.id, await newUser('tokenmember'), true);
  const ticker = setInterval(() => tokened.socket.emit('token-presence', { present: true }), 500);
  const guest = await joinWaiting(meeting.id, await newUser('applicant'), host);

  let entered = false;
  guest.socket.once('room-joined-success', () => { entered = true; });
  const denied = once(tokened.socket, 'host-action-denied');
  tokened.socket.emit('admission-decision', { peerId: guest.request.peerId, accept: true });
  assert.match((await denied).message, /host/);

  let locks = 0;
  host.socket.on('room-lock-changed', () => { locks += 1; });
  tokened.socket.emit('host-action', { action: 'lock-room' });
  tokened.socket.emit('host-action', { action: 'kick-peer', targetPeerId: host.socket.id });
  tokened.socket.emit('host-action', { action: 'end-meeting' });
  await sleep(200);
  clearInterval(ticker);
  assert.strictEqual(entered, false);
  assert.strictEqual(locks, 0);
});

test('only the host can ask someone to unmute', async () => {
  const { meeting, host } = await hostedMeeting();
  const first = await joinDirect(meeting.id, await newUser('asked'), true);
  const second = await joinDirect(meeting.id, await newUser('other'), true);

  let asked = 0;
  first.socket.on('unmute-request', () => { asked += 1; });
  const denied = once(second.socket, 'host-action-denied');
  second.socket.emit('host-action', { action: 'ask-unmute', targetPeerId: first.socket.id });
  await denied;
  await sleep(150);
  assert.strictEqual(asked, 0);

  const request = once(first.socket, 'unmute-request');
  host.socket.emit('host-action', { action: 'ask-unmute', targetPeerId: first.socket.id });
  await request;
});

test('backup voice keeps a safe audio type and drops anything else', async () => {
  const { meeting, host } = await hostedMeeting();
  const member = await joinDirect(meeting.id, await newUser('voice'), true);

  const good = once(host.socket, 'voice-packet-broadcast');
  member.socket.emit('voice-packet', { audioData: 'AAAA', mimeType: 'audio/webm;codecs=opus' });
  assert.strictEqual((await good).mimeType, 'audio/webm;codecs=opus');

  const bad = once(host.socket, 'voice-packet-broadcast');
  member.socket.emit('voice-packet', { audioData: 'AAAA', mimeType: 'text/html' });
  assert.strictEqual((await bad).mimeType, undefined);
});

test('a host with no token can run their own meeting', async () => {
  const { host } = await hostedMeeting();
  assert.strictEqual(host.joined.isHost, true);
  assert.strictEqual(host.joined.assurance, 'unverified');
  await sleep(LEASE_MS + 1500);
  const chat = once(host.socket, 'chat-broadcast');
  host.socket.emit('chat-message', { text: 'still here' });
  assert.strictEqual((await chat).assurance, 'unverified');
});

test('an accepted person can come back without asking again', async () => {
  const { meeting, host } = await hostedMeeting();
  const account = await newUser('returning');
  const guest = await joinWaiting(meeting.id, account, host);
  const joined = once(guest.socket, 'room-joined-success');
  host.socket.emit('admission-decision', { peerId: guest.request.peerId, accept: true });
  await joined;
  guest.socket.close();
  await sleep(150);

  const back = await joinDirect(meeting.id, account, false);
  assert.strictEqual(back.joined.assurance, 'unverified');
});

test('a person who joins while the host is away waits, and the host sees them on arrival', async () => {
  const account = await newUser('earlyhost');
  const meeting = await newMeeting(account);
  const guest = await joinWaiting(meeting.id, await newUser('early'));
  const host = await joinDirect(meeting.id, account, false);
  assert.strictEqual(host.joined.waiting.length, 1);
  assert.strictEqual(host.joined.waiting[0].peerId, guest.socket.id);
});

test('leaving the waiting room clears the request', async () => {
  const { meeting, host } = await hostedMeeting();
  const guest = await joinWaiting(meeting.id, await newUser('quitter'), host);
  const resolved = once(host.socket, 'admission-resolved');
  guest.socket.close();
  assert.strictEqual((await resolved).peerId, guest.request.peerId);
});

test('removing someone is enforced by the server and needs the host to reverse', async () => {
  const { meeting, host } = await hostedMeeting();
  const account = await newUser('kicked');
  const member = await joinDirect(meeting.id, account, true);

  const removed = once(member.socket, 'removed-by-host');
  const left = once(host.socket, 'user-left');
  host.socket.emit('host-action', { action: 'kick-peer', targetPeerId: member.socket.id });
  await removed;
  assert.strictEqual((await left).reason, 'removed-by-host');

  // They are cut off from the room straight away.
  let heard = 0;
  host.socket.on('chat-broadcast', () => { heard += 1; });
  member.socket.emit('chat-message', { text: 'ghost' });
  await sleep(150);
  assert.strictEqual(heard, 0);

  // Even with a token, they wait for the host.
  const request = once(host.socket, 'admission-request');
  const waiting = once(member.socket, 'waiting-for-host');
  member.socket.emit('join-room', { roomId: meeting.id, sessionToken: account.token, tokenPresent: true });
  assert.strictEqual((await waiting).removedEarlier, true);
  const { peerId, removedEarlier } = await request;
  assert.strictEqual(removedEarlier, true);

  const joined = once(member.socket, 'room-joined-success');
  host.socket.emit('admission-decision', { peerId, accept: true });
  await joined;
});

test('the host cannot be removed', async () => {
  const account = await newUser('stayhost');
  const meeting = await newMeeting(account);
  const first = await joinDirect(meeting.id, account, false);
  const second = await joinDirect(meeting.id, account, false);
  let removed = false;
  first.socket.on('removed-by-host', () => { removed = true; });
  second.socket.emit('host-action', { action: 'kick-peer', targetPeerId: first.socket.id });
  await sleep(200);
  assert.strictEqual(removed, false);
});

test('a locked meeting refuses new people, except the host', async () => {
  const { meeting, host } = await hostedMeeting();
  const locked = once(host.socket, 'room-lock-changed');
  host.socket.emit('host-action', { action: 'lock-room' });
  assert.strictEqual((await locked).isLocked, true);

  const late = await newUser('late');
  const socket = await connect();
  const error = once(socket, 'room-error');
  socket.emit('join-room', { roomId: meeting.id, sessionToken: late.token, tokenPresent: true });
  assert.match((await error).message, /locked/);
});

test('someone whose connection drops can return to a locked meeting', async () => {
  const { meeting, host } = await hostedMeeting();
  const account = await newUser('dropped');
  const member = await joinDirect(meeting.id, account, true);

  const locked = once(host.socket, 'room-lock-changed');
  host.socket.emit('host-action', { action: 'lock-room' });
  await locked;
  const left = once(host.socket, 'user-left');
  member.socket.close();
  await left;

  const back = await joinDirect(meeting.id, account, true);
  assert.strictEqual(back.joined.isLocked, true);
});

test('someone the host removed cannot use the reconnect route into a locked meeting', async () => {
  const { meeting, host } = await hostedMeeting();
  const account = await newUser('noreturn');
  const member = await joinDirect(meeting.id, account, true);

  const removed = once(member.socket, 'removed-by-host');
  host.socket.emit('host-action', { action: 'kick-peer', targetPeerId: member.socket.id });
  await removed;
  const locked = once(host.socket, 'room-lock-changed');
  host.socket.emit('host-action', { action: 'lock-room' });
  await locked;

  member.socket.close();
  await sleep(150);
  const socket = await connect();
  const error = once(socket, 'room-error');
  socket.emit('join-room', { roomId: meeting.id, sessionToken: account.token, tokenPresent: true });
  assert.match((await error).message, /locked/);
});

test('ending a meeting removes everyone and stops the link working', async () => {
  const { meeting, host } = await hostedMeeting();
  const account = await newUser('ended');
  const guest = await joinWaiting(meeting.id, account, host);

  const ended = once(guest.socket, 'meeting-ended');
  const hostEnded = once(host.socket, 'meeting-ended');
  host.socket.emit('host-action', { action: 'end-meeting' });
  await Promise.all([ended, hostEnded]);

  const error = once(guest.socket, 'room-error');
  guest.socket.emit('join-room', { roomId: meeting.id, sessionToken: account.token, tokenPresent: true });
  assert.match((await error).message, /has ended/);
});

test('a meeting holds at most 8 people', async () => {
  const { meeting } = await hostedMeeting();
  const tickers = [];
  for (let i = 0; i < 7; i++) {
    const member = await joinDirect(meeting.id, await newUser('full'), true);
    tickers.push(setInterval(() => member.socket.emit('token-presence', { present: true }), 500));
  }
  const extra = await newUser('ninth');
  const socket = await connect();
  const error = once(socket, 'room-error');
  socket.emit('join-room', { roomId: meeting.id, sessionToken: extra.token, tokenPresent: true });
  const { message } = await error;
  tickers.forEach(clearInterval);
  assert.match(message, /full/);
});

// ---------------------------------------------------------------------------
// USB token presence
// ---------------------------------------------------------------------------

test('unplugging removes only that person and keeps them logged in', async () => {
  const { meeting, host } = await hostedMeeting();
  const account = await newUser('unplug');
  const member = await joinDirect(meeting.id, account, true);

  const removed = once(member.socket, 'token-removed');
  const left = once(host.socket, 'user-left');
  member.socket.emit('token-presence', { present: false });
  assert.match((await removed).message, /unplugged/);
  assert.strictEqual((await left).reason, 'token-removed');

  // Plugged back in, they re-enter on the same login.
  const joined = once(member.socket, 'room-joined-success');
  member.socket.emit('join-room', { roomId: meeting.id, sessionToken: account.token, tokenPresent: true });
  assert.strictEqual((await joined).assurance, 'token-detected');
});

test('after unplugging, joining without the token needs the host', async () => {
  const { meeting, host } = await hostedMeeting();
  const account = await newUser('unplug2');
  const member = await joinDirect(meeting.id, account, true);
  const removed = once(member.socket, 'token-removed');
  member.socket.emit('token-presence', { present: false });
  await removed;

  const request = once(host.socket, 'admission-request');
  const waiting = once(member.socket, 'waiting-for-host');
  member.socket.emit('join-room', { roomId: meeting.id, sessionToken: account.token, tokenPresent: false });
  await waiting;
  assert.strictEqual((await request).user.assurance, 'unverified');
});

test('missing presence reports expire the lease', async () => {
  const { meeting } = await hostedMeeting();
  const member = await joinDirect(meeting.id, await newUser('silent'), true);
  const removed = await once(member.socket, 'token-removed', LEASE_MS + 3000);
  assert.match(removed.message, /No TrusToken presence report/);
});

test('regular presence reports keep the participant in the meeting', async () => {
  const { meeting } = await hostedMeeting();
  const member = await joinDirect(meeting.id, await newUser('alive'), true);
  let removed = false;
  member.socket.on('token-removed', () => { removed = true; });
  const ticker = setInterval(() => member.socket.emit('token-presence', { present: true }), 500);
  await sleep(LEASE_MS * 2);
  clearInterval(ticker);
  assert.strictEqual(removed, false);
});

test('helper reports the USB token appearing and disappearing', async () => {
  const read = async () => (await (await fetch(AGENT)).json()).present;

  assert.strictEqual(await read(), false);
  addFakeToken();
  assert.strictEqual(await read(), true);
  fs.rmSync(path.join(sysfs, '1-2'), { recursive: true });
  assert.strictEqual(await read(), false);
});

test('helper ignores other USB devices', async () => {
  const dir = path.join(sysfs, '1-3');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'idVendor'), '1d6b\n');
  fs.writeFileSync(path.join(dir, 'idProduct'), '0002\n');
  const { present } = await (await fetch(AGENT)).json();
  fs.rmSync(dir, { recursive: true });
  assert.strictEqual(present, false);
});

test('helper only answers allowed web origins', async () => {
  const allowed = await fetch(AGENT, { headers: { Origin: 'https://abc-def.trycloudflare.com' } });
  assert.strictEqual(allowed.status, 200);
  assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'https://abc-def.trycloudflare.com');

  const denied = await fetch(AGENT, { headers: { Origin: 'https://evil.example.com' } });
  assert.strictEqual(denied.status, 403);
  assert.strictEqual(denied.headers.get('access-control-allow-origin'), null);

  const lookalike = await fetch(AGENT, { headers: { Origin: 'https://trycloudflare.com.evil.example.com' } });
  assert.strictEqual(lookalike.status, 403);

  const tailscale = await fetch(AGENT, { headers: { Origin: 'https://100.92.80.94:8443' } });
  assert.strictEqual(tailscale.status, 200);

  const publicAddress = await fetch(AGENT, { headers: { Origin: 'https://100.32.1.1:8443' } });
  assert.strictEqual(publicAddress.status, 403);
});

// ---------------------------------------------------------------------------
// Hardening and signed minutes
// ---------------------------------------------------------------------------

test('malformed messages from a stranger cannot crash the server', async () => {
  const socket = await connect();
  const events = ['signal', 'voice-packet', 'toggle-media-state', 'chat-message', 'minutes-update',
    'token-presence', 'host-action', 'join-room', 'admission-decision'];
  for (const event of events) {
    socket.emit(event);
    socket.emit(event, null);
    socket.emit(event, 'text');
    socket.emit(event, 42);
    socket.emit(event, { roomId: { a: 1 }, targetPeerId: [], text: {}, peerId: 7 });
  }
  await sleep(400);
  assert.strictEqual(server.exitCode, null);
  assert.strictEqual((await fetch(BASE)).status, 200);
});

test('malformed messages from a host in a meeting cannot crash the server', async () => {
  const { host } = await hostedMeeting();
  ['admission-decision', 'host-action', 'chat-message', 'signal'].forEach((event) => {
    host.socket.emit(event);
    host.socket.emit(event, { peerId: 'nope', accept: true, action: 'kick-peer', targetPeerId: {}, text: 5 });
  });
  await sleep(300);
  assert.strictEqual(server.exitCode, null);
});

test('a socket from another website is refused', async () => {
  const blocked = io(BASE, { transports: ['websocket'], reconnection: false, extraHeaders: { Origin: 'https://evil.example.com' } });
  sockets.push(blocked);
  await once(blocked, 'connect_error');

  const allowed = await connect({ extraHeaders: { Origin: BASE } });
  assert.strictEqual(allowed.connected, true);
});

test('signing needs a login, a meeting and membership of it', async () => {
  const { meeting, host } = await hostedMeeting();
  const outsider = await newUser('outsider');
  const body = { roomId: meeting.id, password: PASSWORD, minutesText: 'x' };

  assert.strictEqual((await request('/api/minutes/sign', { body })).status, 401);
  assert.strictEqual((await request('/api/minutes/sign', { body, token: outsider.token })).status, 403);
  assert.strictEqual((await request('/api/minutes/sign', { body: { password: PASSWORD, minutesText: 'x' }, token: host.account.token })).status, 400);
  assert.strictEqual((await request('/api/minutes/sign', { body: { ...body, password: 'wrong-password-1' }, token: host.account.token })).status, 401);
});

test('a signature is tied to the meeting, time and status, and tampering is detected', async () => {
  const { meeting, host } = await hostedMeeting();
  const receipt = await post('/api/minutes/sign', { roomId: meeting.id, password: PASSWORD, minutesText: 'decided' }, host.account.token);

  assert.strictEqual(receipt.signed_by, host.account.name);
  assert.strictEqual(receipt.assurance, 'unverified');
  assert.match(receipt.signature_type, /software key/);
  const signed = JSON.parse(receipt.signed_payload);
  assert.strictEqual(signed.meeting_id, meeting.id);
  assert.strictEqual(signed.signed_at, receipt.timestamp);

  const verify = (fields) => JSON.parse(bridge(['verify-receipt'], JSON.stringify({ ...receipt, ...fields })).stdout).valid;
  assert.strictEqual(verify({}), true);
  assert.strictEqual(verify({ signed_payload: JSON.stringify({ ...signed, meeting_id: 'other' }) }), false);
  assert.strictEqual(verify({ cert_pem: 'not a certificate' }), false);
});

test('a chat message is limited in size', async () => {
  const { host } = await hostedMeeting();
  let received = 0;
  host.socket.on('chat-broadcast', () => { received += 1; });
  host.socket.emit('chat-message', { text: 'x'.repeat(4001) });
  await sleep(150);
  assert.strictEqual(received, 0);
});

// Restarts the server, so it runs last.
test('meetings, acceptances and removals survive a server restart', async () => {
  const account = await newUser('restart');
  const meeting = await newMeeting(account);
  const host = await joinDirect(meeting.id, account, false);
  const guestAccount = await newUser('restartguest');
  const guest = await joinWaiting(meeting.id, guestAccount, host);
  const joined = once(guest.socket, 'room-joined-success');
  host.socket.emit('admission-decision', { peerId: guest.request.peerId, accept: true });
  await joined;

  const stopped = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await stopped;
  await startServer();

  // Sessions live in memory, so people log in again; the meeting and its rules remain.
  const { session } = await post('/api/auth/login', { username: guestAccount.username, password: PASSWORD });
  const back = await joinDirect(meeting.id, { token: session.sessionToken }, false);
  assert.strictEqual(back.joined.roomName, 'Test Meeting');
});
