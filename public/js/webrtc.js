/**
 * TrusMeet: WebRTC Multi-Peer Mesh Engine & Media Coordinator
 * Handles WebRTC connections, audio level analysis, screen sharing, and recording.
 */

class WebRTCManager {
  constructor(socket, onPeerStreamAdded, onPeerStreamRemoved, onActiveSpeaker) {
    this.socket = socket;
    this.onPeerStreamAdded = onPeerStreamAdded;
    this.onPeerStreamRemoved = onPeerStreamRemoved;
    this.onActiveSpeaker = onActiveSpeaker;

    this.localStream = null;
    this.screenStream = null;
    this.isScreenSharing = false;

    this.peers = new Map(); // peerId -> { pc, stream, user }
    this.audioContext = null;
    this.audioAnalyser = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];

    // High-Reliability STUN Configuration (Google & Cloudflare fast relays)
    this.rtcConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ],
      iceCandidatePoolSize: 10
    };

    // Voice Relay over WebSocket fallback
    this.voiceRelayRecorder = null;
    this.isVoiceRelayActive = false;
    this.setupVoicePacketReceiver();
  }

  // Setup WebSocket Voice Packet Receiver (Works over carrier CGNAT & firewall)
  setupVoicePacketReceiver() {
    if (!this.socket) return;
    this.socket.on('voice-packet-broadcast', async ({ senderId, senderName, audioData, mimeType }) => {
      try {
        const audioBlob = this.base64ToBlob(audioData, mimeType || 'audio/webm;codecs=opus');
        const audioUrl = URL.createObjectURL(audioBlob);
        const audioEl = new Audio(audioUrl);
        audioEl.volume = 1.0;
        await audioEl.play();
        setTimeout(() => URL.revokeObjectURL(audioUrl), 5000);
      } catch (err) {
        // Can be suppressed if mobile autoplay policy blocks
      }
    });
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
    try {
      const audioTracks = this.localStream.getAudioTracks();
      if (!audioTracks || audioTracks.length === 0) return;

      const audioOnlyStream = new MediaStream(audioTracks);
      let options = {};
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        options = { mimeType: 'audio/webm;codecs=opus' };
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        options = { mimeType: 'audio/mp4' };
      }

      this.voiceRelayRecorder = new MediaRecorder(audioOnlyStream, options);
      this.voiceRelayRecorder.ondataavailable = async (e) => {
        if (e.data && e.data.size > 0 && this.socket) {
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64data = reader.result.split(',')[1];
            if (base64data) {
              this.socket.emit('voice-packet', {
                audioData: base64data,
                mimeType: options.mimeType || 'audio/webm'
              });
            }
          };
          reader.readAsDataURL(e.data);
        }
      };

      this.voiceRelayRecorder.start(400); // 400ms slices for smooth real-time voice
      this.isVoiceRelayActive = true;
      console.log('[WebRTC] Voice Relay Fallback active (Zero-NAT packet delivery).');
    } catch (e) {
      console.warn('[WebRTC] Voice relay fallback start failed:', e);
    }
  }

  stopVoiceRelay() {
    if (this.voiceRelayRecorder && this.voiceRelayRecorder.state !== 'inactive') {
      try { this.voiceRelayRecorder.stop(); } catch (e) {}
    }
    this.isVoiceRelayActive = false;
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
      grad.addColorStop(0, '#0f172a');
      grad.addColorStop(1, '#020617');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Cybernetic grid
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.15)';
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
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
      ctx.lineWidth = 4;
      ctx.stroke();

      // Lab Avatar Icon
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 36px Outfit, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label.split(' ').map(w => w[0]).join('').slice(0, 2), cx, cy);

      // Watermark Text
      ctx.fillStyle = '#38bdf8';
      ctx.font = '600 16px Inter, sans-serif';
      ctx.fillText(`C-DAC TrusToken Video Node: ${label}`, cx, canvas.height - 50);

      ctx.fillStyle = '#64748b';
      ctx.font = '12px JetBrains Mono, monospace';
      ctx.fillText(`IS-16695 PKI Stream | ${new Date().toLocaleTimeString()}`, cx, canvas.height - 25);

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

  // 3. WebRTC Peer Connection Factory
  createPeerConnection(peerId, isInitiator, peerUser) {
    if (this.peers.has(peerId)) {
      return this.peers.get(peerId).pc;
    }

    const pc = new RTCPeerConnection(this.rtcConfig);
    const peerData = { pc, stream: new MediaStream(), user: peerUser, candidateQueue: [] };
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
      console.log(`[WebRTC] Connection state with ${peerId}:`, pc.connectionState);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        console.warn(`[WebRTC] Peer ${peerId} connection state: ${pc.connectionState}. Ensuring Voice Relay fallback is active.`);
        this.startVoiceRelay();
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ICE Connection state with ${peerId}:`, pc.iceConnectionState);
    };

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
  }

  // 6. Audio/Video controls
  setAudioEnabled(enabled) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
      this.socket.emit('toggle-media-state', { type: 'audio', enabled });
    }
  }

  setVideoEnabled(enabled) {
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach(t => { t.enabled = enabled; });
      this.socket.emit('toggle-media-state', { type: 'video', enabled });
    }
  }

  // 7. Meeting Recording (Local WebM)
  startRecording() {
    if (!this.localStream) return false;
    this.recordedChunks = [];

    try {
      const options = { mimeType: 'video/webm;codecs=vp9,opus' };
      this.mediaRecorder = new MediaRecorder(this.localStream, options);
    } catch (e) {
      try {
        this.mediaRecorder = new MediaRecorder(this.localStream);
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
    if (peer) {
      peer.pc.close();
      this.peers.delete(peerId);
      if (this.onPeerStreamRemoved) {
        this.onPeerStreamRemoved(peerId);
      }
    }
  }

  closeAll() {
    this.peers.forEach((peer) => peer.pc.close());
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
