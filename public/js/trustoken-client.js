/**
 * TrusMeet: accounts, meetings and USB token presence monitoring.
 *
 * Presence comes from trustoken_agent.py running on this computer. It shows a
 * matching USB device is plugged in; nothing here is signed by the token.
 */

const HELPER_STATUS_URL = 'http://127.0.0.1:8765/status';
const PRESENCE_POLL_MS = 2000;
const HELPER_TIMEOUT_MS = 1500;
const HELPER_FAILURES_BEFORE_LOST = 2;
// Chrome holds the request open while its "allow local network" prompt is showing.
const PERMISSION_PROMPT_TIMEOUT_MS = 120000;
const LOOPBACK_PERMISSION_NAMES = ['loopback-network', 'local-network-access'];

const SESSION_STORAGE_KEY = 'trusmeet-session';

class TrusTokenClient {
  constructor() {
    this.currentSession = null;
    this.presenceTicker = null;
  }

  async api(url, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.currentSession) headers.Authorization = `Bearer ${this.currentSession.sessionToken}`;
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'The request failed');
    return data;
  }

  // 1. Accounts
  rememberSession(session) {
    this.currentSession = session;
    try {
      if (session) sessionStorage.setItem(SESSION_STORAGE_KEY, session.sessionToken);
      else sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (err) {
      // Without storage, a page reload simply asks for a login again.
    }
    return session;
  }

  async register(details) {
    const { session } = await this.api('/api/auth/register', { method: 'POST', body: details });
    return this.rememberSession(session);
  }

  async login(username, password) {
    const { session } = await this.api('/api/auth/login', { method: 'POST', body: { username, password } });
    return this.rememberSession(session);
  }

  async restoreSession() {
    let sessionToken = null;
    try {
      sessionToken = sessionStorage.getItem(SESSION_STORAGE_KEY);
    } catch (err) {
      return null;
    }
    if (!sessionToken) return null;
    this.currentSession = { sessionToken };
    try {
      const { session } = await this.api('/api/auth/me');
      return this.rememberSession(session);
    } catch (err) {
      this.rememberSession(null);
      return null;
    }
  }

  async logout() {
    try {
      await this.api('/api/auth/logout', { method: 'POST', body: {} });
    } finally {
      this.rememberSession(null);
    }
  }

  async setTokenChoice(hasToken) {
    await this.api('/api/profile/token', { method: 'POST', body: { hasToken } });
    this.currentSession.has_token = hasToken;
  }

  // Meetings
  async createMeeting(name) {
    return (await this.api('/api/meetings', { method: 'POST', body: { name } })).meeting;
  }

  async myMeetings() {
    return (await this.api('/api/meetings/mine')).meetings;
  }

  // STUN plus, when set up, Metered relay (TURN) servers for this session
  async iceServers() {
    return (await this.api('/api/ice-servers')).iceServers;
  }

  // 2. Ask the local helper whether the USB token is plugged in
  async checkLocalToken() {
    const permission = await this.helperPermission();
    try {
      const res = await fetch(HELPER_STATUS_URL, {
        cache: 'no-store',
        signal: AbortSignal.timeout(permission === 'prompt' ? PERMISSION_PROMPT_TIMEOUT_MS : HELPER_TIMEOUT_MS)
      });
      if (!res.ok) return { helperRunning: false, present: false, permission };
      const data = await res.json();
      return { helperRunning: true, present: data.present === true, permission };
    } catch (err) {
      return { helperRunning: false, present: false, permission };
    }
  }

  // Chrome's permission for a web page to reach this computer's own addresses.
  // Returns 'granted', 'prompt', 'denied', or null if the browser has no such permission.
  async helperPermission() {
    for (const name of LOOPBACK_PERMISSION_NAMES) {
      try {
        return (await navigator.permissions.query({ name })).state;
      } catch (err) {
        // This browser uses a different name, or has no such permission.
      }
    }
    return null;
  }

  // 3. Poll presence. A brief helper hiccup is tolerated; an unplugged token is not.
  startPresenceMonitor(onUpdate) {
    this.stopPresenceMonitor();
    let helperFailures = 0;
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      // Only while Chrome's prompt is possible can a slow check mean "waiting for Allow".
      const permission = await this.helperPermission();
      const waitingNotice = permission === 'prompt' ? setTimeout(() => {
        onUpdate({ helperRunning: false, present: false, permission, waiting: true });
      }, HELPER_TIMEOUT_MS) : null;
      const result = await this.checkLocalToken();
      clearTimeout(waitingNotice);
      inFlight = false;

      if (!result.helperRunning) {
        helperFailures += 1;
        if (helperFailures < HELPER_FAILURES_BEFORE_LOST) return;
      } else {
        helperFailures = 0;
      }
      onUpdate(result);
    };

    // Worker timers keep their pace when this tab is in the background, so the
    // server's lease is not missed just because the meeting tab is hidden.
    const workerSource = `setInterval(() => postMessage(0), ${PRESENCE_POLL_MS});`;
    const worker = new Worker(URL.createObjectURL(new Blob([workerSource])));
    worker.onmessage = tick;
    this.presenceTicker = worker;
    tick();
  }

  stopPresenceMonitor() {
    if (this.presenceTicker) {
      this.presenceTicker.terminate();
      this.presenceTicker = null;
    }
  }

  // 5. Digitally sign meeting minutes
  // decision: 'approved' or 'not_approved' (with an optional reason)
  async signMeetingMinutes(roomId, password, minutesText, decision = 'approved', reason = '') {
    return this.api('/api/minutes/sign', { method: 'POST', body: { roomId, password, minutesText, decision, reason } });
  }
}

window.TrusTokenClient = TrusTokenClient;
