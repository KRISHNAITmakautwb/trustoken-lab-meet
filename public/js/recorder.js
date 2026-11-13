/**
 * TrusMeet: whole-meeting recorder.
 * Draws every participant's video (or a name card when their camera is off)
 * into one picture, mixes everyone's voice, and records both into one WebM file.
 * Everything happens in this browser; nothing is uploaded.
 */

const REC_WIDTH = 1280;
const REC_HEIGHT = 720;
const REC_FPS = 25;
const REC_GAP = 8;

class MeetingRecorder {
  // getParticipants() -> [{ id, name, video, cameraOff, mirrored, audioStream }]
  constructor(getParticipants) {
    this.getParticipants = getParticipants;
    this.canvas = null;
    this.ctx = null;
    this.audioContext = null;
    this.mixer = null;
    this.audioSources = new Map(); // track id -> source node
    this.recorder = null;
    this.chunks = [];
    this.ticker = null;
    this.startedAt = 0;
  }

  get active() {
    return Boolean(this.recorder && this.recorder.state !== 'inactive');
  }

  start() {
    if (this.active) return true;
    if (typeof MediaRecorder === 'undefined') return false;

    this.canvas = document.createElement('canvas');
    this.canvas.width = REC_WIDTH;
    this.canvas.height = REC_HEIGHT;
    this.ctx = this.canvas.getContext('2d');

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new Ctx();
    this.audioContext.resume().catch(() => {});
    this.mixer = this.audioContext.createMediaStreamDestination();
    this.audioSources.clear();

    this.draw();
    this.syncAudio();
    const stream = new MediaStream([
      ...this.canvas.captureStream(REC_FPS).getVideoTracks(),
      ...this.mixer.stream.getAudioTracks()
    ]);

    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((t) => MediaRecorder.isTypeSupported(t));
    try {
      this.recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 });
    } catch (err) {
      console.error('[Recorder] MediaRecorder not supported:', err);
      this.cleanup();
      return false;
    }

    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => this.save();
    this.startTicker();
    this.startedAt = Date.now();
    this.recorder.start(1000);
    return true;
  }

  stop() {
    if (!this.active) return false;
    this.recorder.stop();
    this.stopTicker();
    return true;
  }

  // A worker keeps the frames coming when this tab is in the background,
  // where ordinary timers slow down to once a second.
  startTicker() {
    const tick = () => {
      this.lastTick = Date.now();
      this.draw();
      this.syncAudio();
    };
    const useTimer = () => {
      if (this.timerId) return;
      this.timerId = setInterval(tick, Math.round(1000 / REC_FPS));
    };
    this.lastTick = 0;
    try {
      const code = `setInterval(() => postMessage(0), ${Math.round(1000 / REC_FPS)});`;
      this.tickerUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      this.ticker = new Worker(this.tickerUrl);
      this.ticker.onmessage = tick;
      this.ticker.onerror = useTimer;
      // If the worker never ticks (blocked by the browser), fall back to a timer.
      setTimeout(() => { if (this.recorder && !this.lastTick) useTimer(); }, 1000);
    } catch (err) {
      useTimer();
    }
  }

  stopTicker() {
    if (this.ticker) this.ticker.terminate();
    this.ticker = null;
    if (this.tickerUrl) URL.revokeObjectURL(this.tickerUrl);
    this.tickerUrl = null;
    clearInterval(this.timerId);
    this.timerId = null;
  }

  // Adds the voice of anyone who joined (or turned on a microphone) since the last check.
  syncAudio() {
    if (!this.audioContext) return;
    const live = new Set();
    for (const p of this.getParticipants()) {
      if (!p.audioStream) continue;
      for (const track of p.audioStream.getAudioTracks()) {
        if (track.readyState !== 'live') continue;
        live.add(track.id);
        if (this.audioSources.has(track.id)) continue;
        try {
          const source = this.audioContext.createMediaStreamSource(new MediaStream([track]));
          source.connect(this.mixer);
          this.audioSources.set(track.id, source);
        } catch (err) {
          console.warn('[Recorder] Could not add a voice:', err);
        }
      }
    }
    for (const [id, source] of this.audioSources) {
      if (!live.has(id)) {
        source.disconnect();
        this.audioSources.delete(id);
      }
    }
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const people = this.getParticipants();
    ctx.fillStyle = '#030c10';
    ctx.fillRect(0, 0, REC_WIDTH, REC_HEIGHT);

    const n = Math.max(1, people.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const w = (REC_WIDTH - REC_GAP * (cols + 1)) / cols;
    const h = (REC_HEIGHT - REC_GAP * (rows + 1)) / rows;

    people.forEach((p, i) => {
      const row = Math.floor(i / cols);
      // Centre a last row that isn't full.
      const inRow = row === rows - 1 ? n - row * cols : cols;
      const offset = (cols - inRow) * (w + REC_GAP) / 2;
      const x = REC_GAP + offset + (i % cols) * (w + REC_GAP);
      const y = REC_GAP + row * (h + REC_GAP);
      this.drawTile(p, x, y, w, h);
    });

    this.drawClock();
  }

  drawTile(p, x, y, w, h) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = '#0d222a';
    ctx.fillRect(x, y, w, h);

    const v = p.video;
    if (!p.cameraOff && v && v.videoWidth && v.readyState >= 2) {
      // Fit the whole picture in the tile (nothing cropped, important for shared screens).
      const scale = Math.min(w / v.videoWidth, h / v.videoHeight);
      const dw = v.videoWidth * scale;
      const dh = v.videoHeight * scale;
      const dx = x + (w - dw) / 2;
      const dy = y + (h - dh) / 2;
      if (p.mirrored) {
        ctx.translate(dx + dw, dy);
        ctx.scale(-1, 1);
        ctx.drawImage(v, 0, 0, dw, dh);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      } else {
        ctx.drawImage(v, dx, dy, dw, dh);
      }
    } else {
      this.drawNameCard(p.name, x, y, w, h);
    }

    // Name label
    const label = p.name || 'Participant';
    ctx.font = `600 ${Math.max(12, Math.round(h / 22))}px sans-serif`;
    const padding = 8;
    const textW = Math.min(ctx.measureText(label).width, w - 4 * padding);
    const boxH = Math.max(20, Math.round(h / 14));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(x + padding, y + h - boxH - padding, textW + 2 * padding, boxH);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 2 * padding, y + h - padding - boxH / 2, w - 4 * padding);
    ctx.restore();
  }

  drawNameCard(name, x, y, w, h) {
    const ctx = this.ctx;
    const r = Math.min(w, h) * 0.16;
    const cx = x + w / 2;
    const cy = y + h / 2 - r * 0.35;
    const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    grad.addColorStop(0, '#4a63c4');
    grad.addColorStop(1, '#2fb3e0');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    const initials = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2)).toUpperCase();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(r * 0.8)}px sans-serif`;
    ctx.fillText(initials, cx, cy);
    ctx.fillStyle = '#dbe9e5';
    ctx.font = `600 ${Math.max(12, Math.round(r * 0.38))}px sans-serif`;
    ctx.fillText(name || 'Participant', cx, cy + r + Math.max(16, r * 0.45), w * 0.9);
  }

  drawClock() {
    const ctx = this.ctx;
    const s = Math.floor((Date.now() - (this.startedAt || Date.now())) / 1000);
    const text = `● REC ${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    ctx.font = '600 16px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    const tw = ctx.measureText(text).width;
    ctx.fillRect(REC_WIDTH - tw - 28, 12, tw + 16, 26);
    ctx.fillStyle = '#f87171';
    ctx.fillText(text, REC_WIDTH - 20, 17);
  }

  save() {
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    this.chunks = [];
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    a.href = url;
    a.download = `Lab_Meeting_Recording_${stamp}.webm`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    this.cleanup();
  }

  cleanup() {
    this.stopTicker();
    this.audioSources.forEach((s) => s.disconnect());
    this.audioSources.clear();
    if (this.audioContext) this.audioContext.close().catch(() => {});
    this.audioContext = null;
    this.mixer = null;
    this.recorder = null;
    this.canvas = null;
    this.ctx = null;
  }
}

window.MeetingRecorder = MeetingRecorder;
