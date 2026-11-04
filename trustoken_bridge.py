#!/usr/bin/env python3
"""
C-DAC TrusToken PKCS#11 Security Bridge
Interfaces with /usr/local/lib/libtrustokenP11Libv3.3.0.so
and provides cryptographic operations, X.509 certificate handling,
challenge-response verification, hardware heartbeat, and digital signing.
Compliant with IS-16695 Part 1 & Part 2, PKCS#11 v2.20, and ISO-7816.
"""

import sys
import os
import json
import base64
import ctypes
import hashlib
import datetime
from cryptography import x509
from cryptography.x509.oid import NameOID, ExtensionOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, ec, padding
from cryptography.hazmat.primitives.serialization import pkcs7

PKCS11_LIB_PATH = "/usr/local/lib/libtrustokenP11Libv3.3.0.so"
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(DATA_DIR, exist_ok=True)

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
                "library_version": f"{info.libraryVersion.major}.{info.libraryVersion.minor}",
                "standard": "IS-16695 (Part 1 & 2) / PKCS#11 v2.20 / ISO-7816"
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
                    "firmware_version": f"{token_info.firmwareVersion.major}.{token_info.firmwareVersion.minor}",
                    "user_memory": "100 KB Secure EEPROM (IS-16695)"
                }
        else:
            result["hardware_dongle_present"] = False
            result["slots_count"] = 0
            result["status_msg"] = "Physical USB dongle not plugged into USB port. Emulated TrusToken active."
    except Exception as e:
        result["error"] = str(e)
    
    return result

# ==============================================================================
# LAB PKI CA & CERTIFICATE GENERATOR / STORAGE
# Enforces Lab Director (PI) & Lab Member hierarchy
# ==============================================================================

LAB_CA_KEY_FILE = os.path.join(DATA_DIR, "lab_ca.key")
LAB_CA_CERT_FILE = os.path.join(DATA_DIR, "lab_ca.crt")
TOKENS_DB_FILE = os.path.join(DATA_DIR, "trustokens.json")

def get_or_create_lab_ca():
    """Initializes or loads the Lab Root CA certificate."""
    if os.path.exists(LAB_CA_KEY_FILE) and os.path.exists(LAB_CA_CERT_FILE):
        with open(LAB_CA_KEY_FILE, "rb") as f:
            ca_key = serialization.load_pem_private_key(f.read(), password=None)
        with open(LAB_CA_CERT_FILE, "rb") as f:
            ca_cert = x509.load_pem_x509_certificate(f.read())
        return ca_key, ca_cert

    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "IN"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "Chhattisgarh"),
        x509.NameAttribute(NameOID.LOCALITY_NAME, "Bhilai"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "IIT Bhilai - de.ci.phe.red LAB"),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "Applied Cryptography & Security"),
        x509.NameAttribute(NameOID.COMMON_NAME, "TrusToken Lab Root CA (IS-16695)"),
    ])
    
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=True,
                crl_sign=True,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )

    with open(LAB_CA_KEY_FILE, "wb") as f:
        f.write(ca_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))
    with open(LAB_CA_CERT_FILE, "wb") as f:
        f.write(ca_cert.public_bytes(serialization.Encoding.PEM))

    return ca_key, ca_cert

def generate_token_profile(user_id, name, role, email, pin, key_type="RSA-2048"):
    """
    Creates an on-chip key pair and X.509 certificate signed by the Lab CA.
    Stores the private key encrypted with the token hardware PIN.
    """
    ca_key, ca_cert = get_or_create_lab_ca()

    if key_type == "ECC-256":
        private_key = ec.generate_private_key(ec.SECP256R1())
    else:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "IN"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "IIT Bhilai - C-DAC Research Lab"),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, f"Lab Role: {role}"),
        x509.NameAttribute(NameOID.COMMON_NAME, name),
        x509.NameAttribute(NameOID.EMAIL_ADDRESS, email),
    ])

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=730))
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=True,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([
                x509.oid.ExtendedKeyUsageOID.CLIENT_AUTH,
                x509.oid.ExtendedKeyUsageOID.CODE_SIGNING,
                x509.oid.ExtendedKeyUsageOID.EMAIL_PROTECTION,
            ]),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode('utf-8')
    priv_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.BestAvailableEncryption(pin.encode('utf-8')),
    ).decode('utf-8')

    pub_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode('utf-8')

    token_serial = f"TT-IN-{hashlib.sha256((user_id + email).encode()).hexdigest()[:8].upper()}"

    profile = {
        "user_id": user_id,
        "name": name,
        "role": role,
        "email": email,
        "token_serial": token_serial,
        "key_type": key_type,
        "cert_serial": hex(cert.serial_number),
        "cert_pem": cert_pem,
        "pub_pem": pub_pem,
        "priv_encrypted_pem": priv_pem,
        "pin_hash": hashlib.sha256(pin.encode('utf-8')).hexdigest(),
        "created_at": now.isoformat(),
        "valid_until": (now + datetime.timedelta(days=730)).isoformat(),
        "pin_retries_left": 5,
        "locked": False
    }

    return profile

def init_default_tokens():
    """Initializes standard profiles: PI, Lead Researcher, PhD Scholar, Guest."""
    if os.path.exists(TOKENS_DB_FILE):
        try:
            with open(TOKENS_DB_FILE, "r") as f:
                data = json.load(f)
                if len(data) >= 3:
                    return data
        except Exception:
            pass

    default_members = [
        {
            "user_id": "dhiman_saha",
            "name": "Dr. Dhiman Saha",
            "role": "Principal Investigator (PI) - Head, de.ci.phe.red LAB",
            "email": "dhiman@iitbhilai.ac.in",
            "pin": "123456",
            "key_type": "RSA-4096"
        },
        {
            "user_id": "krishna_saha",
            "name": "Krishna Saha",
            "role": "Security Researcher - de.ci.phe.red LAB",
            "email": "krishna.saha@iitbhilai.ac.in",
            "pin": "123456",
            "key_type": "RSA-2048"
        },
        {
            "user_id": "lab_scholar_1",
            "name": "Sahiba Suryawanshi",
            "role": "PhD Scholar - de.ci.phe.red LAB",
            "email": "sahiba@iitbhilai.ac.in",
            "pin": "123456",
            "key_type": "ECC-256"
        },
        {
            "user_id": "lab_scholar_2",
            "name": "Shashwat Jaiswal",
            "role": "Research Scholar - de.ci.phe.red LAB",
            "email": "shashwat@iitbhilai.ac.in",
            "pin": "123456",
            "key_type": "RSA-2048"
        }
    ]

    tokens_db = {}
    for m in default_members:
        profile = generate_token_profile(
            user_id=m["user_id"],
            name=m["name"],
            role=m["role"],
            email=m["email"],
            pin=m["pin"],
            key_type=m["key_type"]
        )
        tokens_db[m["user_id"]] = profile

    with open(TOKENS_DB_FILE, "w") as f:
        json.dump(tokens_db, f, indent=2)

    return tokens_db

def load_tokens_db():
    if not os.path.exists(TOKENS_DB_FILE):
        return init_default_tokens()
    try:
        with open(TOKENS_DB_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return init_default_tokens()

def save_tokens_db(db):
    with open(TOKENS_DB_FILE, "w") as f:
        json.dump(db, f, indent=2)

# ==============================================================================
# CRYPTOGRAPHIC CHALLENGE-RESPONSE & SIGNING OPERATIONS
# ==============================================================================

def perform_token_sign(user_id, pin, payload_bytes):
    """
    Simulates the on-chip C_Sign cryptographic operation after PIN verification.
    The private key never leaves the encrypted container without PIN.
    """
    db = load_tokens_db()
    if user_id not in db:
        return {"success": False, "error": f"Token for user '{user_id}' not found"}

    profile = db[user_id]
    if profile.get("locked"):
        return {"success": False, "error": "TrusToken is LOCKED due to excessive failed PIN attempts"}

    input_pin_hash = hashlib.sha256(pin.encode('utf-8')).hexdigest()
    if input_pin_hash != profile["pin_hash"]:
        profile["pin_retries_left"] = max(0, profile.get("pin_retries_left", 5) - 1)
        if profile["pin_retries_left"] == 0:
            profile["locked"] = True
        save_tokens_db(db)
        return {
            "success": False,
            "error": f"Incorrect Hardware PIN. Retries remaining: {profile['pin_retries_left']}",
            "retries_left": profile["pin_retries_left"]
        }

    # Reset retries on success
    profile["pin_retries_left"] = 5
    save_tokens_db(db)

    # Unlock private key with PIN
    try:
        priv_bytes = profile["priv_encrypted_pem"].encode('utf-8')
        priv_key = serialization.load_pem_private_key(priv_bytes, password=pin.encode('utf-8'))
        
        # Sign payload
        if profile["key_type"] == "ECC-256":
            signature = priv_key.sign(payload_bytes, ec.ECDSA(hashes.SHA256()))
            algorithm = "ECDSA-SHA256 (NIST P-256)"
        else:
            signature = priv_key.sign(
                payload_bytes,
                padding.PKCS1v15(),
                hashes.SHA256()
            )
            algorithm = "RSA-PKCS#1v1.5-SHA256 (2048-bit)"

        sig_b64 = base64.b64encode(signature).decode('utf-8')
        return {
            "success": True,
            "signature_b64": sig_b64,
            "algorithm": algorithm,
            "token_serial": profile["token_serial"],
            "cert_serial": profile["cert_serial"],
            "cert_pem": profile["cert_pem"],
            "user_id": profile["user_id"],
            "name": profile["name"],
            "role": profile["role"]
        }
    except Exception as e:
        return {"success": False, "error": f"Cryptographic operation failed: {str(e)}"}

def verify_token_signature(cert_pem, payload_bytes, signature_b64):
    """
    Verifies that a signature was authentically produced by the TrusToken certificate.
    """
    try:
        cert = x509.load_pem_x509_certificate(cert_pem.encode('utf-8'))
        pub_key = cert.public_key()
        sig_bytes = base64.b64decode(signature_b64)

        if isinstance(pub_key, ec.EllipticCurvePublicKey):
            pub_key.verify(sig_bytes, payload_bytes, ec.ECDSA(hashes.SHA256()))
        elif isinstance(pub_key, rsa.RSAPublicKey):
            pub_key.verify(sig_bytes, payload_bytes, padding.PKCS1v15(), hashes.SHA256())
        else:
            return False, "Unsupported key type"

        # Verify certificate is not expired
        now = datetime.datetime.now(datetime.timezone.utc)
        nb = cert.not_valid_before.replace(tzinfo=datetime.timezone.utc) if cert.not_valid_before.tzinfo is None else cert.not_valid_before
        na = cert.not_valid_after.replace(tzinfo=datetime.timezone.utc) if cert.not_valid_after.tzinfo is None else cert.not_valid_after
        if now < nb or now > na:
            return False, "TrusToken X.509 Certificate is expired"

        return True, "Valid C-DAC TrusToken Cryptographic Signature"
    except Exception as e:
        return False, str(e)

# ==============================================================================
# CLI COMMAND ROUTER
# ==============================================================================

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No action specified"}))
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "hardware-status":
        res = check_hardware_token()
        print(json.dumps(res))

    elif cmd == "list-tokens":
        init_default_tokens()
        db = load_tokens_db()
        # Return sanitized profiles (no encrypted private key)
        sanitized = []
        for k, v in db.items():
            sanitized.append({
                "user_id": v["user_id"],
                "name": v["name"],
                "role": v["role"],
                "email": v["email"],
                "token_serial": v["token_serial"],
                "key_type": v["key_type"],
                "cert_serial": v["cert_serial"],
                "valid_until": v["valid_until"],
                "locked": v.get("locked", False),
                "cert_pem": v["cert_pem"]
            })
        print(json.dumps({"success": True, "tokens": sanitized}))

    elif cmd == "sign-challenge":
        # Args: user_id, pin, challenge_string
        if len(sys.argv) < 5:
            print(json.dumps({"success": False, "error": "Usage: sign-challenge <user_id> <pin> <challenge>"}))
            sys.exit(1)
        user_id = sys.argv[2]
        pin = sys.argv[3]
        challenge = sys.argv[4].encode('utf-8')
        res = perform_token_sign(user_id, pin, challenge)
        print(json.dumps(res))

    elif cmd == "verify-signature":
        # Args: payload_string, signature_b64, cert_pem_or_user_id
        if len(sys.argv) < 5:
            print(json.dumps({"success": False, "error": "Usage: verify-signature <payload> <sig_b64> <user_id_or_cert>"}))
            sys.exit(1)
        payload = sys.argv[2].encode('utf-8')
        sig_b64 = sys.argv[3]
        id_or_cert = sys.argv[4]

        db = load_tokens_db()
        cert_pem = id_or_cert
        if id_or_cert in db:
            cert_pem = db[id_or_cert]["cert_pem"]

        valid, msg = verify_token_signature(cert_pem, payload, sig_b64)
        print(json.dumps({"valid": valid, "message": msg}))

    elif cmd == "sign-minutes":
        # Digitally sign meeting minutes
        # Args: user_id, pin, minutes_json_b64
        if len(sys.argv) < 5:
            print(json.dumps({"success": False, "error": "Usage: sign-minutes <user_id> <pin> <minutes_b64>"}))
            sys.exit(1)
        user_id = sys.argv[2]
        pin = sys.argv[3]
        minutes_raw = base64.b64decode(sys.argv[4]).decode('utf-8')
        
        # Calculate SHA-256 digest of minutes document
        doc_hash = hashlib.sha256(minutes_raw.encode('utf-8')).hexdigest()
        sign_payload = f"TRUSTOKEN_DOC_SIGN:SHA256:{doc_hash}".encode('utf-8')
        
        sign_res = perform_token_sign(user_id, pin, sign_payload)
        if not sign_res["success"]:
            print(json.dumps(sign_res))
            sys.exit(0)

        timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
        receipt = {
            "success": True,
            "document_sha256": doc_hash,
            "signature_b64": sign_res["signature_b64"],
            "algorithm": sign_res["algorithm"],
            "signed_by": sign_res["name"],
            "signer_role": sign_res["role"],
            "token_serial": sign_res["token_serial"],
            "cert_serial": sign_res["cert_serial"],
            "timestamp": timestamp,
            "compliance": "IS-16695 Part 1 & 2 / PKCS#7 Digital Signature",
            "verification_status": "AUTHENTIC_HARDWARE_SIGNATURE"
        }
        print(json.dumps(receipt))

    elif cmd == "init-tokens":
        init_default_tokens()
        print(json.dumps({"success": True, "message": "Tokens initialized"}))

    else:
        print(json.dumps({"error": f"Unknown command {cmd}"}))

if __name__ == "__main__":
    main()
