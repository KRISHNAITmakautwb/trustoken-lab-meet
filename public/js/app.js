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
    inMeeting: false,
    joinedWithToken: false,
    isHost: false,
    isLocked: false,
    myAssurance: 'unverified',
    audioMuted: false,
    videoMuted: false,
    isRecording: false,
    activeDrawer: null,
    peerStreams: new Map(), // peerId -> { stream, user, tileElement }
    roster: new Map(), // peerId -> user
    mutedPeers: new Set(), // peerIds whose microphone is off
    pendingAdmissions: new Map(), // peerId -> { user, removedEarlier }
    tokenStatus: { helperRunning: false, present: false },
    tokenStatusKnown: false,
    meetingEnded: false,
    reconnecting: false
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
    authSection: document.getElementById('auth-section'),
    accountSection: document.getElementById('account-section'),
    tabLogin: document.getElementById('tab-login'),
    tabSignup: document.getElementById('tab-signup'),
    loginForm: document.getElementById('login-form'),
    signupForm: document.getElementById('signup-form'),
    loginUsername: document.getElementById('login-username'),
    loginPassword: document.getElementById('login-password'),
    signupName: document.getElementById('signup-name'),
    signupUsername: document.getElementById('signup-username'),
    signupPassword: document.getElementById('signup-password'),
    signupCode: document.getElementById('signup-code'),
    authError: document.getElementById('auth-error'),
    tokenSummary: document.getElementById('token-summary'),
    btnTokenSetup: document.getElementById('btn-token-setup'),
    btnLogout: document.getElementById('btn-logout'),
    btnCreateRoom: document.getElementById('btn-create-room'),
    inputNewRoomName: document.getElementById('new-room-name'),
    newMeetingPanel: document.getElementById('new-meeting-panel'),
    newMeetingLink: document.getElementById('new-meeting-link'),
    btnCopyNewLink: document.getElementById('btn-copy-new-link'),
    btnStartNewMeeting: document.getElementById('btn-start-new-meeting'),
    inputJoinRoom: document.getElementById('join-room-input'),
    btnJoinRoom: document.getElementById('btn-join-room'),
    roomListContainer: document.getElementById('room-list-container'),
    previewVideo: document.getElementById('preview-video'),
    previewAudioMeter: document.getElementById('preview-audio-meter'),
    togglePreviewMicBtn: document.getElementById('btn-preview-mic'),
    togglePreviewCamBtn: document.getElementById('btn-preview-cam'),

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
    passwordModal: document.getElementById('password-modal'),
    passwordModalSubtitle: document.getElementById('password-modal-subtitle'),
    passwordInput: document.getElementById('password-input'),
    passwordError: document.getElementById('password-error'),
    btnSubmitPassword: document.getElementById('btn-submit-password'),
    btnCancelPassword: document.getElementById('btn-cancel-password'),
    choiceModal: document.getElementById('choice-modal'),
    choiceTitle: document.getElementById('choice-title'),
    choiceMessage: document.getElementById('choice-message'),
    btnChoicePrimary: document.getElementById('btn-choice-primary'),
    btnChoiceSecondary: document.getElementById('btn-choice-secondary'),
    waitingModal: document.getElementById('waiting-modal'),
    waitingMessage: document.getElementById('waiting-message'),
    btnWaitingLeave: document.getElementById('btn-waiting-leave'),
    tokenGateModal: document.getElementById('token-gate-modal'),
    tokenGateTitle: document.getElementById('token-gate-title'),
    tokenGateMessage: document.getElementById('token-gate-message'),
    btnTokenGateRejoin: document.getElementById('btn-token-gate-rejoin'),
    btnTokenGateLobby: document.getElementById('btn-token-gate-lobby'),

    // Host tools
    admissionPanel: document.getElementById('admission-panel'),
    admissionList: document.getElementById('admission-list'),
    hostControls: document.getElementById('host-controls'),
    btnLockRoom: document.getElementById('btn-lock-room'),
    btnEndMeeting: document.getElementById('btn-end-meeting'),
    confRoomIdTag: document.getElementById('conf-room-id-tag'),
    confAssuranceTag: document.getElementById('conf-assurance-tag'),

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
    const iconEl = document.createElement('span');
    iconEl.textContent = icon;
    const messageEl = document.createElement('span');
    messageEl.textContent = message;
    toast.append(iconEl, ' ', messageEl);
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

  // 2. Watch the USB Token on This Computer
  const ASSURANCE_LABELS = {
    verified: 'Verified',
    'token-detected': 'Token Detected',
    unverified: 'Unverified'
  };

  function assuranceLabel(assurance) {
    return ASSURANCE_LABELS[assurance] || ASSURANCE_LABELS.unverified;
  }

  function assuranceStyle(assurance) {
    return assurance === 'unverified' || !ASSURANCE_LABELS[assurance] ? 'is-unverified' : 'is-detected';
  }

  function assuranceBadge(assurance) {
    return `<span class="assurance-badge ${assuranceStyle(assurance)}">${escapeHtml(assuranceLabel(assurance))}</span>`;
  }
  function tokenProblemMessage(status) {
    if (status.helperRunning) {
      return 'TrusToken is not plugged in. Plug it into this computer.';
    }
    if (status.waiting) {
      return 'Chrome is asking for permission to reach the TrusToken helper. Click Allow at the top of this window.';
    }
    if (status.permission === 'denied') {
      return 'Chrome is blocking the TrusToken helper. Click the icon to the left of the address bar, allow local network access, then reload this page.';
    }
    if (status.permission === 'prompt') {
      return 'Could not reach the TrusToken helper. Start it on this computer with: python3 trustoken_agent.py. If Chrome asks for local network access, click Allow.';
    }
    return 'TrusToken helper is not running. Start it on this computer with: python3 trustoken_agent.py';
  }

  function tokenStatusLabel(status) {
    if (status.present) return 'TrusToken plugged in';
    if (status.helperRunning) return 'TrusToken not plugged in';
    if (status.waiting) return 'Allow access in Chrome';
    if (status.permission === 'denied') return 'Chrome is blocking TrusToken helper';
    if (status.permission === 'prompt') return 'Cannot reach TrusToken helper';
    return 'TrusToken helper not running';
  }

  let tokenWatcher = null;

  function onTokenStatus(status) {
    const changed = !state.tokenStatusKnown
      || tokenStatusLabel(status) !== tokenStatusLabel(state.tokenStatus);
    state.tokenStatus = status;
    state.tokenStatusKnown = true;

    if (changed) renderTokenStatus();
    if (tokenWatcher) tokenWatcher(status);

    if (state.meetingEnded || !state.inMeeting || !state.joinedWithToken) return;
    // A slow check is not proof the token is gone. The server's lease covers a real stall.
    if (status.waiting) return;
    state.socket.emit('token-presence', { present: status.present });
    if (!status.present) {
      endMeeting('TrusToken Disconnected', `${tokenProblemMessage(status)} Then rejoin, or ask the host to accept you as unverified.`);
    }
  }

  function renderTokenStatus() {
    const user = state.currentUser;
    const usesToken = Boolean(user && user.has_token);
    const present = usesToken && state.tokenStatus.present;
    let label = 'Not logged in';
    if (user) label = usesToken ? tokenStatusLabel(state.tokenStatus) : 'Unverified: no USB token';

    els.tokenStatusPill.className = `token-pill ${present ? 'connected' : 'disconnected'}`;
    els.tokenStatusPill.innerHTML = `
      <span class="pulse-dot"></span>
      <span>${escapeHtml(label)}</span>
    `;
    if (user) {
      els.tokenSummary.textContent = usesToken
        ? `USB token: ${tokenStatusLabel(state.tokenStatus)}. With it plugged in, you enter meetings directly.`
        : 'No USB token added. You can join meetings as an unverified user after the host accepts you.';
      els.btnTokenSetup.textContent = usesToken ? 'Change Token Setting' : 'Add USB Token';
    }
    renderDiagnosticHub();
  }

  function renderDiagnosticHub() {
    const hubBody = document.getElementById('security-hub-body');
    if (!hubBody) return;
    const present = state.tokenStatus.present;
    const usesToken = Boolean(state.currentUser && state.currentUser.has_token);

    hubBody.innerHTML = `
      <div class="trustoken-card" style="box-shadow:none;">
        <div style="font-weight:700; color:var(--cyan-400); margin-bottom:0.6rem;">THIS COMPUTER</div>
        <table class="diag-table">
          <tr><th>Your Status</th><td>${escapeHtml(assuranceLabel(state.myAssurance))}</td></tr>
          <tr><th>USB Token</th><td style="color:${usesToken && present ? 'var(--emerald-400)' : 'var(--rose-400)'};">${usesToken ? (present ? 'Plugged in' : 'Not detected') : 'Not used'}</td></tr>
        </table>
      </div>

      <div style="background:rgba(30,41,59,0.5); padding:1.25rem; border-radius:14px; border:1px solid var(--border-subtle);">
        <div style="font-weight:700; color:var(--text-primary); margin-bottom:0.5rem;">What the Badges Mean</div>
        <p style="font-size:0.82rem; color:var(--text-secondary); line-height:1.45;">
          <strong>Token Detected</strong> means a device with the TrusToken USB ID was reported by that person's computer. It does not prove who they are, and a modified client can fake it. <strong>Unverified</strong> people were accepted by the host.
        </p>
      </div>
    `;
  }

  function startTokenWatch() {
    state.tokenStatusKnown = false;
    state.trustoken.startPresenceMonitor(onTokenStatus);
  }

  function renderAccount() {
    const user = state.currentUser;
    els.authSection.style.display = user ? 'none' : 'flex';
    els.accountSection.style.display = user ? 'flex' : 'none';
    els.userBadge.style.display = user ? 'flex' : 'none';
    if (user) {
      els.userNameDisplay.textContent = user.name;
      els.userRoleDisplay.textContent = `@${user.user_id}`;
      els.userAvatarDisplay.textContent = user.name.split(' ').map(w => w[0]).join('').slice(0, 2);
    }
    renderTokenStatus();
  }

  // Take this participant out of the meeting and stop their camera, mic and peers.
  function endMeeting(title, message, { canRejoin = true } = {}) {
    if (state.meetingEnded) return;
    state.meetingEnded = true;
    state.inMeeting = false;
    stopReconnecting();

    if (timerInterval) clearInterval(timerInterval);
    state.webrtc.stopVoiceRelay();
    if (state.isRecording) {
      state.webrtc.stopRecording();
      state.isRecording = false;
    }
    [...state.peerStreams.keys()].forEach(onRemoteStreamRemoved);
    state.webrtc.closeAll();
    els.localVideo.srcObject = null;
    els.waitingModal.classList.remove('open');
    els.admissionPanel.style.display = 'none';

    els.tokenGateTitle.textContent = title;
    els.tokenGateMessage.textContent = message;
    els.btnTokenGateRejoin.style.display = canRejoin ? 'block' : 'none';
    els.tokenGateModal.classList.add('open');
  }

  els.btnTokenGateRejoin.addEventListener('click', () => {
    window.location.href = `/?room=${encodeURIComponent(state.currentRoomId || '')}`;
  });

  els.btnTokenGateLobby.addEventListener('click', () => {
    window.location.href = '/';
  });

  // 3. Lobby Media Preview Setup
  // Not awaited: login must work while the browser is still asking for camera access.
  const mediaReady = state.webrtc.initLocalMedia(els.previewVideo, true, true)
    .then(() => state.webrtc.setAudioEnabled(!state.audioMuted))
    .catch((err) => console.error('Could not start camera and microphone:', err));

  // Preview Mic / Cam Toggles
  els.togglePreviewMicBtn.addEventListener('click', () => setMicMuted(!state.audioMuted));

  function renderCameraButtons() {
    els.togglePreviewCamBtn.classList.toggle('muted', state.videoMuted);
    els.btnToggleCam.classList.toggle('danger', state.videoMuted);
    els.btnToggleCam.querySelector('span').textContent = state.videoMuted ? 'Start Video' : 'Stop Video';
  }

  async function toggleCamera() {
    await mediaReady;
    state.videoMuted = !state.videoMuted;
    const turningOn = !state.videoMuted;
    renderCameraButtons();
    if (state.isRecording) {
      showToast('This recording continues with audio only.', 'warning');
    }
    const applied = await state.webrtc.setVideoEnabled(turningOn);
    if (!applied && turningOn) {
      state.videoMuted = true;
      renderCameraButtons();
      showToast('Could not turn the camera back on. Check that no other app is using it.', 'error');
    }
  }

  els.togglePreviewCamBtn.addEventListener('click', toggleCamera);

  // 4. Password and Choice Dialogs
  let passwordResolve = null;
  let passwordReject = null;

  function promptPassword(username) {
    return new Promise((resolve, reject) => {
      passwordResolve = resolve;
      passwordReject = reject;
      els.passwordModalSubtitle.textContent = `Enter the password for ${username} to sign with your software key.`;
      els.passwordError.textContent = '';
      els.passwordInput.value = '';
      els.passwordModal.classList.add('open');
      els.passwordInput.focus();
    });
  }

  els.btnCancelPassword.addEventListener('click', () => {
    els.passwordModal.classList.remove('open');
    if (passwordReject) passwordReject(new Error('Signing canceled'));
  });

  els.btnSubmitPassword.addEventListener('click', () => {
    const password = els.passwordInput.value;
    if (!password) {
      els.passwordError.textContent = 'Please enter your password';
      return;
    }
    els.passwordInput.value = '';
    els.passwordModal.classList.remove('open');
    if (passwordResolve) passwordResolve(password);
  });

  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.btnSubmitPassword.click();
  });

  let choiceResolve = null;

  function askChoice({ title, message, primary, secondary, primaryNeedsToken = false }) {
    return new Promise((resolve) => {
      choiceResolve = resolve;
      els.choiceTitle.textContent = title;
      els.choiceMessage.textContent = message;
      els.btnChoicePrimary.textContent = primary;
      els.btnChoiceSecondary.textContent = secondary;
      els.btnChoicePrimary.disabled = primaryNeedsToken && !state.tokenStatus.present;
      tokenWatcher = primaryNeedsToken ? (status) => {
        els.btnChoicePrimary.disabled = !status.present;
        els.choiceMessage.textContent = status.present
          ? 'USB token found. You can continue.'
          : tokenProblemMessage(status);
      } : null;
      els.choiceModal.classList.add('open');
    });
  }

  function finishChoice(answer) {
    els.choiceModal.classList.remove('open');
    tokenWatcher = null;
    const resolve = choiceResolve;
    choiceResolve = null;
    if (resolve) resolve(answer);
  }

  els.btnChoicePrimary.addEventListener('click', () => finishChoice('primary'));
  els.btnChoiceSecondary.addEventListener('click', () => finishChoice('secondary'));

  // Returns true if the USB token is plugged in, or false to continue without it.
  async function tokenPluggedOrChooseUnverified() {
    const status = await state.trustoken.checkLocalToken();
    if (status.present) return true;
    const answer = await askChoice({
      title: 'Plug In Your USB Token',
      message: tokenProblemMessage(status),
      primary: 'Continue With Token',
      secondary: 'Continue as Unverified',
      primaryNeedsToken: true
    });
    return answer === 'primary';
  }

  // Asked once after sign-up, and again whenever the person changes the setting.
  async function askAboutToken() {
    const answer = await askChoice({
      title: 'Do You Have a USB Token?',
      message: 'With a C-DAC TrusToken plugged in, you enter meetings directly. Without one, you can still join as an unverified user once the host accepts you.',
      primary: 'Yes, I Have One',
      secondary: 'No, Continue Unverified'
    });
    const hasToken = answer === 'primary';
    try {
      await state.trustoken.setTokenChoice(hasToken);
    } catch (err) {
      showToast(err.message, 'error');
      return;
    }
    if (hasToken) {
      startTokenWatch();
      await tokenPluggedOrChooseUnverified();
    } else {
      state.trustoken.stopPresenceMonitor();
      state.tokenStatus = { helperRunning: false, present: false };
    }
    renderAccount();
  }

  els.btnTokenSetup.addEventListener('click', askAboutToken);

  // 5. Sign Up and Log In
  function showAuthTab(signup) {
    els.loginForm.style.display = signup ? 'none' : 'flex';
    els.signupForm.style.display = signup ? 'flex' : 'none';
    els.tabLogin.classList.toggle('active', !signup);
    els.tabSignup.classList.toggle('active', signup);
    els.authError.textContent = '';
  }

  els.tabLogin.addEventListener('click', () => showAuthTab(false));
  els.tabSignup.addEventListener('click', () => showAuthTab(true));

  async function afterLogin() {
    state.currentUser = state.trustoken.currentSession;
    renderAccount();
    if (state.currentUser.has_token === null) {
      await askAboutToken();
    } else if (state.currentUser.has_token) {
      startTokenWatch();
    }
    loadMyMeetings();

    const inviteRoom = new URLSearchParams(window.location.search).get('room');
    if (inviteRoom) joinConferenceRoom(inviteRoom);
  }

  async function submitAuth(action, form) {
    els.authError.textContent = '';
    try {
      await action();
      form.reset();
      await afterLogin();
    } catch (err) {
      els.authError.textContent = err.message || 'That did not work. Please try again.';
    }
  }

  els.loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAuth(() => state.trustoken.login(els.loginUsername.value, els.loginPassword.value), els.loginForm);
  });

  els.signupForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitAuth(() => state.trustoken.register({
      name: els.signupName.value,
      username: els.signupUsername.value,
      password: els.signupPassword.value,
      signupCode: els.signupCode.value
    }), els.signupForm);
  });

  els.btnLogout.addEventListener('click', async () => {
    try {
      await state.trustoken.logout();
    } finally {
      window.location.href = '/';
    }
  });

  // 6. My Meetings, New Meetings and Links
  async function loadMyMeetings() {
    try {
      const meetings = await state.trustoken.myMeetings();
      els.roomListContainer.innerHTML = '';
      if (meetings.length === 0) {
        els.roomListContainer.textContent = 'Meetings you create will appear here.';
      }
      meetings.forEach((meeting) => {
        const item = document.createElement('div');
        item.className = 'room-card';
        item.innerHTML = `
          <div class="room-info">
            <div class="room-title">${escapeHtml(meeting.name)}</div>
            <div class="room-host">${escapeHtml(String(meeting.memberCount))} in the meeting</div>
          </div>
          <button class="btn-primary" style="padding:0.45rem 1rem; font-size:0.85rem;">Start</button>
        `;
        item.querySelector('button').addEventListener('click', () => joinConferenceRoom(meeting.id));
        els.roomListContainer.appendChild(item);
      });
    } catch (e) {
      console.error('Failed to load meetings:', e);
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => showToast('Meeting link copied', 'success'))
        .catch(() => prompt('Copy meeting link:', text));
    } else {
      prompt('Copy meeting link:', text);
    }
  }

  let newMeetingId = null;

  els.btnCreateRoom.addEventListener('click', async () => {
    try {
      const meeting = await state.trustoken.createMeeting(els.inputNewRoomName.value.trim());
      newMeetingId = meeting.id;
      els.newMeetingLink.value = `${window.location.origin}${meeting.link}`;
      els.newMeetingPanel.style.display = 'flex';
      els.inputNewRoomName.value = '';
      showToast(`Created: ${meeting.name}`, 'success');
      loadMyMeetings();
    } catch (err) {
      showToast(err.message || 'Failed to create the meeting', 'error');
    }
  });

  els.btnCopyNewLink.addEventListener('click', () => copyToClipboard(els.newMeetingLink.value));
  els.btnStartNewMeeting.addEventListener('click', () => {
    if (newMeetingId) joinConferenceRoom(newMeetingId);
  });

  function meetingIdFromInput(value) {
    const text = value.trim();
    try {
      return new URL(text).searchParams.get('room') || text;
    } catch (err) {
      return text;
    }
  }

  els.btnJoinRoom.addEventListener('click', () => {
    const roomId = meetingIdFromInput(els.inputJoinRoom.value);
    if (roomId) joinConferenceRoom(roomId);
  });

  // 7. Join a Meeting
  let joinInProgress = false;

  async function joinConferenceRoom(roomId) {
    if (!state.currentUser || state.currentRoomId || joinInProgress) return;

    joinInProgress = true;
    let tokenPlugged = false;
    try {
      await mediaReady;
      tokenPlugged = state.currentUser.has_token ? await tokenPluggedOrChooseUnverified() : false;
    } finally {
      joinInProgress = false;
    }

    state.currentRoomId = roomId;
    state.joinedWithToken = tokenPlugged;
    state.socket.emit('join-room', {
      roomId,
      sessionToken: state.currentUser.sessionToken,
      tokenPresent: tokenPlugged
    });
  }

  els.btnWaitingLeave.addEventListener('click', () => {
    window.location.href = '/';
  });

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
  state.socket.on('waiting-for-host', ({ roomName, removedEarlier }) => {
    stopReconnecting();
    els.waitingMessage.textContent = removedEarlier
      ? `The host removed you from "${roomName}" earlier. You will enter if the host lets you back in.`
      : `You are joining "${roomName}" as an unverified user. You will enter when the host accepts your request.`;
    els.waitingModal.classList.add('open');
  });

  state.socket.on('admission-declined', ({ message }) => {
    els.waitingModal.classList.remove('open');
    endMeeting('Request Not Accepted', message);
    els.btnTokenGateRejoin.textContent = 'Ask Again';
  });

  state.socket.on('room-joined-success', ({ roomId, roomName, isHost, isLocked, assurance, existingPeers, minutes, signatures, waiting }) => {
    const wasReconnecting = state.reconnecting;
    stopReconnecting();
    state.pendingAdmissions.clear();
    state.inMeeting = true;
    state.isHost = isHost;
    state.isLocked = isLocked;
    state.myAssurance = assurance;
    els.waitingModal.classList.remove('open');

    els.lobbyView.style.display = 'none';
    els.conferenceView.style.display = 'flex';
    els.localVideo.srcObject = state.webrtc.localStream;
    els.confRoomTitle.textContent = roomName;
    els.confRoomIdTag.textContent = roomId;
    els.confAssuranceTag.textContent = `You: ${assuranceLabel(assurance)}`;
    els.localNameTag.textContent = `${state.currentUser.name} (You)`;
    els.localTokenBadge.textContent = assuranceLabel(assurance);
    els.localTokenBadge.className = `assurance-badge ${assuranceStyle(assurance)}`;
    els.hostControls.style.display = isHost ? 'flex' : 'none';
    renderLockButton();
    renderDiagnosticHub();

    if (minutes) els.minutesEditor.value = minutes;
    if (signatures) renderSignatures(signatures);

    (waiting || []).forEach(({ peerId, user, removedEarlier }) => {
      state.pendingAdmissions.set(peerId, { user, removedEarlier });
    });
    renderAdmissions();

    existingPeers.forEach(({ peerId, user }) => {
      state.roster.set(peerId, user);
      state.webrtc.createPeerConnection(peerId, true, user);
    });

    // Voice starts only now, so nothing is sent from the waiting room.
    if (!state.audioMuted) state.webrtc.startVoiceRelay();
    if (!timerInterval) startConferenceTimer();
    updateGridPeersCount();
    updateParticipantsRoster();
    announceMicState();
    showToast(wasReconnecting ? 'Reconnected' : `Joined: ${roomName}`, 'success');
  });

  state.socket.on('room-error', ({ message }) => {
    if (state.inMeeting || state.reconnecting) {
      endMeeting('Could Not Stay in the Meeting', message);
      return;
    }
    els.waitingModal.classList.remove('open');
    state.currentRoomId = null;
    showToast(message, 'error');
  });

  state.socket.on('token-removed', ({ message }) => {
    endMeeting('Removed From Meeting', `${message} Plug it back in and rejoin, or ask the host to accept you as unverified.`);
  });

  state.socket.on('removed-by-host', ({ message }) => {
    endMeeting('Removed by the Host', message);
    els.btnTokenGateRejoin.textContent = 'Ask to Rejoin';
  });

  state.socket.on('meeting-ended', ({ message }) => {
    endMeeting('Meeting Ended', message, { canRejoin: false });
  });

  // A brief network drop should not end the meeting. Media stops while the server
  // can't enforce the rules, and the person returns on their own once it is back.
  const RECONNECT_GIVE_UP_MS = 30000;
  let reconnectTimer = null;

  function stopReconnecting() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    state.reconnecting = false;
  }

  state.socket.on('disconnect', () => {
    if (!state.currentRoomId || state.meetingEnded || state.reconnecting) return;
    state.reconnecting = true;
    state.inMeeting = false;
    state.webrtc.stopVoiceRelay();
    [...state.roster.keys()].forEach((peerId) => {
      state.webrtc.removePeer(peerId);
      onRemoteStreamRemoved(peerId);
    });
    state.roster.clear();
    state.pendingAdmissions.clear();
    renderAdmissions();
    els.confAssuranceTag.textContent = 'Reconnecting...';
    showToast('Connection lost. Reconnecting...', 'warning');
    reconnectTimer = setTimeout(() => {
      endMeeting('Connection Lost', 'The connection to the meeting server was lost and could not be restored.');
    }, RECONNECT_GIVE_UP_MS);
  });

  state.socket.on('connect', () => {
    if (!state.reconnecting) return;
    state.socket.emit('join-room', {
      roomId: state.currentRoomId,
      sessionToken: state.currentUser.sessionToken,
      tokenPresent: state.joinedWithToken
    });
  });

  state.socket.on('user-joined', ({ peerId, user }) => {
    showToast(`${user.name} joined`, 'info');
    state.roster.set(peerId, user);
    announceMicState(); // So the newcomer can show the right icon.
    state.webrtc.createPeerConnection(peerId, false, user);
    updateParticipantsRoster();
  });

  state.socket.on('signal', ({ fromPeerId, signalData, fromUser }) => {
    state.webrtc.handleSignal(fromPeerId, signalData, fromUser);
  });

  state.socket.on('user-left', ({ peerId, userName, reason }) => {
    const reasons = {
      'token-removed': `${userName} was removed: TrusToken disconnected`,
      'removed-by-host': `${userName} was removed by the host`
    };
    showToast(reasons[reason] || `${userName} left the meeting`, reasons[reason] ? 'warning' : 'info');
    state.roster.delete(peerId);
    state.webrtc.removePeer(peerId);
    onRemoteStreamRemoved(peerId);
    updateParticipantsRoster();
  });

  // Host tools
  function renderAdmissions() {
    els.admissionList.innerHTML = '';
    state.pendingAdmissions.forEach(({ user, removedEarlier }, peerId) => {
      const row = document.createElement('div');
      row.className = 'admission-row';

      const who = document.createElement('div');
      who.className = 'admission-who';
      who.textContent = `${user.name} (@${user.user_id})`;
      const detail = document.createElement('div');
      detail.className = 'admission-detail';
      detail.textContent = removedEarlier ? 'Removed earlier, asking to return' : assuranceLabel(user.assurance);
      who.appendChild(detail);

      const accept = document.createElement('button');
      accept.className = 'btn-primary admission-btn';
      accept.textContent = 'Accept';
      accept.addEventListener('click', () => {
        state.socket.emit('admission-decision', { peerId, accept: true });
      });

      const decline = document.createElement('button');
      decline.className = 'btn-secondary admission-btn';
      decline.textContent = 'Decline';
      decline.addEventListener('click', () => {
        state.socket.emit('admission-decision', { peerId, accept: false });
      });

      row.append(who, accept, decline);
      els.admissionList.appendChild(row);
    });
    els.admissionPanel.style.display = state.isHost && state.inMeeting && state.pendingAdmissions.size ? 'flex' : 'none';
  }

  state.socket.on('admission-request', ({ peerId, user, removedEarlier }) => {
    state.pendingAdmissions.set(peerId, { user, removedEarlier });
    renderAdmissions();
    showToast(`${user.name} is asking to join`, 'warning');
  });

  state.socket.on('admission-resolved', ({ peerId }) => {
    state.pendingAdmissions.delete(peerId);
    renderAdmissions();
  });

  state.socket.on('host-action-denied', ({ message }) => showToast(message, 'error'));

  function renderLockButton() {
    els.btnLockRoom.textContent = state.isLocked ? 'Unlock Meeting' : 'Lock Meeting';
  }

  state.socket.on('room-lock-changed', ({ isLocked }) => {
    state.isLocked = isLocked;
    renderLockButton();
    showToast(isLocked ? 'The host locked this meeting' : 'The host unlocked this meeting', 'info');
  });

  els.btnLockRoom.addEventListener('click', () => {
    state.socket.emit('host-action', { action: 'lock-room' });
  });

  els.btnEndMeeting.addEventListener('click', () => {
    if (confirm('End this meeting for everyone? The link will stop working.')) {
      state.socket.emit('host-action', { action: 'end-meeting' });
    }
  });

  state.socket.on('force-mute', () => {
    setMicMuted(true);
    showToast('The host muted your microphone', 'warning');
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
    tapToUnmuteBtn.textContent = `🔊 Tap to Hear ${user ? user.name : 'Peer'}`;
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
        <span class="tile-participant-name">${escapeHtml(user ? user.name : 'Participant')}</span>
        ${assuranceBadge(user ? user.assurance : 'unverified')}
      </div>
      <div class="tile-status-icons">
        <div class="tile-status-icon" id="mic-icon-${peerId}">${micIcon(state.mutedPeers.has(peerId))}</div>
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

  // 10. Bottom Dock Action Controls
  // The lobby and meeting buttons share one setting, so both are always updated.
  function setMicMuted(muted) {
    state.audioMuted = muted;
    state.webrtc.setAudioEnabled(!muted);
    if (muted) {
      state.webrtc.stopVoiceRelay();
    } else if (state.inMeeting) {
      state.webrtc.startVoiceRelay();
    }
    els.togglePreviewMicBtn.classList.toggle('muted', muted);
    els.btnToggleMic.classList.toggle('danger', muted);
    els.btnToggleMic.querySelector('span').textContent = muted ? 'Unmute' : 'Mute';
    document.getElementById('local-mic-indicator').textContent = micIcon(muted);
  }

  function micIcon(muted) {
    return muted ? '🔇' : '🎤';
  }

  function announceMicState() {
    state.socket.emit('toggle-media-state', { type: 'audio', enabled: !state.audioMuted });
  }

  state.socket.on('peer-media-state-changed', ({ peerId, type, enabled }) => {
    if (type !== 'audio') return;
    if (enabled) state.mutedPeers.delete(peerId);
    else state.mutedPeers.add(peerId);
    const icon = document.getElementById(`mic-icon-${peerId}`);
    if (icon) icon.textContent = micIcon(!enabled);
    updateParticipantsRoster();
  });

  state.socket.on('unmute-request', async () => {
    if (!state.audioMuted || choiceResolve) return;
    const answer = await askChoice({
      title: 'The Host Asks You to Unmute',
      message: 'Your microphone stays off unless you choose to turn it on.',
      primary: 'Unmute',
      secondary: 'Stay Muted'
    });
    if (answer === 'primary') setMicMuted(false);
  });

  els.btnToggleMic.addEventListener('click', () => setMicMuted(!state.audioMuted));

  els.btnToggleCam.addEventListener('click', toggleCamera);

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
      const password = await promptPassword(state.currentUser.name);
      showToast('Signing minutes with your software key...', 'info');

      const receipt = await state.trustoken.signMeetingMinutes(state.currentRoomId, password, text);

      showToast(`Minutes signed by ${receipt.signed_by}`, 'success');
    } catch (err) {
      showToast(err.message || 'Signing failed', 'error');
    }
  });

  state.socket.on('minutes-signed-broadcast', ({ signatureReceipt }) => {
    renderSignatures([signatureReceipt]);
    showToast(`📜 ${signatureReceipt.signed_by} signed the minutes`, 'success');
  });

  function renderSignatures(signatures) {
    signatures.forEach(sig => {
      const cardId = `sig-${sig.signature_b64}`;
      if (document.getElementById(cardId)) return;
      const card = document.createElement('div');
      card.className = 'signature-seal-card';
      card.id = cardId;
      card.innerHTML = `
        <div class="signature-seal-header">
          <span>🛡️</span>
          <span>Signed with a Software Key (Not the USB Token)</span>
        </div>
        <div style="font-size:0.82rem; font-weight:600; color:var(--text-primary); margin-top:0.4rem;">
          ${escapeHtml(sig.signed_by)} ${assuranceBadge(sig.assurance)}
        </div>
        <div class="signature-hash-row">
          <span>SHA-256 Digest:</span>
          <span class="signature-hash-val">${escapeHtml(sig.document_sha256)}</span>
        </div>
        <div class="signature-hash-row">
          <span>Algorithm:</span>
          <span class="signature-hash-val">${escapeHtml(sig.algorithm)}</span>
        </div>
        <div style="font-size:0.7rem; color:var(--text-muted); margin-top:0.5rem;">
          Timestamp: ${escapeHtml(new Date(sig.timestamp).toLocaleString())}
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
        <span>${escapeHtml(msg.senderName)} ${assuranceBadge(msg.assurance)}</span>
        <span>${escapeHtml(msg.timestamp)}</span>
      </div>
      <div class="chat-text">${escapeHtml(msg.text)}</div>
    `;
    els.chatMessages.appendChild(bubble);
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  });

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 13. Participant Roster
  function updateParticipantsRoster() {
    els.participantsList.innerHTML = '';

    if (state.currentUser) {
      const selfItem = document.createElement('div');
      selfItem.className = 'room-card';
      selfItem.innerHTML = `
        <div>
          <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(state.currentUser.name)} (You)</div>
          <div style="font-size:0.75rem; color:var(--teal-400);">@${escapeHtml(state.currentUser.user_id)}</div>
        </div>
        ${assuranceBadge(state.myAssurance)}
      `;
      els.participantsList.appendChild(selfItem);
    }

    state.roster.forEach((user, peerId) => {
      const item = document.createElement('div');
      item.className = 'room-card participant-row';
      item.innerHTML = `
        <div>
          <div style="font-weight:600; color:var(--text-primary);">${escapeHtml(user.name)}</div>
          <div style="font-size:0.75rem; color:var(--teal-400);">@${escapeHtml(user.user_id)}</div>
        </div>
        ${assuranceBadge(user.assurance)}
      `;

      if (state.isHost && user.user_id !== state.currentUser.user_id) {
        const addAction = (label, action) => {
          const button = document.createElement('button');
          button.className = 'btn-secondary admission-btn';
          button.textContent = label;
          button.addEventListener('click', () => {
            state.socket.emit('host-action', { action, targetPeerId: peerId });
          });
          item.appendChild(button);
        };
        if (state.mutedPeers.has(peerId)) addAction('Ask to Unmute', 'ask-unmute');
        else addAction('Mute', 'mute-peer');
        addAction('Remove', 'kick-peer');
      }
      els.participantsList.appendChild(item);
    });
  }

  // 14. Leave Conference
  els.btnLeaveCall.addEventListener('click', () => {
    if (confirm('Leave this meeting?')) {
      window.location.href = '/';
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
  renderAccount();
  if (await state.trustoken.restoreSession()) {
    await afterLogin();
  } else if (new URLSearchParams(window.location.search).get('room')) {
    showToast('You were invited to a meeting. Log in or sign up to join.', 'info');
  }
});
