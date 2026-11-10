#!/usr/bin/env python3
"""
TrusMeet account and signing bridge.

Accounts, passwords and per-user software signing keys live in a SQLite database.
Requests arrive as JSON on stdin so passwords never appear on a command line.

Reads driver and token information through /usr/local/lib/libtrustokenP11Libv3.3.0.so,
but signing uses software keys, not the USB token's chip. It makes no claim of
IS 16695, PKCS#7 or hardware-backed signing.
"""

import sys
import os
import re
import json
import time
import base64
import ctypes
import hashlib
import hmac
import datetime
import secrets
import sqlite3
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, ec

PKCS11_LIB_PATH = "/usr/local/lib/libtrustokenP11Libv3.3.0.so"
DATA_DIR = os.environ.get("TRUSTOKEN_DATA_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(DATA_DIR, mode=0o700, exist_ok=True)

# PKCS#11 Structures
class CK_VERSION(ctypes.Structure):
    _fields_ = [('major', ctypes.c_ubyte), ('minor', ctypes.c_ubyte)]

class CK_INFO(ctypes.Structure):
    _fields_ = [
        ('cryptokiVersion', CK_VERSION),
        ('manufacturerID', ctypes.c_char * 32),
        ('flags', ctypes.c_ulong),
        ('libraryDescription', ctypes.c_char * 32),
        ('libraryVersion', CK_VERSION)
    ]

class CK_TOKEN_INFO(ctypes.Structure):
    _fields_ = [
        ('label', ctypes.c_char * 32),
        ('manufacturerID', ctypes.c_char * 32),
        ('model', ctypes.c_char * 16),
        ('serialNumber', ctypes.c_char * 16),
        ('flags', ctypes.c_ulong),
        ('ulMaxSessionCount', ctypes.c_ulong),
        ('ulSessionCount', ctypes.c_ulong),
        ('ulMaxRwSessionCount', ctypes.c_ulong),
        ('ulRwSessionCount', ctypes.c_ulong),
        ('ulMaxPinLen', ctypes.c_ulong),
        ('ulMinPinLen', ctypes.c_ulong),
        ('ulTotalPublicMemory', ctypes.c_ulong),
        ('ulFreePublicMemory', ctypes.c_ulong),
        ('ulTotalPrivateMemory', ctypes.c_ulong),
        ('ulFreePrivateMemory', ctypes.c_ulong),
        ('hardwareVersion', CK_VERSION),
        ('firmwareVersion', CK_VERSION),
        ('utcTime', ctypes.c_char * 16)
    ]

def check_hardware_token():
    """
    Checks if physical C-DAC TrusToken USB dongle is connected via PKCS#11.
    """
    result = {
        "library_path": PKCS11_LIB_PATH,
        "library_present": os.path.exists(PKCS11_LIB_PATH),
        "hardware_dongle_present": False,
        "slots_count": 0,
        "info": None,
        "token_details": None,
        "error": None
    }
    
    if not os.path.exists(PKCS11_LIB_PATH):
        result["error"] = "C-DAC TrusToken library not found at " + PKCS11_LIB_PATH
        return result

    try:
        lib = ctypes.CDLL(PKCS11_LIB_PATH)
        init = lib.C_Initialize
        init.argtypes = [ctypes.c_void_p]
        init.restype = ctypes.c_ulong
        rv = init(None)
        
        info = CK_INFO()
        get_info = lib.C_GetInfo
        get_info.argtypes = [ctypes.POINTER(CK_INFO)]
        get_info.restype = ctypes.c_ulong
        rv_info = get_info(ctypes.byref(info))
        
        if rv_info == 0:
            result["info"] = {
                "manufacturer": bytes(info.manufacturerID).decode('utf-8', errors='ignore').strip(),
                "description": bytes(info.libraryDescription).decode('utf-8', errors='ignore').strip(),
                "cryptoki_version": f"{info.cryptokiVersion.major}.{info.cryptokiVersion.minor}",
                "library_version": f"{info.libraryVersion.major}.{info.libraryVersion.minor}"
            }

        num_slots = ctypes.c_ulong(0)
        get_slots = lib.C_GetSlotList
        get_slots.argtypes = [ctypes.c_ubyte, ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        get_slots.restype = ctypes.c_ulong
        
        rv_slots = get_slots(1, None, ctypes.byref(num_slots))
        if rv_slots == 0 and num_slots.value > 0:
            result["hardware_dongle_present"] = True
            result["slots_count"] = num_slots.value
            
            # Read token info
            slots_arr = (ctypes.c_ulong * num_slots.value)()
            get_slots(1, slots_arr, ctypes.byref(num_slots))
            
            token_info = CK_TOKEN_INFO()
            get_token_info = lib.C_GetTokenInfo
            get_token_info.argtypes = [ctypes.c_ulong, ctypes.POINTER(CK_TOKEN_INFO)]
            get_token_info.restype = ctypes.c_ulong
            rv_tinfo = get_token_info(slots_arr[0], ctypes.byref(token_info))
            if rv_tinfo == 0:
                result["token_details"] = {
                    "label": bytes(token_info.label).decode('utf-8', errors='ignore').strip(),
                    "manufacturer": bytes(token_info.manufacturerID).decode('utf-8', errors='ignore').strip(),
                    "model": bytes(token_info.model).decode('utf-8', errors='ignore').strip(),
                    "serial_number": bytes(token_info.serialNumber).decode('utf-8', errors='ignore').strip(),
                    "hardware_version": f"{token_info.hardwareVersion.major}.{token_info.hardwareVersion.minor}",
                    "firmware_version": f"{token_info.firmwareVersion.major}.{token_info.firmwareVersion.minor}"
                }
        else:
            result["hardware_dongle_present"] = False
            result["slots_count"] = 0
            result["status_msg"] = "Physical USB dongle not plugged into USB port."
    except Exception as e:
        result["error"] = str(e)
    
    return result

# ==============================================================================
# STORAGE AND PASSWORDS
# ==============================================================================

DB_FILE = os.path.join(DATA_DIR, "trusmeet.db")
LAB_CA_KEY_FILE = os.path.join(DATA_DIR, "lab_ca.key")
LAB_CA_CERT_FILE = os.path.join(DATA_DIR, "lab_ca.crt")

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 15, 8, 1
SCRYPT_MAXMEM = 64 * 1024 * 1024
MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 256
MAX_FAILED_LOGINS = 5
LOCK_SECONDS = 15 * 60
USERNAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_.-]{2,31}$")
BAD_LOGIN = "Incorrect username or password."

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    priv_encrypted_pem TEXT NOT NULL,
    cert_pem TEXT NOT NULL,
    cert_serial TEXT NOT NULL,
    has_token INTEGER,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
)
"""


def fail(message):
    return {"success": False, "error": message}


def connect():
    if not os.path.exists(DB_FILE):
        os.close(os.open(DB_FILE, os.O_WRONLY | os.O_CREAT, 0o600))
    conn = sqlite3.connect(DB_FILE, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(SCHEMA)
    return conn


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P,
                            maxmem=SCRYPT_MAXMEM, dklen=32)
    return "scrypt${}${}${}${}${}".format(SCRYPT_N, SCRYPT_R, SCRYPT_P,
                                          base64.b64encode(salt).decode(), base64.b64encode(digest).decode())


def password_matches(password, stored):
    _, n, r, p, salt, digest = stored.split("$")
    computed = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
                              maxmem=SCRYPT_MAXMEM, dklen=32)
    return hmac.compare_digest(computed, base64.b64decode(digest))


def text_field(payload, name):
    value = payload.get(name)
    return value if isinstance(value, str) else ""


def check_new_password(password):
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Password must be at most {MAX_PASSWORD_LENGTH} characters."
    return None


def public_profile(row):
    has_token = row["has_token"]
    return {
        "user_id": row["username"],
        "name": row["display_name"],
        "has_token": None if has_token is None else bool(has_token),
    }


def authenticate(conn, username, password):
    """Returns (row, None) on success, or (None, error message).

    The attempt is counted before the password is checked, so parallel guesses
    cannot get past the limit.
    """
    row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if row is None:
        hash_password(password or "x")  # Takes the same time as a real check.
        return None, BAD_LOGIN

    now = int(time.time())
    charged = conn.execute(
        """UPDATE users
           SET locked_until = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END,
               failed_logins = CASE WHEN failed_logins + 1 >= ? THEN 0 ELSE failed_logins + 1 END
           WHERE username = ? AND locked_until <= ?""",
        (MAX_FAILED_LOGINS, now + LOCK_SECONDS, MAX_FAILED_LOGINS, username, now),
    ).rowcount
    if not charged:
        return None, "Too many attempts for this account. Try again in 15 minutes."

    if not password_matches(password, row["password_hash"]):
        return None, BAD_LOGIN

    conn.execute("UPDATE users SET failed_logins = 0, locked_until = 0 WHERE username = ?", (username,))
    return row, None


# ==============================================================================
# CERTIFICATE AUTHORITY AND USER KEYS
# ==============================================================================

def write_private_file(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


def utc_validity(cert):
    """Returns (not_before, not_after) as timezone-aware datetimes."""
    return (cert.not_valid_before.replace(tzinfo=datetime.timezone.utc),
            cert.not_valid_after.replace(tzinfo=datetime.timezone.utc))


def get_or_create_lab_ca():
    if os.path.exists(LAB_CA_KEY_FILE) and os.path.exists(LAB_CA_CERT_FILE):
        with open(LAB_CA_KEY_FILE, "rb") as f:
            ca_key = serialization.load_pem_private_key(f.read(), password=None)
        with open(LAB_CA_CERT_FILE, "rb") as f:
            ca_cert = x509.load_pem_x509_certificate(f.read())
        return ca_key, ca_cert

    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    name = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "IN"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "TrusMeet"),
        x509.NameAttribute(NameOID.COMMON_NAME, "TrusMeet Root CA"),
    ])
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(digital_signature=False, content_commitment=False, key_encipherment=False,
                          data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
                          encipher_only=False, decipher_only=False),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    write_private_file(LAB_CA_KEY_FILE, ca_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ))
    with open(LAB_CA_CERT_FILE, "wb") as f:
        f.write(ca_cert.public_bytes(serialization.Encoding.PEM))
    return ca_key, ca_cert


def issue_signing_key(username, display_name, password):
    """Creates a P-256 key, locked with the password, and a CA-signed certificate."""
    ca_key, ca_cert = get_or_create_lab_ca()
    private_key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "TrusMeet"),
            x509.NameAttribute(NameOID.USER_ID, username),
            x509.NameAttribute(NameOID.COMMON_NAME, display_name),
        ]))
        .issuer_name(ca_cert.subject)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=730))
        .add_extension(
            x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False,
                          data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False,
                          encipher_only=False, decipher_only=False),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )
    encrypted = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.BestAvailableEncryption(password.encode("utf-8")),
    ).decode("utf-8")
    return encrypted, cert.public_bytes(serialization.Encoding.PEM).decode("utf-8"), hex(cert.serial_number)


# ==============================================================================
# COMMANDS
# ==============================================================================

def register(payload):
    username = text_field(payload, "username").strip().lower()
    display_name = " ".join(text_field(payload, "name").split())
    password = text_field(payload, "password")

    if not USERNAME_PATTERN.match(username):
        return fail("Username must be 3-32 characters: letters, numbers, dot, dash or underscore.")
    if not 1 <= len(display_name) <= 60 or any(ord(c) < 32 or ord(c) == 127 for c in display_name):
        return fail("Please enter a name of up to 60 characters.")
    problem = check_new_password(password)
    if problem:
        return fail(problem)

    conn = connect()
    if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        return fail("That username is taken.")

    encrypted, cert_pem, cert_serial = issue_signing_key(username, display_name, password)
    try:
        conn.execute(
            """INSERT INTO users (username, display_name, password_hash, priv_encrypted_pem, cert_pem, cert_serial, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (username, display_name, hash_password(password), encrypted, cert_pem, cert_serial,
             datetime.datetime.now(datetime.timezone.utc).isoformat()),
        )
    except sqlite3.IntegrityError:
        return fail("That username is taken.")
    row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    return {"success": True, "profile": public_profile(row)}


def login(payload):
    conn = connect()
    row, error = authenticate(conn, text_field(payload, "username").strip().lower(), text_field(payload, "password"))
    if error:
        return fail(error)
    return {"success": True, "profile": public_profile(row)}


def set_token_choice(payload):
    has_token = payload.get("has_token")
    if not isinstance(has_token, bool):
        return fail("has_token must be true or false")
    updated = connect().execute("UPDATE users SET has_token = ? WHERE username = ?",
                                (int(has_token), text_field(payload, "username"))).rowcount
    return {"success": True} if updated else fail("Account not found.")


def sign_minutes(payload):
    conn = connect()
    row, error = authenticate(conn, text_field(payload, "username"), text_field(payload, "password"))
    if error:
        return fail(error)

    signed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    document_sha256 = hashlib.sha256(text_field(payload, "minutes_text").encode("utf-8")).hexdigest()
    # The signature covers the meeting, the time and the token status, not just the text.
    signed_payload = json.dumps({
        "version": 2,
        "meeting_id": text_field(payload, "meeting_id"),
        "signed_at": signed_at,
        "signer": row["username"],
        "signer_name": row["display_name"],
        "assurance": text_field(payload, "assurance"),
        "document_sha256": document_sha256,
    }, sort_keys=True, separators=(",", ":"))

    private_key = serialization.load_pem_private_key(row["priv_encrypted_pem"].encode("utf-8"),
                                                     password=text_field(payload, "password").encode("utf-8"))
    signature = private_key.sign(signed_payload.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
    return {
        "success": True,
        "signed_payload": signed_payload,
        "signature_b64": base64.b64encode(signature).decode("utf-8"),
        "document_sha256": document_sha256,
        "algorithm": "ECDSA-SHA256 (NIST P-256)",
        "signed_by": row["display_name"],
        "assurance": text_field(payload, "assurance"),
        "meeting_id": text_field(payload, "meeting_id"),
        "cert_serial": row["cert_serial"],
        "cert_pem": row["cert_pem"],
        "timestamp": signed_at,
        "signature_type": "Raw signature from a software key. Not made by the USB token.",
    }


def verify_receipt(payload):
    """Checks a receipt's signature, and that its certificate came from this CA and is in date."""
    try:
        _, ca_cert = get_or_create_lab_ca()
        cert = x509.load_pem_x509_certificate(text_field(payload, "cert_pem").encode("utf-8"))
        cert.verify_directly_issued_by(ca_cert)
        not_before, not_after = utc_validity(cert)
        if not not_before <= datetime.datetime.now(datetime.timezone.utc) <= not_after:
            return {"valid": False, "message": "Certificate is not currently valid"}
        cert.public_key().verify(base64.b64decode(text_field(payload, "signature_b64")),
                                 text_field(payload, "signed_payload").encode("utf-8"),
                                 ec.ECDSA(hashes.SHA256()))
        return {"valid": True, "message": "Valid signature (software key)"}
    except Exception:
        return {"valid": False, "message": "Signature or certificate is not valid"}


def admin_reset(username):
    """Admin command: gives an account a new password and signing key, and clears any lock."""
    conn = connect()
    row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if row is None:
        return fail("Account not found.")
    password = secrets.token_urlsafe(12)
    encrypted, cert_pem, cert_serial = issue_signing_key(username, row["display_name"], password)
    conn.execute(
        """UPDATE users SET password_hash = ?, priv_encrypted_pem = ?, cert_pem = ?, cert_serial = ?,
                            failed_logins = 0, locked_until = 0 WHERE username = ?""",
        (hash_password(password), encrypted, cert_pem, cert_serial, username),
    )
    return {"success": True, "username": username, "temporary_password": password}


def init():
    os.chmod(DATA_DIR, 0o700)
    connect().close()
    get_or_create_lab_ca()
    return {"success": True}


COMMANDS = {
    "register": register,
    "login": login,
    "set-token-choice": set_token_choice,
    "sign-minutes": sign_minutes,
    "verify-receipt": verify_receipt,
}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No action specified"}))
        sys.exit(1)

    command = sys.argv[1]
    try:
        if command == "hardware-status":
            result = check_hardware_token()
        elif command == "init":
            result = init()
        elif command == "admin-reset" and len(sys.argv) == 3:
            result = admin_reset(sys.argv[2].strip().lower())
        elif command in COMMANDS:
            payload = json.loads(sys.stdin.read() or "{}")
            result = COMMANDS[command](payload if isinstance(payload, dict) else {})
        else:
            result = fail(f"Unknown command {command}")
    except Exception as exc:
        print(f"{command} failed: {type(exc).__name__}", file=sys.stderr)
        result = fail("The server could not complete that request.")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
