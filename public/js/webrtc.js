/**
 * TrusMeet: WebRTC Multi-Peer Mesh Engine & Media Coordinator
 * Handles WebRTC connections, audio level analysis, screen sharing, and recording.
 */

const RELAY_CLIP_MS = 800;
const MAX_QUEUED_RELAY_CLIPS = 3;

class WebRTCManager {
  constructor(socket, onPeerStreamAdded, onPeerStreamRemoved, onActiveSpeaker) {
    this.socket = socket;
    this.onPeerStreamAdded = onPeerStreamAdded;
    this.onPeerStreamRemoved = onPeerStreamRemoved;
    this.onActiveSpeaker = onActiveSpeaker;

    this.localStream = null;
    this.screenStream = null;
    this.isScreenSharing = false;

    this.cameraTrack = null; // The live camera, or null while it is switched off
    this.usesRealCamera = false;
    this.blankVideoTrack = null;
    this.blankPainter = null;
    this.cameraQueue = Promise.resolve(); // Keeps quick on/off clicks in order
    this.closed = false;

    this.peers = new Map(); // peerId -> { pc, stream, user }
    this.audioContext = null;
    this.audioAnalyser = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];

    // STUN by default; setIceServers() adds relay (TURN) servers from the server.
    this.rtcConfig = {
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ],
      iceCandidatePoolSize: 4
    };
    this.onPeerConnectionState = null; // (peerId, 'connecting' | 'connected' | 'failed')

    // Voice Relay over WebSocket fallback
    this.voiceRelayRecorder = null;
    this.isVoiceRelayActive = false;
    this.relayPlayback = new Map(); // senderId -> { clips, playing }
    this.setupVoicePacketReceiver();
  }

  // Setup WebSocket Voice Packet Receiver (Works over carrier CGNAT & firewall)
  setupVoicePacketReceiver() {
    if (!this.socket) return;
    this.socket.on('voice-packet-broadcast', ({ senderId, audioData, mimeType }) => {
      // With a working direct connection the voice is already playing.
      const peer = this.peers.get(senderId);
      if (peer && peer.pc.connectionState === 'connected') return;
      try {
        this.queueRelayClip(senderId, this.base64ToBlob(audioData, mimeType || 'audio/webm;codecs=opus'));
      } catch (err) {
        console.warn('[WebRTC] Ignored an unreadable voice clip:', err);
      }
    });
  }

  // Clips from one person play one after another. A backlog is dropped so the
  // voice doesn't drift further and further behind.
  queueRelayClip(senderId, blob) {
    let playback = this.relayPlayback.get(senderId);
    if (!playback) {
      playback = { clips: [], playing: false };
      this.relayPlayback.set(senderId, playback);
    }
    if (playback.clips.length >= MAX_QUEUED_RELAY_CLIPS) playback.clips.shift();
    playback.clips.push(blob);
    this.playNextRelayClip(playback);
  }

  playNextRelayClip(playback) {
    if (playback.playing) return;
    const blob = playback.clips.shift();
    if (!blob) return;
    playback.playing = true;

    const url = URL.createObjectURL(blob);
    const audioEl = new Audio(url);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(url);
      playback.playing = false;
      this.playNextRelayClip(playback);
    };
    audioEl.onended = finish;
    audioEl.onerror = finish;
    audioEl.play().catch(finish); // Mobile autoplay rules can refuse a clip.
  }

  needsVoiceRelay() {
    return [...this.peers.values()].some((peer) => peer.pc.connectionState !== 'connected');
  }

  base64ToBlob(base64, mimeType) {
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteNumbers[i] = byteChars.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  }

  // Start continuous voice packet relay fallback
  startVoiceRelay() {
    if (this.isVoiceRelayActive || !this.localStream) return;
    const audioTracks = this.localStream.getAudioTracks();
    if (!audioTracks.some(t => t.enabled)) return; // Muted: nothing to send.

    let options = {};
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      options = { mimeType: 'audio/webm;codecs=opus' };
    } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
      options = { mimeType: 'audio/mp4' };
    }

    this.isVoiceRelayActive = true;
    this.recordRelayClip(new MediaStream(audioTracks), options);
  }

  // Each clip is a separate recording, because a slice cut from the middle of
  // one recording has no header and can't be played by itself.
  recordRelayClip(stream, options) {
    if (!this.isVoiceRelayActive) return;
    let recorder;
    try {
      recorder = new MediaRecorder(stream, options);
    } catch (e) {
      console.warn('[WebRTC] Voice relay fallback start failed:', e);
      this.isVoiceRelayActive = false;
      return;
    }

    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0 || !this.needsVoiceRelay()) return;
      const reader = new FileReader();
      reader.onloadend = () => {
        const audioData = reader.result.split(',')[1];
        if (audioData) {
          this.socket.emit('voice-packet', { audioData, mimeType: options.mimeType || 'audio/webm' });
        }
      };
      reader.readAsDataURL(e.data);
    };
    recorder.onstop = () => this.recordRelayClip(stream, options);

    this.voiceRelayRecorder = recorder;
    recorder.start();
    setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, RELAY_CLIP_MS);
  }

  stopVoiceRelay() {
    this.isVoiceRelayActive = false;
    if (this.voiceRelayRecorder && this.voiceRelayRecorder.state !== 'inactive') {
      try { this.voiceRelayRecorder.stop(); } catch (e) {}
    }
  }

  // 1. Initialize Local Media (Webcam & Microphone with synthetic fallback)
  async initLocalMedia(videoElement, audioEnabled = true, videoEnabled = true) {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user'
          }
        });
        this.cameraTrack = this.localStream.getVideoTracks()[0] || null;
        this.usesRealCamera = Boolean(this.cameraTrack);
      }
    } catch (err) {
      console.warn('Real camera/mic unavailable or permission denied. Using synthetic media stream for lab demonstration.', err);
      this.localStream = this.createSyntheticStream('Lab Member');
    }

    if (!this.localStream) {
      this.localStream = this.createSyntheticStream('Lab Member');
    }

    // Set initial mute states
    this.setAudioEnabled(audioEnabled);
    this.setVideoEnabled(videoEnabled);

    if (videoElement) {
      videoElement.srcObject = this.localStream;
      videoElement.muted = true; // Avoid feedback
      videoElement.play().catch(e => console.log('Video auto-play suppressed:', e));
    }

    this.setupAudioAnalysis(this.localStream);
    return this.localStream;
  }

  // Generates synthetic video and audio for demonstration / test mode
  createSyntheticStream(label = 'Lab Member') {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');

    let angle = 0;
    const draw = () => {
      angle += 0.03;
      // Background gradient
      const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      grad.addColorStop(0, '#0d222a');
      grad.addColorStop(1, '#030c10');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Cybernetic grid
      ctx.strokeStyle = 'rgba(47, 179, 224, 0.15)';
      ctx.lineWidth = 1;
      for (let x = 0; x < canvas.width; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      // Animated security ring
      const cx = canvas.width / 2;
      const cy = canvas.height / 2 - 20;
      ctx.beginPath();
      ctx.arc(cx, cy, 60 + Math.sin(angle) * 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(76, 184, 72, 0.6)';
      ctx.lineWidth = 4;
      ctx.stroke();

      // Lab Avatar Icon
      ctx.fillStyle = '#eef6f3';
      ctx.font = 'bold 36px Outfit, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label.split(' ').map(w => w[0]).join('').slice(0, 2), cx, cy);

      // Watermark Text
      ctx.fillStyle = '#6fd4f4';
      ctx.font = '600 16px Inter, sans-serif';
      ctx.fillText(`Placeholder video (no camera): ${label}`, cx, canvas.height - 50);

      ctx.fillStyle = '#7b9794';
      ctx.font = '12px JetBrains Mono, monospace';
      ctx.fillText(new Date().toLocaleTimeString(), cx, canvas.height - 25);

      requestAnimationFrame(draw);
    };
    draw();

    const videoStream = canvas.captureStream(30);

    // Create synthetic silent/low-beep audio track
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0.001; // nearly silent
    osc.connect(gain);
    const dest = ac.createMediaStreamDestination();
    gain.connect(dest);
    osc.start();

    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ]);
    return combined;
  }

  // 2. Audio Level Analyzer for Active Speaker Detection
  setupAudioAnalysis(stream) {
    try {
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) return;

      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.audioAnalyser = this.audioContext.createAnalyser();
      this.audioAnalyser.fftSize = 256;
      source.connect(this.audioAnalyser);

      const bufferLength = this.audioAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const checkVolume = () => {
        if (!this.audioAnalyser) return;
        this.audioAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avg = sum / bufferLength;

        // Callback with normalized volume 0..100
        if (this.onActiveSpeaker) {
          const isSpeaking = avg > 18;
          this.onActiveSpeaker('local', avg, isSpeaking);
        }
        requestAnimationFrame(checkVolume);
      };
      checkVolume();
    } catch (e) {
      console.warn('Audio analysis setup failed:', e);
    }
  }

  setIceServers(iceServers) {
    if (Array.isArray(iceServers) && iceServers.length) {
      this.rtcConfig = { ...this.rtcConfig, iceServers };
    }
  }

  reportConnection(peerId, status) {
    if (this.onPeerConnectionState) this.onPeerConnectionState(peerId, status);
  }

  // Browsers can sit in "connecting" forever when no route exists, so a
  // connection that isn't up within 20 seconds counts as failed.
  armConnectWatchdog(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    clearTimeout(peer.watchdog);
    peer.watchdog = setTimeout(() => {
      if (this.peers.get(peerId) !== peer || peer.pc.connectionState === 'connected') return;
      this.startVoiceRelay();
      this.reportConnection(peerId, 'failed');
      this.restartConnection(peerId);
    }, 20000);
  }

  // A failed connection is retried with fresh routes (ICE restart) a few times.
  // Only the side that made the first offer restarts, so the two never collide.
  restartConnection(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.isInitiator || peer.restarts >= 3 || this.closed) return;
    peer.restarts += 1;
    this.armConnectWatchdog(peerId);
    peer.pc.createOffer({ iceRestart: true })
      .then((offer) => peer.pc.setLocalDescription(offer))
      .then(() => this.socket.emit('signal', {
        targetPeerId: peerId,
        signalData: { type: 'offer', sdp: peer.pc.localDescription }
      }))
      .catch((err) => console.warn('[WebRTC] ICE restart failed:', err));
  }

  // 3. WebRTC Peer Connection Factory
  createPeerConnection(peerId, isInitiator, peerUser) {
    if (this.peers.has(peerId)) {
      return this.peers.get(peerId).pc;
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    const peerData = { pc, stream: new MediaStream(), user: peerUser, candidateQueue: [], isInitiator, restarts: 0, retryTimer: null, watchdog: null };
    this.reportConnection(peerId, 'connecting');
    this.peers.set(peerId, peerData);

    // Add local tracks to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        try {
          pc.addTrack(track, this.localStream);
        } catch (e) {
          console.warn('[WebRTC] addTrack warning:', e);
        }
      });
    }

    // Remote track received
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Received track from peer ${peerId}:`, event.track ? event.track.kind : 'unknown');

      let streamToUse = (event.streams && event.streams[0]) ? event.streams[0] : peerData.stream;
      if (event.streams && event.streams[0]) {
        event.streams[0].getTracks().forEach((track) => {
          if (!peerData.stream.getTracks().some(t => t.id === track.id)) {
            peerData.stream.addTrack(track);
          }
        });
      } else if (event.track) {
        if (!peerData.stream.getTracks().some(t => t.id === event.track.id)) {
          peerData.stream.addTrack(event.track);
        }
      }

      if (this.onPeerStreamAdded) {
        this.onPeerStreamAdded(peerId, streamToUse, peerData.user || peerUser);
      }
    };

    // ICE Candidate generation
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('signal', {
          targetPeerId: peerId,
          signalData: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      console.log(`[WebRTC] Connection state with ${peerId}:`, st);
      clearTimeout(peerData.retryTimer);
      if (st === 'connected') {
        peerData.restarts = 0;
        clearTimeout(peerData.watchdog);
        this.reportConnection(peerId, 'connected');
      } else if (st === 'failed') {
        clearTimeout(peerData.watchdog);
        this.startVoiceRelay();
        this.reportConnection(peerId, 'failed');
        this.restartConnection(peerId);
      } else if (st === 'disconnected') {
        // Often recovers by itself; retry only if it doesn't within a few seconds.
        this.startVoiceRelay();
        this.reportConnection(peerId, 'connecting');
        peerData.retryTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected') {
            this.reportConnection(peerId, 'failed');
            this.restartConnection(peerId);
          }
        }, 5000);
      } else if (st === 'connecting') {
        this.reportConnection(peerId, 'connecting');
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ICE Connection state with ${peerId}:`, pc.iceConnectionState);
    };

    this.armConnectWatchdog(peerId);

    // Initiator sends SDP Offer
    if (isInitiator) {
      pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true })
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          console.log(`[WebRTC] Sending offer to ${peerId}`);
          this.socket.emit('signal', {
            targetPeerId: peerId,
            signalData: { type: 'offer', sdp: pc.localDescription }
          });
        })
        .catch((err) => console.error('[WebRTC] Failed to create offer:', err));
    }

    return pc;
  }

  // 4. Handle incoming WebRTC signaling signals
  async handleSignal(fromPeerId, signalData, fromUser) {
    let peer = this.peers.get(fromPeerId);

    if (!peer) {
      this.createPeerConnection(fromPeerId, false, fromUser);
      peer = this.peers.get(fromPeerId);
    }

    const pc = peer.pc;

    try {
      if (signalData.type === 'offer') {
        console.log(`[WebRTC] Received offer from ${fromPeerId}`);
        await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));

        // Flush any queued ICE candidates
        if (peer.candidateQueue && peer.candidateQueue.length > 0) {
          for (const cand of peer.candidateQueue) {
            try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) { console.warn('Queued ICE failed:', e); }
          }
          peer.candidateQueue = [];
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log(`[WebRTC] Sending answer to ${fromPeerId}`);
        this.socket.emit('signal', {
          targetPeerId: fromPeerId,
          signalData: { type: 'answer', sdp: pc.localDescription }
        });
      } else if (signalData.type === 'answer') {
        console.log(`[WebRTC] Received answer from ${fromPeerId}`);
        await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));

        // Flush any queued ICE candidates
        if (peer.candidateQueue && peer.candidateQueue.length > 0) {
          for (const cand of peer.candidateQueue) {
            try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) { console.warn('Queued ICE failed:', e); }
          }
          peer.candidateQueue = [];
        }
      } else if (signalData.type === 'candidate') {
        if (signalData.candidate) {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
            } catch (err) {
              console.warn('[WebRTC] addIceCandidate error:', err);
            }
          } else {
            // Queue candidate until remote description is set
            peer.candidateQueue = peer.candidateQueue || [];
            peer.candidateQueue.push(signalData.candidate);
          }
        }
      }
    } catch (err) {
      console.error('[WebRTC] Error in handleSignal:', err);
    }
  }

  // 5. Screen Sharing
  async toggleScreenShare(localVideoElement) {
    if (this.isScreenSharing) {
      // Revert to camera
      this.stopScreenShare(localVideoElement);
      return false;
    } else {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: 'always' },
          audio: true
        });

        const screenTrack = this.screenStream.getVideoTracks()[0];

        // Replace track on all peer connections
        this.peers.forEach((peer) => {
          const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) {
            sender.replaceTrack(screenTrack);
          }
        });

        if (localVideoElement) {
          localVideoElement.srcObject = this.screenStream;
          localVideoElement.classList.remove('mirrored');
        }

        screenTrack.onended = () => {
          this.stopScreenShare(localVideoElement);
        };

        this.isScreenSharing = true;
        this.socket.emit('toggle-media-state', { type: 'screen', enabled: true });
        return true;
      } catch (err) {
        console.warn('Screen share canceled or not supported:', err);
        return false;
      }
    }
  }

  stopScreenShare(localVideoElement) {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }

    const camTrack = this.localStream ? this.localStream.getVideoTracks()[0] : null;
    if (camTrack) {
      this.peers.forEach((peer) => {
        const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          sender.replaceTrack(camTrack);
        }
      });
      if (localVideoElement) {
        localVideoElement.srcObject = this.localStream;
        localVideoElement.classList.add('mirrored');
      }
    }

    this.isScreenSharing = false;
    this.socket.emit('toggle-media-state', { type: 'screen', enabled: false });
    if (this.onScreenShareChanged) this.onScreenShareChanged(false);
  }

  // 6. Audio/Video controls
  setAudioEnabled(enabled) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
      this.socket.emit('toggle-media-state', { type: 'audio', enabled });
    }
  }

  // Resolves to true if the camera ended up in the requested state.
  setVideoEnabled(enabled) {
    if (!this.localStream) return Promise.resolve(false);
    this.cameraQueue = this.cameraQueue.then(async () => {
      let applied = true;
      if (this.usesRealCamera) {
        applied = enabled ? await this.startCamera() : this.stopCamera();
      } else {
        this.localStream.getVideoTracks().forEach(t => { t.enabled = enabled; });
      }
      if (applied) this.socket.emit('toggle-media-state', { type: 'video', enabled });
      return applied;
    });
    return this.cameraQueue;
  }

  // Releases the hardware, so the camera's light goes off. Peers get a black
  // picture in its place, which keeps their video connection ready for later.
  stopCamera() {
    const track = this.cameraTrack;
    if (!track) return true;
    this.cameraTrack = null;
    track.stop();
    this.swapLocalVideoTrack(track, this.getBlankVideoTrack());
    return true;
  }

  async startCamera() {
    if (this.cameraTrack) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
      });
      const track = stream.getVideoTracks()[0];
      if (this.closed) {
        track.stop();
        return false;
      }
      this.cameraTrack = track;
      this.swapLocalVideoTrack(this.blankVideoTrack, track);
      this.stopBlankPainter();
      return true;
    } catch (err) {
      console.warn('Could not turn the camera back on:', err);
      return false;
    }
  }

  swapLocalVideoTrack(oldTrack, newTrack) {
    this.localStream.removeTrack(oldTrack);
    this.localStream.addTrack(newTrack);
    if (this.isScreenSharing) return; // Peers keep the screen until sharing stops.
    this.peers.forEach((peer) => {
      const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(newTrack).catch(e => console.warn('[WebRTC] replaceTrack failed:', e));
    });
  }

  getBlankVideoTrack() {
    if (!this.blankVideoTrack) {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      this.paintBlankFrame = () => {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      };
      this.paintBlankFrame();
      this.blankVideoTrack = canvas.captureStream(1).getVideoTracks()[0];
    }
    if (!this.blankPainter) this.blankPainter = setInterval(this.paintBlankFrame, 1000);
    return this.blankVideoTrack;
  }

  stopBlankPainter() {
    clearInterval(this.blankPainter);
    this.blankPainter = null;
  }

  // 7. Meeting Recording (Local WebM)
  startRecording() {
    if (!this.localStream) return false;
    this.recordedChunks = [];

    // A fixed copy of the track list: switching the camera must not abort the recording.
    const recordedStream = new MediaStream(this.localStream.getTracks());

    try {
      const options = { mimeType: 'video/webm;codecs=vp9,opus' };
      this.mediaRecorder = new MediaRecorder(recordedStream, options);
    } catch (e) {
      try {
        this.mediaRecorder = new MediaRecorder(recordedStream);
      } catch (e2) {
        console.error('MediaRecorder not supported:', e2);
        return false;
      }
    }

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `Lab_Meeting_Recording_${new Date().toISOString().slice(0, 10)}.webm`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
    };

    this.mediaRecorder.start(1000);
    return true;
  }

  stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      return true;
    }
    return false;
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    this.relayPlayback.delete(peerId);
    if (peer) {
      clearTimeout(peer.retryTimer);
      clearTimeout(peer.watchdog);
      peer.pc.close();
      this.peers.delete(peerId);
      if (this.onPeerStreamRemoved) {
        this.onPeerStreamRemoved(peerId);
      }
    }
  }

  closeAll() {
    this.closed = true;
    this.stopBlankPainter();
    this.peers.forEach((peer) => { clearTimeout(peer.retryTimer); clearTimeout(peer.watchdog); peer.pc.close(); });
    this.peers.clear();

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
    }
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}

window.WebRTCManager = WebRTCManager;
