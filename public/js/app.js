/**
 * TrusMeet: Main Application Controller
 * Manages State, UI Transitions, WebRTC Grid, TrusToken Security Hub, and Collaborative Minutes.
 */

document.addEventListener('DOMContentLoaded', async () => {
  // Global State
  const state = {
    socket: io(),
    webrtc: null,
    trustoken: new TrusTokenClient(),
    currentUser: null,
    currentRoomId: null,
    isHost: false,
    selectedTokenId: 'krishna_saha',
    audioMuted: false,
    videoMuted: false,
    isRecording: false,
    activeDrawer: null,
    peerStreams: new Map() // peerId -> { stream, user, tileElement }
  };

  // DOM Elements
  const els = {
    // Top Nav
    tokenStatusPill: document.getElementById('token-status-pill'),
    userBadge: document.getElementById('user-badge'),
    userNameDisplay: document.getElementById('user-name-display'),
    userRoleDisplay: document.getElementById('user-role-display'),
    userAvatarDisplay: document.getElementById('user-avatar-display'),

    // Lobby
    lobbyView: document.getElementById('lobby-view'),
    memberCardsGrid: document.getElementById('member-cards-grid'),
    previewVideo: document.getElementById('preview-video'),
    previewAudioMeter: document.getElementById('preview-audio-meter'),
    togglePreviewMicBtn: document.getElementById('btn-preview-mic'),
    togglePreviewCamBtn: document.getElementById('btn-preview-cam'),
    btnAuthToken: document.getElementById('btn-auth-token'),
    authStatusText: document.getElementById('auth-status-text'),
    roomListContainer: document.getElementById('room-list-container'),
    btnCreateRoom: document.getElementById('btn-create-room'),
    inputNewRoomName: document.getElementById('new-room-name'),

    // Conference
    conferenceView: document.getElementById('conference-view'),
    confRoomTitle: document.getElementById('conf-room-title'),
    confTimer: document.getElementById('conf-timer'),
    btnCopyInvite: document.getElementById('btn-copy-invite'),
    videoGrid: document.getElementById('video-grid'),
    localVideo: document.getElementById('local-video'),
    localTile: document.getElementById('local-tile'),
    localNameTag: document.getElementById('local-name-tag'),
    localTokenBadge: document.getElementById('local-token-badge'),

    // Controls
    btnToggleMic: document.getElementById('btn-toggle-mic'),
    btnToggleCam: document.getElementById('btn-toggle-cam'),
    btnShareScreen: document.getElementById('btn-share-screen'),
    btnRecordMeeting: document.getElementById('btn-record-meeting'),
    btnToggleMinutes: document.getElementById('btn-toggle-minutes'),
    btnToggleSecurity: document.getElementById('btn-toggle-security'),
    btnToggleChat: document.getElementById('btn-toggle-chat'),
    btnToggleParticipants: document.getElementById('btn-toggle-participants'),
    btnLeaveCall: document.getElementById('btn-leave-call'),

    // Drawers
    drawerMinutes: document.getElementById('drawer-minutes'),
    drawerSecurity: document.getElementById('drawer-security'),
    drawerChat: document.getElementById('drawer-chat'),
    drawerParticipants: document.getElementById('drawer-participants'),
    minutesEditor: document.getElementById('minutes-editor'),
    btnSignMinutes: document.getElementById('btn-sign-minutes'),
    signaturesList: document.getElementById('signatures-list'),
    chatMessages: document.getElementById('chat-messages'),
    chatInput: document.getElementById('chat-input'),
    btnSendChat: document.getElementById('btn-send-chat'),
    participantsList: document.getElementById('participants-list'),

    // Modals
    pinModal: document.getElementById('pin-modal'),
    pinDigits: [
      document.getElementById('pin-1'),
      document.getElementById('pin-2'),
      document.getElementById('pin-3'),
      document.getElementById('pin-4'),
      document.getElementById('pin-5'),
      document.getElementById('pin-6')
    ],
    btnSubmitPin: document.getElementById('btn-submit-pin'),
    btnCancelPin: document.getElementById('btn-cancel-pin'),
    pinModalSubtitle: document.getElementById('pin-modal-subtitle'),
    pinErrorMsg: document.getElementById('pin-error-msg'),

    // Toast Container
    toastContainer: document.getElementById('toast-container')
  };

  // Helper: Toast Notifications
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    let icon = 'ℹ️';
    if (type === 'success') icon = '🛡️';
    if (type === 'warning') icon = '⚠️';
    if (type === 'error') icon = '🚨';
    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    els.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // 1. Initialize WebRTC Manager
  state.webrtc = new WebRTCManager(
    state.socket,
    (peerId, stream, user) => onRemoteStreamAdded(peerId, stream, user),
    (peerId) => onRemoteStreamRemoved(peerId),
    (peerId, volume, isSpeaking) => onActiveSpeakerDetected(peerId, volume, isSpeaking)
  );

  // 2. Fetch TrusToken Hardware Status & Available Member Profiles
  async function loadTokenInfo() {
    const statusData = await state.trustoken.fetchStatus();
    if (!statusData) return;

    const hw = statusData.hardware;
    if (hw?.hardware_dongle_present) {
      els.tokenStatusPill.className = 'token-pill connected';
      els.tokenStatusPill.innerHTML = `
        <span class="pulse-dot"></span>
        <span>C-DAC TrusToken USB (IS-16695)</span>
      `;
    } else {
      els.tokenStatusPill.className = 'token-pill emulated';
      els.tokenStatusPill.innerHTML = `
        <span class="pulse-dot"></span>
        <span>TrusToken PKI (PKCS#11 v2.20)</span>
      `;
    }

    renderMemberProfiles(statusData.tokens);
    renderDiagnosticHub(hw);
  }

  // Render enrolled member cards
  function renderMemberProfiles(tokens) {
    els.memberCardsGrid.innerHTML = '';
    tokens.forEach((t) => {
      const card = document.createElement('div');
      card.className = `member-card-option ${t.user_id === state.selectedTokenId ? 'selected' : ''}`;
      card.dataset.userId = t.user_id;

      card.innerHTML = `
        <div class="member-card-name">${t.name}</div>
        <div class="member-card-role">${t.role}</div>
        <div class="member-card-serial">Key: ${t.key_type} | ${t.token_serial}</div>
      `;

      card.addEventListener('click', () => {
        document.querySelectorAll('.member-card-option').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        state.selectedTokenId = t.user_id;
      });

      els.memberCardsGrid.appendChild(card);
    });
  }

  // Render Hardware Diagnostic Drawer
  function renderDiagnosticHub(hw) {
    const hubBody = document.getElementById('security-hub-body');
    if (!hubBody) return;

    hubBody.innerHTML = `
      <div class="trustoken-card" style="box-shadow:none;">
        <div style="font-weight:700; color:var(--cyan-400); margin-bottom:0.6rem;">C-DAC PKCS#11 DRIVER ARCHITECTURE</div>
        <table class="diag-table">
          <tr><th>Library Path</th><td>${hw?.library_path || '/usr/local/lib/libtrustokenP11Libv3.3.0.so'}</td></tr>
          <tr><th>Manufacturer</th><td>${hw?.info?.manufacturer || 'CDAC-Noida (www.cdac.in)'}</td></tr>
          <tr><th>Standard</th><td>${hw?.info?.standard || 'IS-16695 Part 1 & 2 / ISO-7816'}</td></tr>
          <tr><th>Cryptoki Version</th><td>v${hw?.info?.cryptoki_version || '2.2'}</td></tr>
          <tr><th>Physical USB Stick</th><td style="color:${hw?.hardware_dongle_present ? 'var(--emerald-400)' : 'var(--cyan-400)'};">${hw?.hardware_dongle_present ? 'DETECTED ON USB BUS' : 'Active (IS-16695 Soft Module)'}</td></tr>
        </table>
      </div>

      <div style="background:rgba(30,41,59,0.5); padding:1.25rem; border-radius:14px; border:1px solid var(--border-subtle);">
        <div style="font-weight:700; color:var(--text-primary); margin-bottom:0.5rem; display:flex; align-items:center; gap:0.5rem;">
          <span>⚡ Security Liveness & Heartbeat Simulation</span>
        </div>
        <p style="font-size:0.82rem; color:var(--text-secondary); line-height:1.45; margin-bottom:1rem;">
          C-DAC TrusToken supports cryptographic heartbeat. If a lab member removes their USB token mid-meeting, audio/video are automatically cut off to protect lab confidentiality.
        </p>
        <button id="btn-toggle-dongle-plug" class="btn-secondary" style="width:100%; font-size:0.85rem;">
          🔌 Simulate Unplugging USB Dongle
        </button>
      </div>

      <div style="background:rgba(30,41,59,0.5); padding:1.25rem; border-radius:14px; border:1px solid var(--border-subtle);">
        <div style="font-weight:700; color:var(--emerald-400); margin-bottom:0.5rem;">Verified Certificate & Key Hierarchy</div>
        <div style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-mono); line-height:1.6;">
          Root CA: TrusToken Lab Root CA (IS-16695)<br/>
          Signer Algorithm: RSA-PKCS#1v1.5 / ECDSA P-256<br/>
          Key Storage: On-Chip Container (Never Leaves Device)<br/>
          BIS Standard: IS-16695 Part 1 & 2 Approved
        </div>
      </div>
    `;

    document.getElementById('btn-toggle-dongle-plug')?.addEventListener('click', (e) => {
      const attached = state.trustoken.toggleDongleAttachment();
      const btn = e.target;
      if (!attached) {
        btn.textContent = '🔌 Re-insert TrusToken USB Dongle';
        btn.style.borderColor = 'var(--rose-500)';
        btn.style.color = 'var(--rose-400)';
        showToast('TrusToken USB Dongle Removed! Heartbeat will fail.', 'error');
      } else {
        btn.textContent = '🔌 Simulate Unplugging USB Dongle';
        btn.style.borderColor = 'var(--border-light)';
        btn.style.color = 'var(--text-primary)';
        showToast('TrusToken USB Dongle Re-connected!', 'success');
      }
    });
  }

  // 3. Lobby Media Preview Setup
  await state.webrtc.initLocalMedia(els.previewVideo, true, true);

  // Preview Mic / Cam Toggles
  els.togglePreviewMicBtn.addEventListener('click', () => {
    state.audioMuted = !state.audioMuted;
    state.webrtc.setAudioEnabled(!state.audioMuted);
    els.togglePreviewMicBtn.classList.toggle('muted', state.audioMuted);
  });

  els.togglePreviewCamBtn.addEventListener('click', () => {
    state.videoMuted = !state.videoMuted;
    state.webrtc.setVideoEnabled(!state.videoMuted);
    els.togglePreviewCamBtn.classList.toggle('muted', state.videoMuted);
  });

  // 4. TrusToken PIN Verification Modal Flow
  let pinResolve = null;
  let pinReject = null;

  function promptPinModal(username) {
    return new Promise((resolve, reject) => {
      pinResolve = resolve;
      pinReject = reject;
      els.pinModalSubtitle.innerHTML = `Enter PIN for <strong>${username}</strong>'s TrusToken USB Dongle<br><span style="color:var(--teal-400); font-size:0.75rem; font-weight:600;">(Lab Default PIN: 123456)</span>`;
      els.pinErrorMsg.textContent = '';
      const defaultPin = '123456';
      els.pinDigits.forEach((d, idx) => { d.value = defaultPin[idx] || ''; });
      els.pinModal.classList.add('open');
      els.btnSubmitPin.focus();
    });
  }

  // PIN Input auto-advance
  els.pinDigits.forEach((digitInput, idx) => {
    digitInput.addEventListener('input', (e) => {
      if (e.target.value.length === 1 && idx < 5) {
        els.pinDigits[idx + 1].focus();
      }
    });
    digitInput.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && e.target.value === '' && idx > 0) {
        els.pinDigits[idx - 1].focus();
      }
      if (e.key === 'Enter') {
        els.btnSubmitPin.click();
      }
    });
  });

  els.btnCancelPin.addEventListener('click', () => {
    els.pinModal.classList.remove('open');
    if (pinReject) pinReject(new Error('PIN prompt canceled'));
  });

  els.btnSubmitPin.addEventListener('click', () => {
    const pin = els.pinDigits.map(d => d.value).join('');
    if (pin.length < 4) {
      els.pinErrorMsg.textContent = 'Please enter full hardware PIN (e.g. 123456)';
      return;
    }
    els.pinModal.classList.remove('open');
    if (pinResolve) pinResolve(pin);
  });

  // 5. Authentication Button Handler
  els.btnAuthToken.addEventListener('click', async () => {
    const selectedUserId = state.selectedTokenId;
    const tokenObj = state.trustoken.enrolledTokens.find(t => t.user_id === selectedUserId);
    const userName = tokenObj ? tokenObj.name : 'Lab Member';

    try {
      const pin = await promptPinModal(userName);
      els.authStatusText.textContent = 'Verifying cryptographic challenge with TrusToken chip...';

      const session = await state.trustoken.authenticateWithToken(selectedUserId, pin);
      state.currentUser = session;

      // Update Top Nav User Badge
      els.userBadge.style.display = 'flex';
      els.userNameDisplay.textContent = session.name;
      els.userRoleDisplay.textContent = `${session.role} (${session.token_serial})`;
      els.userAvatarDisplay.textContent = session.name.split(' ').map(w => w[0]).join('').slice(0, 2);

      showToast(`Authenticated as ${session.name} using C-DAC TrusToken!`, 'success');
      els.authStatusText.textContent = `✅ Authenticated: ${session.name} | ${session.token_serial}`;
      els.btnAuthToken.style.display = 'none';

      // Check if invited to a specific room (?room=)
      const urlParams = new URLSearchParams(window.location.search);
      const inviteRoom = urlParams.get('room');
      if (inviteRoom) {
        showToast(`Entering invited lab room: ${inviteRoom}...`, 'success');
        joinConferenceRoom(inviteRoom);
      } else {
        // Load Rooms
        loadRooms();
      }
    } catch (err) {
      showToast(err.message || 'Authentication Failed', 'error');
      els.authStatusText.textContent = `❌ ${err.message}`;
    }
  });

  // 6. Rooms Loading and Joining
  async function loadRooms() {
    try {
      const res = await fetch('/api/rooms');
      const data = await res.json();
      if (!data.success) return;

      els.roomListContainer.innerHTML = '';
      data.rooms.forEach((room) => {
        const item = document.createElement('div');
        item.className = 'room-card';
        item.innerHTML = `
          <div class="room-info">
            <div class="room-title">${room.name}</div>
            <div class="room-host">Host: ${room.hostName}</div>
          </div>
          <div style="display:flex; align-items:center; gap:0.75rem;">
            <span class="room-security-badge">
              <span>🔒</span> TrusToken Required
            </span>
            <button class="btn-primary" style="padding:0.45rem 1rem; font-size:0.85rem;" data-room-id="${room.id}">
              Join Room
            </button>
          </div>
        `;

        item.querySelector('button').addEventListener('click', () => {
          joinConferenceRoom(room.id);
        });

        els.roomListContainer.appendChild(item);
      });
    } catch (e) {
      console.error('Failed to load rooms:', e);
    }
  }

  // Create New Meeting Room
  els.btnCreateRoom.addEventListener('click', async () => {
    if (!state.currentUser) {
      showToast('Please authenticate with TrusToken before creating a room', 'warning');
      return;
    }
    const name = els.inputNewRoomName.value.trim() || 'Lab Research Meeting';
    try {
      const res = await fetch('/api/rooms/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          hostName: state.currentUser.name,
          requiresToken: true
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Created meeting room: ${data.room.name}`, 'success');
        joinConferenceRoom(data.room.id);
      }
    } catch (err) {
      showToast('Failed to create room', 'error');
    }
  });

  // 7. Join Conference Room
  function joinConferenceRoom(roomId) {
    if (!state.currentUser) {
      showToast('Authentication with C-DAC TrusToken is required to enter', 'error');
      return;
    }

    state.currentRoomId = roomId;

    // Transition View to Conference Stage
    els.lobbyView.style.display = 'none';
    els.conferenceView.style.display = 'flex';

    // Set local video in conference room
    els.localVideo.srcObject = state.webrtc.localStream;
    els.localNameTag.textContent = `${state.currentUser.name} (You)`;
    els.localTokenBadge.textContent = state.currentUser.token_serial;

    // Join room via Socket.IO
    state.socket.emit('join-room', {
      roomId,
      user: state.currentUser,
      sessionToken: state.currentUser.sessionToken
    });

    // Start continuous Voice Relay backup for guaranteed carrier/NAT penetration
    if (!state.audioMuted) {
      state.webrtc.startVoiceRelay();
    }

    startConferenceTimer();
    updateGridPeersCount();
    showToast(`Joined meeting room: ${roomId}`, 'success');
  }

  // Conference Duration Timer
  let timerInterval = null;
  function startConferenceTimer() {
    let seconds = 0;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      seconds++;
      const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
      const secs = String(seconds % 60).padStart(2, '0');
      els.confTimer.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  // Socket.IO Room Events
  state.socket.on('room-joined-success', ({ roomId, roomName, isHost, existingPeers, minutes, signatures }) => {
    els.confRoomTitle.textContent = roomName;
    state.isHost = isHost;

    if (minutes) els.minutesEditor.value = minutes;
    if (signatures) renderSignatures(signatures);

    // Initiate WebRTC peer connections with existing members
    existingPeers.forEach((p) => {
      const peerId = p.peerId || p;
      const peerUser = p.user || { name: 'Lab Member' };
      state.webrtc.createPeerConnection(peerId, true, peerUser);
    });

    updateParticipantsRoster();
  });

  state.socket.on('user-joined', ({ peerId, user }) => {
    showToast(`${user.name} joined with TrusToken ${user.token_serial}`, 'info');
    state.webrtc.createPeerConnection(peerId, false, user);
    updateParticipantsRoster();
  });

  state.socket.on('signal', ({ fromPeerId, signalData, fromUser }) => {
    state.webrtc.handleSignal(fromPeerId, signalData, fromUser);
  });

  state.socket.on('user-left', ({ peerId, userName }) => {
    showToast(`${userName} left the meeting`, 'info');
    state.webrtc.removePeer(peerId);
    onRemoteStreamRemoved(peerId);
    updateParticipantsRoster();
  });

  // 8. Remote Streams & Video Grid
  function onRemoteStreamAdded(peerId, stream, user) {
    let tile = document.getElementById(`tile-${peerId}`);

    if (tile) {
      // Re-bind stream if video track just arrived
      const existingVideo = tile.querySelector('video');
      if (existingVideo) {
        if (existingVideo.srcObject !== stream) {
          existingVideo.srcObject = stream;
        }
        existingVideo.play().catch(e => console.warn('[WebRTC] Stream re-play notice:', e));
      }
      return;
    }

    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${peerId}`;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.className = 'video-element';
    video.srcObject = stream;

    // Mobile tap-to-unmute overlay
    const tapToUnmuteBtn = document.createElement('button');
    tapToUnmuteBtn.className = 'tap-unmute-btn';
    tapToUnmuteBtn.id = `unmute-btn-${peerId}`;
    tapToUnmuteBtn.innerHTML = `<span>🔊</span> Tap to Hear ${user ? user.name : 'Peer'}`;
    tapToUnmuteBtn.style.display = 'none';

    tapToUnmuteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      video.muted = false;
      video.play().then(() => {
        tapToUnmuteBtn.style.display = 'none';
        showToast(`Audio unmuted for ${user ? user.name : 'peer'}`, 'success');
      }).catch(err => console.error('Unmute error:', err));
    });

    // Mobile browsers require explicit play and can block unmuted autoplay
    const playAttempt = video.play();
    if (playAttempt !== undefined) {
      playAttempt.then(() => {
        tapToUnmuteBtn.style.display = 'none';
      }).catch((err) => {
        console.warn('[WebRTC] Mobile browser autoplay blocked. Attempting muted play:', err);
        video.muted = true;
        video.play().then(() => {
          tapToUnmuteBtn.style.display = 'flex';
        }).catch(e => console.error('[WebRTC] Video playback failed:', e));
      });
    }

    const infoBar = document.createElement('div');
    infoBar.className = 'tile-info-bar';
    infoBar.innerHTML = `
      <div class="tile-participant-tag">
        <span class="tile-participant-name">${user ? user.name : 'Lab Peer'}</span>
        <span class="tile-token-badge">${user ? user.token_serial : 'TT-IN-VERIFIED'}</span>
      </div>
      <div class="tile-status-icons">
        <div class="tile-status-icon" id="mic-icon-${peerId}">🎤</div>
      </div>
    `;

    tile.appendChild(video);
    tile.appendChild(tapToUnmuteBtn);
    tile.appendChild(infoBar);
    els.videoGrid.appendChild(tile);

    state.peerStreams.set(peerId, { stream, user, tileElement: tile, videoElement: video });
    updateGridPeersCount();
    updateParticipantsRoster();
  }

  // Any tap or click on the conference stage automatically unlocks and un-mutes all remote streams!
  els.conferenceView.addEventListener('click', () => {
    state.peerStreams.forEach(({ videoElement }, peerId) => {
      if (videoElement && videoElement.muted) {
        videoElement.muted = false;
        videoElement.play().then(() => {
          const btn = document.getElementById(`unmute-btn-${peerId}`);
          if (btn) btn.style.display = 'none';
        }).catch(e => console.warn(e));
      }
    });
  });

  function onRemoteStreamRemoved(peerId) {
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) tile.remove();
    state.peerStreams.delete(peerId);
    updateGridPeersCount();
  }

  function updateGridPeersCount() {
    const count = 1 + state.peerStreams.size;
    els.videoGrid.dataset.peers = String(count);
  }

  // Active Speaker Highlight
  function onActiveSpeakerDetected(peerId, volume, isSpeaking) {
    if (peerId === 'local') {
      // Local preview audio meter
      if (els.previewAudioMeter) {
        els.previewAudioMeter.style.width = `${Math.min(100, volume * 3)}%`;
      }
      if (els.localTile) {
        els.localTile.classList.toggle('speaking', isSpeaking);
      }
    } else {
      const p = state.peerStreams.get(peerId);
      if (p?.tileElement) {
        p.tileElement.classList.toggle('speaking', isSpeaking);
      }
    }
  }

  // 9. TrusToken Heartbeat Alert Listener
  state.trustoken.onHeartbeatStatusChange = (isAlive, message) => {
    if (!isAlive) {
      // Token unplugged or heartbeat failure!
      els.localTile.classList.add('token-lost');
      state.webrtc.setAudioEnabled(false);
      state.webrtc.setVideoEnabled(false);

      if (!document.getElementById('local-token-lost-banner')) {
        const banner = document.createElement('div');
        banner.className = 'token-lost-banner';
        banner.id = 'local-token-lost-banner';
        banner.innerHTML = `
          <div class="alert-icon">⚠️</div>
          <div style="font-weight:700; color:var(--rose-400); font-size:1.1rem;">TrusToken USB Dongle Detached</div>
          <p style="font-size:0.85rem; color:var(--text-secondary); max-width:320px;">
            Audio and video feeds paused to prevent unauthorized meeting access. Reconnect hardware dongle to restore session.
          </p>
        `;
        els.localTile.appendChild(banner);
      }

      state.socket.emit('token-heartbeat-lost');
      showToast('🚨 TrusToken disconnected! Access suspended for security.', 'error');
    } else {
      // Restored
      els.localTile.classList.remove('token-lost');
      const b = document.getElementById('local-token-lost-banner');
      if (b) b.remove();
      state.webrtc.setAudioEnabled(!state.audioMuted);
      state.webrtc.setVideoEnabled(!state.videoMuted);
    }
  };

  state.socket.on('peer-token-disconnected', ({ peerId, userName }) => {
    const p = state.peerStreams.get(peerId);
    if (p?.tileElement) {
      p.tileElement.classList.add('token-lost');
      showToast(`⚠️ ${userName}'s TrusToken dongle was removed. Stream suspended.`, 'warning');
    }
  });

  // 10. Bottom Dock Action Controls
  els.btnToggleMic.addEventListener('click', () => {
    state.audioMuted = !state.audioMuted;
    state.webrtc.setAudioEnabled(!state.audioMuted);
    if (state.audioMuted) {
      state.webrtc.stopVoiceRelay();
    } else {
      state.webrtc.startVoiceRelay();
    }
    els.btnToggleMic.classList.toggle('danger', state.audioMuted);
    els.btnToggleMic.querySelector('span').textContent = state.audioMuted ? 'Unmute' : 'Mute';
  });

  els.btnToggleCam.addEventListener('click', () => {
    state.videoMuted = !state.videoMuted;
    state.webrtc.setVideoEnabled(!state.videoMuted);
    els.btnToggleCam.classList.toggle('danger', state.videoMuted);
    els.btnToggleCam.querySelector('span').textContent = state.videoMuted ? 'Start Video' : 'Stop Video';
  });

  els.btnShareScreen.addEventListener('click', async () => {
    const isSharing = await state.webrtc.toggleScreenShare(els.localVideo);
    els.btnShareScreen.classList.toggle('active', isSharing);
  });

  els.btnRecordMeeting.addEventListener('click', () => {
    if (!state.isRecording) {
      const ok = state.webrtc.startRecording();
      if (ok) {
        state.isRecording = true;
        els.btnRecordMeeting.classList.add('danger');
        els.btnRecordMeeting.querySelector('span').textContent = 'Stop Rec';
        showToast('Meeting recording started (WebM)', 'info');
      }
    } else {
      state.webrtc.stopRecording();
      state.isRecording = false;
      els.btnRecordMeeting.classList.remove('danger');
      els.btnRecordMeeting.querySelector('span').textContent = 'Record';
      showToast('Recording saved to downloads', 'success');
    }
  });

  // Drawer Toggle Utility
  function toggleDrawer(targetDrawer, triggerBtn) {
    const isOpen = targetDrawer.classList.contains('open');
    document.querySelectorAll('.side-drawer').forEach(d => d.classList.remove('open'));
    document.querySelectorAll('.dock-btn').forEach(b => {
      if (b !== els.btnToggleMic && b !== els.btnToggleCam && b !== els.btnRecordMeeting && b !== els.btnShareScreen) {
        b.classList.remove('active');
      }
    });

    if (!isOpen) {
      targetDrawer.classList.add('open');
      if (triggerBtn) triggerBtn.classList.add('active');
      state.activeDrawer = targetDrawer;
    } else {
      state.activeDrawer = null;
    }
  }

  els.btnToggleMinutes.addEventListener('click', () => toggleDrawer(els.drawerMinutes, els.btnToggleMinutes));
  els.btnToggleSecurity.addEventListener('click', () => toggleDrawer(els.drawerSecurity, els.btnToggleSecurity));
  els.btnToggleChat.addEventListener('click', () => toggleDrawer(els.drawerChat, els.btnToggleChat));
  els.btnToggleParticipants.addEventListener('click', () => toggleDrawer(els.drawerParticipants, els.btnToggleParticipants));

  document.querySelectorAll('.drawer-close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.side-drawer').forEach(d => d.classList.remove('open'));
      document.querySelectorAll('.dock-btn').forEach(b => {
        if (b !== els.btnToggleMic && b !== els.btnToggleCam && b !== els.btnRecordMeeting && b !== els.btnShareScreen) {
          b.classList.remove('active');
        }
      });
      state.activeDrawer = null;
    });
  });

  // 11. Collaborative Minutes & TrusToken Digital Signer
  els.minutesEditor.addEventListener('input', (e) => {
    state.socket.emit('minutes-update', { text: e.target.value });
  });

  state.socket.on('minutes-broadcast', ({ text }) => {
    els.minutesEditor.value = text;
  });

  els.btnSignMinutes.addEventListener('click', async () => {
    if (!state.currentUser) return;
    const text = els.minutesEditor.value.trim();
    if (!text) {
      showToast('Meeting minutes are empty', 'warning');
      return;
    }

    try {
      const pin = await promptPinModal(state.currentUser.name);
      showToast('Applying IS-16695 PKCS#7 Digital Signature on minutes...', 'info');

      const receipt = await state.trustoken.signMeetingMinutes(
        state.currentRoomId,
        state.currentUser.user_id,
        pin,
        text
      );

      showToast(`Minutes digitally signed by ${receipt.signed_by}!`, 'success');
    } catch (err) {
      showToast(err.message || 'Signing failed', 'error');
    }
  });

  state.socket.on('minutes-signed-broadcast', ({ signatureReceipt }) => {
    renderSignatures([signatureReceipt]);
    showToast(`📜 ${signatureReceipt.signed_by} (${signatureReceipt.signer_role}) digitally signed the minutes with TrusToken!`, 'success');
  });

  function renderSignatures(signatures) {
    signatures.forEach(sig => {
      if (document.getElementById(`sig-${sig.document_sha256}`)) return;
      const card = document.createElement('div');
      card.className = 'signature-seal-card';
      card.id = `sig-${sig.document_sha256}`;
      card.innerHTML = `
        <div class="signature-seal-header">
          <span>🛡️</span>
          <span>Digitally Signed with C-DAC TrusToken</span>
        </div>
        <div style="font-size:0.82rem; font-weight:600; color:var(--text-primary); margin-top:0.4rem;">
          ${sig.signed_by} &bull; <span style="color:var(--teal-400);">${sig.signer_role}</span>
        </div>
        <div class="signature-hash-row">
          <span>SHA-256 Digest:</span>
          <span class="signature-hash-val">${sig.document_sha256}</span>
        </div>
        <div class="signature-hash-row">
          <span>Hardware Token Serial:</span>
          <span class="signature-hash-val">${sig.token_serial} (${sig.algorithm})</span>
        </div>
        <div style="font-size:0.7rem; color:var(--text-muted); margin-top:0.5rem;">
          Timestamp: ${new Date(sig.timestamp).toLocaleString()} &bull; IS-16695 Verified
        </div>
      `;
      els.signaturesList.prepend(card);
    });
  }

  // 12. In-Meeting Chat
  function sendChatMessage() {
    const text = els.chatInput.value.trim();
    if (!text) return;
    state.socket.emit('chat-message', { text });
    els.chatInput.value = '';
  }

  els.btnSendChat.addEventListener('click', sendChatMessage);
  els.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });

  state.socket.on('chat-broadcast', (msg) => {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${msg.senderId === state.socket.id ? 'mine' : ''}`;
    bubble.innerHTML = `
      <div class="chat-sender-info">
        <span>${msg.senderName} (${msg.tokenSerial})</span>
        <span>${msg.timestamp}</span>
      </div>
      <div class="chat-text">${escapeHtml(msg.text)}</div>
    `;
    els.chatMessages.appendChild(bubble);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  });

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 13. Participant Roster
  function updateParticipantsRoster() {
    els.participantsList.innerHTML = '';

    // Self
    if (state.currentUser) {
      const selfItem = document.createElement('div');
      selfItem.className = 'room-card';
      selfItem.innerHTML = `
        <div>
          <div style="font-weight:600; color:var(--text-primary);">${state.currentUser.name} (You)</div>
          <div style="font-size:0.75rem; color:var(--teal-400);">${state.currentUser.role} &bull; ${state.currentUser.token_serial}</div>
        </div>
        <span class="room-security-badge">Verified</span>
      `;
      els.participantsList.appendChild(selfItem);
    }

    // Peers
    state.peerStreams.forEach((peer, peerId) => {
      const item = document.createElement('div');
      item.className = 'room-card';
      item.innerHTML = `
        <div>
          <div style="font-weight:600; color:var(--text-primary);">${peer.user ? peer.user.name : 'Lab Peer'}</div>
          <div style="font-size:0.75rem; color:var(--teal-400);">${peer.user ? peer.user.role : 'Researcher'} &bull; ${peer.user ? peer.user.token_serial : 'TT-IN'}</div>
        </div>
        <span class="room-security-badge">Verified</span>
      `;
      els.participantsList.appendChild(item);
    });
  }

  // 14. Leave Conference
  els.btnLeaveCall.addEventListener('click', () => {
    if (confirm('Leave the lab video conference?')) {
      location.reload();
    }
  });

  // 15. Copy Invite Link
  els.btnCopyInvite?.addEventListener('click', () => {
    const inviteUrl = `${window.location.origin}/?room=${encodeURIComponent(state.currentRoomId || '')}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(inviteUrl).then(() => {
        showToast(`📋 Copied meeting invite to clipboard: ${inviteUrl}`, 'success');
      }).catch(() => {
        prompt('Copy meeting invite link:', inviteUrl);
      });
    } else {
      prompt('Copy meeting invite link:', inviteUrl);
    }
  });

  // Initial load
  await loadTokenInfo();

  // Handle ?room= in URL
  const urlParams = new URLSearchParams(window.location.search);
  const paramRoom = urlParams.get('room');
  if (paramRoom) {
    showToast(`Invited to room: ${paramRoom}. Please enter your TrusToken PIN to join.`, 'info');
  }
});
