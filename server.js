const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Certificates for HTTPS (for WebRTC Camera/Mic permissions)
const certPath = path.join(__dirname, 'server.crt');
const keyPath = path.join(__dirname, 'server.key');
let server;
let isHttps = false;

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
  server = https.createServer(options, app);
  isHttps = true;
} else {
  server = http.createServer(app);
}

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const BRIDGE_SCRIPT = path.join(__dirname, 'trustoken_bridge.py');

// In-Memory state for active challenges, sessions, rooms
const activeChallenges = new Map(); // challenge -> { timestamp, expiresAt, context }
const activeSessions = new Map(); // token -> { user_id, name, role, token_serial, cert_serial, authenticatedAt }
const activeRooms = new Map(); // roomId -> { id, name, hostId, hostName, requiresToken, isLocked, members: Set(), minutes: '', signatures: [] }

// Helper to execute Python PKI Bridge
function runBridgeCommand(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [BRIDGE_SCRIPT, ...args]);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      try {
        const json = JSON.parse(stdout.trim());
        resolve(json);
      } catch (err) {
        if (code !== 0) {
          reject(new Error(stderr || stdout || `Process exited with code ${code}`));
        } else {
          resolve({ raw: stdout.trim() });
        }
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

// =============================================================================
// REST API ENDPOINTS: C-DAC TRUSTOKEN PKI & MEETING MANAGEMENT
// =============================================================================

// 1. Hardware Status (Checks /usr/local/lib/libtrustokenP11Libv3.3.0.so and USB dongle)
app.get('/api/trustoken/hardware', async (req, res) => {
  try {
    const hwStatus = await runBridgeCommand(['hardware-status']);
    res.json({
      success: true,
      data: hwStatus,
      isHttps: isHttps
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Enrolled Tokens / Lab Profiles
app.get('/api/trustoken/tokens', async (req, res) => {
  try {
    const result = await runBridgeCommand(['list-tokens']);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Cryptographic Challenge Generation (Nonce)
app.post('/api/trustoken/challenge', (req, res) => {
  const nonce = crypto.randomBytes(32).toString('hex');
  const timestamp = Date.now();
  const challenge = `CDAC_TRUSTOKEN_AUTH:${nonce}:${timestamp}:IITBH_LAB`;
  
  activeChallenges.set(challenge, {
    timestamp,
    expiresAt: timestamp + (5 * 60 * 1000), // 5 min expiry
    context: (req.body && req.body.context) || 'login'
  });

  res.json({
    success: true,
    challenge,
    nonce,
    timestamp,
    standard: 'IS-16695 Part 1 & 2'
  });
});

// 4. Token Login Verification (Authenticates signature from on-chip private key)
app.post('/api/trustoken/login', async (req, res) => {
  const { user_id, pin, challenge } = req.body || {};

  if (!user_id || !pin || !challenge) {
    return res.status(400).json({ success: false, error: 'user_id, pin, and challenge are required' });
  }

  const chData = activeChallenges.get(challenge);
  if (!chData || Date.now() > chData.expiresAt) {
    return res.status(400).json({ success: false, error: 'Cryptographic challenge is invalid or expired' });
  }

  try {
    // 1. Execute hardware/virtual token sign with PIN
    const signResult = await runBridgeCommand(['sign-challenge', user_id, pin, challenge]);
    if (!signResult.success) {
      return res.status(401).json(signResult);
    }

    // 2. Verify signature cryptographically
    const verifyResult = await runBridgeCommand(['verify-signature', challenge, signResult.signature_b64, user_id]);
    if (!verifyResult.valid) {
      return res.status(401).json({ success: false, error: verifyResult.message });
    }

    // Challenge consumed
    activeChallenges.delete(challenge);

    // 3. Generate high-entropy session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionData = {
      sessionToken,
      user_id: signResult.user_id,
      name: signResult.name,
      role: signResult.role,
      token_serial: signResult.token_serial,
      cert_serial: signResult.cert_serial,
      cert_pem: signResult.cert_pem,
      algorithm: signResult.algorithm,
      compliance: 'IS-16695 Part 1 & 2 / PKCS#11',
      authenticatedAt: new Date().toISOString(),
      lastHeartbeat: Date.now()
    };

    activeSessions.set(sessionToken, sessionData);

    res.json({
      success: true,
      message: 'TrusToken Authentication Successful',
      session: sessionData
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. TrusToken Heartbeat (Continuous Hardware Presence Verification)
app.post('/api/trustoken/heartbeat', async (req, res) => {
  const { sessionToken, user_id, pin, challenge } = req.body || {};
  const session = activeSessions.get(sessionToken);

  if (!session) {
    return res.status(401).json({ success: false, error: 'Session expired or not found' });
  }

  try {
    // Generate fresh micro-challenge
    const microChallenge = challenge || `HEARTBEAT:${Date.now()}:${session.token_serial}`;
    const signResult = await runBridgeCommand(['sign-challenge', user_id || session.user_id, pin || '123456', microChallenge]);

    if (signResult.success) {
      session.lastHeartbeat = Date.now();
      res.json({
        success: true,
        heartbeat_verified: true,
        token_serial: session.token_serial,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(403).json({
        success: false,
        heartbeat_verified: false,
        error: 'Hardware Dongle presence check failed'
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Digitally Sign Meeting Minutes (PKCS#7 / CMS Digital Signature)
app.post('/api/trustoken/sign-minutes', async (req, res) => {
  const { roomId, user_id, pin, minutesText } = req.body || {};

  if (!user_id || !pin || !minutesText) {
    return res.status(400).json({ success: false, error: 'user_id, pin, and minutesText are required' });
  }

  try {
    const minutesB64 = Buffer.from(minutesText, 'utf-8').toString('base64');
    const result = await runBridgeCommand(['sign-minutes', user_id, pin, minutesB64]);

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Attach to room state if roomId provided
    if (roomId && activeRooms.has(roomId)) {
      const room = activeRooms.get(roomId);
      room.signatures = room.signatures || [];
      room.signatures.push(result);
      
      // Broadcast signature update to all members in the room
      io.to(roomId).emit('minutes-signed-broadcast', {
        roomId,
        signatureReceipt: result,
        minutesText
      });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Rooms API
app.get('/api/rooms', (req, res) => {
  const roomsList = [];
  for (const [id, r] of activeRooms.entries()) {
    const memberDetails = [];
    if (r.members instanceof Map) {
      for (const [sid, u] of r.members.entries()) {
        if (u) {
          memberDetails.push({ name: u.name, role: u.role, token_serial: u.token_serial, user_id: u.user_id });
        }
      }
    }
    roomsList.push({
      id: r.id,
      name: r.name,
      hostName: r.hostName,
      requiresToken: r.requiresToken,
      isLocked: r.isLocked,
      memberCount: r.members ? r.members.size : 0,
      activeMembers: memberDetails
    });
  }
  res.json({ success: true, rooms: roomsList });
});

app.post('/api/rooms/create', (req, res) => {
  const { name, hostName, requiresToken } = req.body;
  const roomId = (req.body.id || 'LAB-' + crypto.randomBytes(3).toString('hex').toUpperCase());

  if (activeRooms.has(roomId)) {
    return res.json({ success: true, room: activeRooms.get(roomId) });
  }

  const room = {
    id: roomId,
    name: name || `Lab Research Meeting (${roomId})`,
    hostName: hostName || 'Dr. Dhiman Saha (PI)',
    requiresToken: requiresToken !== false,
    isLocked: false,
    members: new Map(),
    minutes: '### Lab Meeting Agenda & Protocol\n\n1. Security architecture review with C-DAC TrusToken\n2. WebRTC cryptographic signaling & zero-trust admission\n3. Action items & milestone approvals\n',
    signatures: []
  };

  activeRooms.set(roomId, room);
  res.json({ success: true, room: { ...room, members: 0 } });
});

// Initialize default rooms
activeRooms.set('LAB-DECIPHERED-SYNC', {
  id: 'LAB-DECIPHERED-SYNC',
  name: 'de.ci.phe.red LAB Weekly Sync',
  hostName: 'Dr. Dhiman Saha (PI)',
  requiresToken: true,
  isLocked: false,
  members: new Map(),
  minutes: '### de.ci.phe.red LAB Weekly Research Sync\n**PI:** Dr. Dhiman Saha | **IIT Bhilai**\n\n1. C-DAC TrusToken IS-16695 Hardware Token PKI Integration\n2. Progress on Lightweight & Symmetric Cryptanalysis (TinyJAMBU, KATAN, Keccak/TIDAL)\n3. Lab Hardware Token Deployment & Milestones\n',
  signatures: []
});

activeRooms.set('CRYPTO-ANALYSIS-MEET', {
  id: 'CRYPTO-ANALYSIS-MEET',
  name: 'Symmetric Cryptanalysis & Ciphers Sync',
  hostName: 'Krishna Saha',
  requiresToken: true,
  isLocked: false,
  members: new Map(),
  minutes: '### Symmetric Cryptanalysis & Ciphers Sync\n**Lead:** Krishna Saha | **Lab:** de.ci.phe.red LAB\n\n- Automated cryptanalysis toolchains\n- Fault analysis and differential distinguishers\n',
  signatures: []
});

// =============================================================================
// WEBRTC SIGNALING & COLLABORATION (SOCKET.IO)
// =============================================================================

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  socket.on('join-room', ({ roomId, user, sessionToken }) => {
    currentRoom = roomId;
    currentUser = user;

    if (!activeRooms.has(roomId)) {
      activeRooms.set(roomId, {
        id: roomId,
        name: `Lab Meeting ${roomId}`,
        hostName: user.name,
        requiresToken: true,
        isLocked: false,
        members: new Map(),
        minutes: '### Lab Meeting Minutes\n\n',
        signatures: []
      });
    }

    const room = activeRooms.get(roomId);
    if (!(room.members instanceof Map)) {
      room.members = new Map();
    }

    if (room.isLocked) {
      socket.emit('room-error', { message: 'Meeting room is currently locked by the PI host.' });
      return;
    }

    socket.join(roomId);
    room.members.set(socket.id, user);
    console.log(`[Room] ${user.name} (${socket.id}) joined room ${roomId}. Total members: ${room.members.size}`);

    // Broadcast user joined to other peers in room
    socket.to(roomId).emit('user-joined', {
      peerId: socket.id,
      user: {
        ...user,
        socketId: socket.id,
        joinedAt: new Date().toISOString()
      }
    });

    // Send existing peers in room (with full user profiles) to the newly joined peer
    const existingPeers = [];
    for (const [memberId, memberUser] of room.members.entries()) {
      if (memberId !== socket.id) {
        existingPeers.push({
          peerId: memberId,
          user: memberUser
        });
      }
    }

    socket.emit('room-joined-success', {
      roomId,
      roomName: room.name,
      isHost: room.hostName === user.name,
      existingPeers,
      minutes: room.minutes,
      signatures: room.signatures,
      requiresToken: room.requiresToken
    });

    io.emit('rooms-updated');
  });

  // WebRTC Signaling: Offer, Answer, ICE Candidate
  socket.on('signal', ({ targetPeerId, signalData }) => {
    console.log(`[Signal] ${socket.id} (${currentUser ? currentUser.name : 'Unknown'}) -> ${targetPeerId} [${signalData ? signalData.type : 'signal'}]`);
    io.to(targetPeerId).emit('signal', {
      fromPeerId: socket.id,
      signalData,
      fromUser: currentUser
    });
  });

  // Real-time Voice Relay Channel (Guaranteed audio delivery across carrier firewalls and NAT)
  socket.on('voice-packet', ({ audioData, sampleRate }) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('voice-packet-broadcast', {
        senderId: socket.id,
        senderName: currentUser ? currentUser.name : 'Lab Member',
        audioData,
        sampleRate
      });
    }
  });

  // Audio / Video track state toggle
  socket.on('toggle-media-state', ({ type, enabled }) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('peer-media-state-changed', {
        peerId: socket.id,
        type, // 'audio' or 'video' or 'screen'
        enabled
      });
    }
  });

  // In-meeting Chat Message
  socket.on('chat-message', (data) => {
    if (currentRoom) {
      const msg = {
        id: crypto.randomUUID(),
        senderId: socket.id,
        senderName: currentUser ? currentUser.name : 'Lab Member',
        senderRole: currentUser ? currentUser.role : 'Researcher',
        tokenSerial: currentUser ? currentUser.token_serial : 'TT-UNKNOWN',
        text: data.text,
        file: data.file || null,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      io.to(currentRoom).emit('chat-broadcast', msg);
    }
  });

  // Meeting Minutes Real-time Collaborative Editing
  socket.on('minutes-update', ({ text }) => {
    if (currentRoom && activeRooms.has(currentRoom)) {
      const room = activeRooms.get(currentRoom);
      room.minutes = text;
      socket.to(currentRoom).emit('minutes-broadcast', { text });
    }
  });

  // TrusToken Heartbeat Lost Alert (e.g. USB dongle unplugged)
  socket.on('token-heartbeat-lost', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('peer-token-disconnected', {
        peerId: socket.id,
        userName: currentUser ? currentUser.name : 'Unknown',
        message: 'C-DAC TrusToken USB dongle was removed or heartbeat failed. Audio/Video paused for security.'
      });
    }
  });

  // Host Action: Lock Room, Mute Peer, Kick
  socket.on('host-action', ({ action, targetPeerId }) => {
    if (currentRoom && activeRooms.has(currentRoom)) {
      const room = activeRooms.get(currentRoom);
      if (action === 'lock-room') {
        room.isLocked = !room.isLocked;
        io.to(currentRoom).emit('room-lock-changed', { isLocked: room.isLocked });
      } else if (action === 'mute-peer' && targetPeerId) {
        io.to(targetPeerId).emit('force-mute');
      } else if (action === 'kick-peer' && targetPeerId) {
        io.to(targetPeerId).emit('force-disconnect');
      }
    }
  });

  // Disconnection cleanup
  socket.on('disconnect', () => {
    if (currentRoom && activeRooms.has(currentRoom)) {
      const room = activeRooms.get(currentRoom);
      if (room.members instanceof Map) {
        room.members.delete(socket.id);
      }
      socket.to(currentRoom).emit('user-left', {
        peerId: socket.id,
        userName: currentUser ? currentUser.name : 'Member'
      });
      io.emit('rooms-updated');
    }
  });
});

const PORT = process.env.PORT || 8443;
const HTTP_PORT = 8080;

server.listen(PORT, '0.0.0.0', () => {
  const protocol = isHttps ? 'https' : 'http';
  console.log(`================================================================`);
  console.log(`🛡️  TrusMeet: C-DAC TrusToken Lab Video Conference Server`);
  console.log(`🔒 Protocol: ${protocol.toUpperCase()}`);
  console.log(`🌐 Server running at: ${protocol}://localhost:${PORT}`);
  console.log(`🔑 PKCS#11 Driver: ${BRIDGE_SCRIPT}`);
  console.log(`================================================================`);
});

// Also serve on HTTP port 8080 for seamless access without SSL warnings
if (isHttps) {
  const httpServer = http.createServer(app);
  io.attach(httpServer);
  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    console.log(`🌐 HTTP access available at: http://localhost:${HTTP_PORT}`);
  });
}
