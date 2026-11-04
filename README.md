# TrusMeet: C-DAC TrusToken Lab Video Conference Platform

**TrusMeet** is a secure, zero-trust video conferencing system purpose-built for academic and research laboratory meetings (Principal Investigator & Lab Members). It integrates directly with the **C-DAC TrusToken** USB cryptographic hardware authentication device ([C-DAC TrusToken Specifications](https://www.cdac.in/index.aspx?id=product_details&productId=TrusToken)) compliant with **IS-16695 (Part 1 & Part 2)**, **ISO-7816**, and **PKCS#11**.

---

## 🛡️ Core Security Architecture & TrusToken Integration

TrusToken is an indigenous USB cryptographic security token developed by **C-DAC Noida & IIT Bhilai**. It features an on-chip cryptographic engine where the private key **never leaves the hardware container**.

TrusMeet utilizes the C-DAC TrusToken across **all major security facets** of the lab video conference:

### 1. Hardware-Enforced Passwordless Authentication (Login)
- The server generates a 256-bit cryptographically secure nonce (`CDAC_TRUSTOKEN_AUTH:<nonce>:<timestamp>`).
- The user is prompted for their **Hardware PIN** (the *"What you know"* factor).
- The TrusToken on-chip crypto engine signs the challenge using the hardware private key (RSA 2048/4096 or ECC P-256) (the *"What you have"* factor).
- The server validates the cryptographic signature against the lab member's X.509 certificate issued by the Lab Root CA.

### 2. Zero-Trust Room Gatekeeping & Role Access (PI vs Scholar)
- Meeting rooms can be configured with **"Mandatory TrusToken Access"**.
- Unauthenticated visitors or non-lab participants without a valid TrusToken certificate cannot enter.
- The PI's token certificate automatically grants Host authority (room locking, member moderation).

### 3. Hardware Presence Heartbeat ("Security Liveness")
- As highlighted on C-DAC's official product page (*"Secure Web Access, Secure Login and Heartbeat and many more"*):
- Every 12–15 seconds, a cryptographic micro-challenge is sent to the token.
- **If the USB dongle is unplugged** or removed from the computer, the application instantly flags the detachment, immediately mutes microphone audio, pauses the camera stream, and alerts other meeting attendees to prevent unattended room access.

### 4. PKCS#7 / CMS Digital Signature for Lab Meeting Minutes
- Decisions made during research lab meetings (thesis approvals, experiment milestones, equipment purchase requisitions) can be digitally signed right inside the meeting pad.
- The token calculates the document's SHA-256 digest and applies a tamper-evident digital signature with a cryptographic timestamp and verifiable signature certificate seal.

---

## 🚀 System Architecture & Technology Stack

- **Native PKCS#11 Interface**: Direct C-ABI bridge to `/usr/local/lib/libtrustokenP11Libv3.3.0.so` (`CDAC-PKCS#11 Library v3.2`).
- **Dual Hardware & Emulation Engine**:
  - Automatically queries the USB bus for physical C-DAC TrusToken hardware dongles (`C_GetSlotList`).
  - Supports virtual IS-16695 smartcard profiles for multi-peer local development and lab member testing.
- **Real-Time Video/Audio Engine**:
  - WebRTC multi-peer mesh signaling over Socket.IO.
  - Active speaker voice detection via Web Audio API (`AnalyserNode`).
  - Screen sharing (slides, LaTeX documents, code demos) with system audio.
  - Local Meeting Recording to `.webm` via the `MediaRecorder` API.
  - In-meeting encrypted chat and paper sharing.
- **UI Design System**:
  - Pure Vanilla CSS (no third-party CSS bloat) with rich dark glassmorphism, responsive video tile grid, cyber-security telemetry HUD, and interactive PIN modal.

---

## 🏃 Running the Application

### 1. Start the Server
```bash
cd /home/krishna-saha/trustoken-lab-meet
node server.js
```

The server listens on both:
- **HTTP**: `http://localhost:8080` (Direct local access)
- **HTTPS**: `https://localhost:8443` (Local SSL/TLS access)

### 2. For Mobile Networks & Remote Lab Members (Public HTTPS)
To share with lab members on cellular/mobile networks outside the campus Wi-Fi:
```bash
./start-public-tunnel.sh
```
This generates a live public HTTPS link with globally trusted SSL (e.g. `https://printed-pgp-material-right.trycloudflare.com`) that works on any phone, Android, or iPhone browser!

### 2. Default Enrolled Lab Profiles (PIN: `123456`)
- **Dr. Dhiman Saha**: Principal Investigator (PI) & Head, de.ci.phe.red LAB (`dhiman_saha`, RSA-4096)
- **Krishna Saha**: Security Researcher - de.ci.phe.red LAB (`krishna_saha`, RSA-2048)
- **Sahiba Suryawanshi**: PhD Scholar - de.ci.phe.red LAB (`lab_scholar_1`, ECC-256)
- **Shashwat Jaiswal**: Research Scholar - de.ci.phe.red LAB (`lab_scholar_2`, RSA-2048)

---

## 📁 Repository Structure

```
trustoken-lab-meet/
├── server.js               # Express + Socket.IO WebRTC signaling & PKI REST API
├── trustoken_bridge.py     # C-DAC PKCS#11 / ctypes interface & X.509 Lab CA engine
├── server.crt / server.key # Self-signed SSL certificates for HTTPS WebRTC
├── data/
│   ├── lab_ca.crt          # Lab Root CA Certificate (IS-16695)
│   ├── lab_ca.key          # Lab Root CA Private Key
│   └── trustokens.json     # Enrolled token certificates & hardware metadata
└── public/
    ├── index.html          # Single-Page Application (Lobby, Conference, HUD, Modals)
    ├── css/
    │   └── index.css       # Design system, glassmorphism, responsive video grid
    └── js/
        ├── app.js          # Main UI controller & state management
        ├── webrtc.js       # Multi-peer WebRTC, audio visualizer, screen share, recorder
        └── trustoken-client.js # Token challenge-response, PIN prompt, heartbeat, signer
```
