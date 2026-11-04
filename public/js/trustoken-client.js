/**
 * TrusMeet: Client-Side C-DAC TrusToken PKI Integration Suite
 * Compliant with IS-16695 Part 1 & 2, PKCS#11, and ISO-7816.
 */

class TrusTokenClient {
  constructor() {
    this.hardwareStatus = null;
    this.enrolledTokens = [];
    this.currentSession = null;
    this.heartbeatTimer = null;
    this.onHeartbeatStatusChange = null;
    this.simulatedDongleAttached = true; // Can be toggled for security demonstration
  }

  // 1. Fetch hardware status and enrolled tokens
  async fetchStatus() {
    try {
      const res = await fetch('/api/trustoken/hardware');
      const data = await res.json();
      if (data.success) {
        this.hardwareStatus = data.data;
      }

      const tRes = await fetch('/api/trustoken/tokens');
      const tData = await tRes.json();
      if (tData.success) {
        this.enrolledTokens = tData.tokens;
      }

      return {
        hardware: this.hardwareStatus,
        tokens: this.enrolledTokens
      };
    } catch (err) {
      console.error('Failed to query TrusToken status:', err);
      return null;
    }
  }

  // 2. Perform Passwordless Cryptographic Login
  async authenticateWithToken(userId, pin) {
    if (!this.simulatedDongleAttached && !this.hardwareStatus?.hardware_dongle_present) {
      throw new Error('TrusToken USB Dongle is not inserted. Please connect your hardware token.');
    }

    // Step 1: Request 256-bit Challenge from server
    const chRes = await fetch('/api/trustoken/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'lab_conference_login' })
    });
    const chData = await chRes.json();
    if (!chData.success) {
      throw new Error(chData.error || 'Failed to acquire cryptographic challenge');
    }

    // Step 2: Submit PIN and Challenge to on-chip signature engine
    const loginRes = await fetch('/api/trustoken/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        pin: pin,
        challenge: chData.challenge
      })
    });

    const loginData = await loginRes.json();
    if (!loginData.success) {
      throw new Error(loginData.error || 'TrusToken PIN or Hardware Authentication Failed');
    }

    this.currentSession = loginData.session;

    // Start periodic hardware presence heartbeat
    this.startHeartbeat(userId, pin);

    return this.currentSession;
  }

  // 3. Hardware Presence Heartbeat ("Security Liveness")
  startHeartbeat(userId, pin) {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (!this.currentSession) return;

      // If user simulated pulling the dongle out
      if (!this.simulatedDongleAttached && !this.hardwareStatus?.hardware_dongle_present) {
        console.warn('TrusToken USB Dongle was detached!');
        if (this.onHeartbeatStatusChange) {
          this.onHeartbeatStatusChange(false, 'TrusToken USB Dongle was unplugged from the workstation.');
        }
        return;
      }

      try {
        const res = await fetch('/api/trustoken/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionToken: this.currentSession.sessionToken,
            user_id: userId,
            pin: pin
          })
        });

        const data = await res.json();
        if (data.success && data.heartbeat_verified) {
          if (this.onHeartbeatStatusChange) {
            this.onHeartbeatStatusChange(true, 'Hardware token presence verified');
          }
        } else {
          if (this.onHeartbeatStatusChange) {
            this.onHeartbeatStatusChange(false, data.error || 'Heartbeat check failed');
          }
        }
      } catch (err) {
        if (this.onHeartbeatStatusChange) {
          this.onHeartbeatStatusChange(false, 'Connection to TrusToken PKI bridge lost');
        }
      }
    }, 12000); // Check every 12 seconds
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // 4. Digitally Sign Meeting Minutes
  async signMeetingMinutes(roomId, userId, pin, minutesText) {
    if (!this.simulatedDongleAttached && !this.hardwareStatus?.hardware_dongle_present) {
      throw new Error('TrusToken USB Dongle is not inserted. Please connect your hardware token.');
    }

    const res = await fetch('/api/trustoken/sign-minutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId,
        user_id: userId,
        pin,
        minutesText
      })
    });

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to digitally sign meeting minutes');
    }

    return data;
  }

  // Toggle simulated physical dongle attachment (for demonstration of security lockout)
  toggleDongleAttachment() {
    this.simulatedDongleAttached = !this.simulatedDongleAttached;
    return this.simulatedDongleAttached;
  }
}

window.TrusTokenClient = TrusTokenClient;
