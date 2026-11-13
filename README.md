# TrusMeet: Video Meetings with a TrusToken Check

Built for **de.ci.phe.red. Lab, IIT Bhilai**.

**TrusMeet** lets anyone with a sign-up code create a profile, host a meeting and share its link. People with a TrusToken plugged in enter directly. People without one can still join as unverified users once the host accepts them.

> **Project status: demo, not hardware authentication.** The token check only shows that a device with the right USB ID was reported by the person's computer, and a modified client can fake it. Login and signatures use passwords and software keys, not the token's chip, so this project does not claim compliance with IS 16695, PKCS#11 signing or PKCS#7. Do not rely on it for confidential meetings or for signatures that must be legally binding.

---

## How It Works

### 1. Profiles
- Sign up with a name, username, password and the sign-up code.
- After sign-up the app asks: **Do you have a USB token?** The answer can be changed later from the lobby.
- Passwords are stored as salted scrypt hashes. Each person also gets a software signing key locked with their password.
- Five wrong passwords block an account for 15 minutes. Sessions last 12 hours.

### 2. Meetings
- Anyone logged in can click **New Meeting**, which makes them the host and creates a long random link.
- Links are private: there is no public list of meetings or users.
- Meetings hold up to 8 people, because each person connects directly to every other person.

### 3. Who Enters a Meeting

| Person | What happens | Badge |
|---|---|---|
| Host | Enters their own meeting, with or without a token | Depends on token |
| USB token plugged in | Enters directly | **Token Detected** |
| No token | Waits until the host accepts | **Unverified** |
| Removed earlier by the host | Waits until the host lets them back in, even with a token | Depends on token |

- The server gives a waiting person no video connections, chat, minutes or participant list.
- Someone the host accepted can return to that meeting without asking again.
- If a person's token is unplugged, or no report arrives for 8 seconds (`TOKEN_LEASE_MS`), they leave the meeting but stay logged in. They can plug it back in, or ask the host to accept them as unverified.
- The host can accept, decline, mute, remove, lock the meeting and end it.

### 4. Signing Meeting Minutes
- Signing needs your password, and you must be in the meeting.
- The signature covers the meeting ID, time, signer, token status and a SHA-256 hash of the text. It is made by a software key and is not a PKCS#7/CMS signature.

### Making "Token Detected" Into Real Verification
The badge changes to **Verified** when the token's chip signs a server challenge. Only `assessToken()` in `server.js` has to change. This is blocked for now: sessions on the physical token fail with error `0x6A88`, which needs an answer from the token's developers.

### Known Gaps
- Private keys from earlier versions remain in git history and should be purged. The live keys have been replaced.
- Chat and the voice relay pass through the server without end-to-end encryption.
- Each signing key is locked with its owner's password, on the server.
- There is no forgot-password email. An admin runs `python3 trustoken_bridge.py admin-reset <username>`, which prints a new password and issues a new signing key.

---

## Running the Application

### 1. Start the Server
```bash
node server.js
```

- **HTTPS**: `https://localhost:8443`, reachable from other computers (self-signed certificate)
- **HTTP**: `http://localhost:8080`, this computer only, used by the public tunnel

### 2. Get the Sign-Up Code
On first start the server creates `data/signup-code.txt`. Share that code with the people who may create profiles. To choose your own, set the `SIGNUP_CODE` environment variable.

### 3. Token Helper (only for people with a USB token, on their own Linux computer)
```bash
python3 trustoken_agent.py
```
Keep it running during the meeting. On the public link, Chrome asks for permission to access devices on the local network: click **Allow**.

### 4. For People Outside the Campus Network
```bash
./start-public-tunnel.sh
```
This creates a public HTTPS link.

### 5. Tests
```bash
npm test
```

---

## Video Across Different Networks (TURN Relay)

**On campus (no account needed):** run `./start-turn.sh` in its own terminal, then
start (or restart) `node server.js`. The relay runs on this computer (port 3479
UDP/TCP, relay ports 50000-50999). It forwards only to this computer's own
addresses, so it can't be used to reach other machines. Its secret is kept in
`data/turn-secret`.

**Off campus (outside users without Tailscale):** use Metered as well:

Video normally goes directly between browsers. Across some networks (campus NAT,
mobile data) that fails, and a relay is needed. The app uses Metered's TURN service:

1. Sign up at https://www.metered.ca, open **TURN Server**, and note your app domain
   (`yourapp.metered.live`) and an **API key** from the credentials page.
2. Create `data/metered.json` (not committed) and make it private:
   ```bash
   printf '{ "domain": "yourapp.metered.live", "apiKey": "PASTE_KEY" }\n' > data/metered.json
   chmod 600 data/metered.json
   ```
   Or set `METERED_DOMAIN` and `METERED_API_KEY` in the environment instead.
3. Restart the server. It prints `Relay (TURN): Metered, ...` when it's configured.

Only signed-in users can get relay credentials (`GET /api/ice-servers`). Calls stay
encrypted (DTLS-SRTP), and Metered can't see the video. Relayed video counts toward
Metered's free monthly allowance. Without these settings, the app uses STUN only.
If a participant's video can't connect, their tile says so and the app retries.

## Using TrusMeet at Another Institute (Branding)

The app header, browser tab, pre-filled minutes and the minutes PDF letterhead
use this installation's branding. The default is de.ci.phe.red. Lab, IIT Bhilai.
Another institute sets its own, without changing code:

```bash
python3 set-branding.py --name "Crypto Lab, IIT Example" \
  --organisation "Indian Institute of Technology Example" \
  --department "Department of CSE, Crypto Lab" \
  --logo ~/Downloads/logo.png
python3 set-branding.py --show      # current settings
python3 set-branding.py --reset     # back to the defaults
```

This writes `data/branding/` (not committed). The logo is turned into a header
icon, a browser tab icon and a JPEG for the PDF letterhead (needs Pillow:
`sudo apt install python3-pil`). Reload the page; no restart is needed.

## Repository Structure

```
trustoken-lab-meet/
├── server.js               # Express + Socket.IO: accounts API, meetings, waiting room, signaling
├── trustoken_bridge.py     # Accounts in SQLite, passwords, signing keys, CA, driver info
├── trustoken_agent.py      # Local helper: reports whether the USB token is plugged in
├── test/                   # Server and helper tests (npm test)
├── data/                   # Created at runtime and never committed
│   ├── trusmeet.db         # Accounts and encrypted signing keys
│   ├── meetings.json       # Meetings, acceptances and removals
│   ├── lab_ca.key/.crt     # Certificate authority for signing keys
│   └── signup-code.txt     # Sign-up code
└── public/
    ├── index.html          # Lobby, meeting view and dialogs
    ├── css/index.css
    └── js/
        ├── app.js          # Interface and meeting state
        ├── webrtc.js       # WebRTC, audio analysis, screen share, recording
        └── trustoken-client.js # Accounts API and USB token presence monitor
```
