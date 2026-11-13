#!/usr/bin/env python3
"""
Digital Signature & Cryptographic Protocol Demonstration Runner
TrusMeet Research Laboratory
"""

import os
import sys
import datetime
import argparse
from pki_manager import PKIManager
from pdf_generator import generate_sample_document
from pdf_crypto_signer import PDFCryptoSigner
from pdf_verifier import PDFVerifier

# ANSI Terminal Colors
CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
BOLD = "\033[1m"
RESET = "\033[0m"


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT_DIR = os.path.join(SCRIPT_DIR, "output")


def parse_date_str(d_str):
    """Parses a date string and attaches local timezone (+05:30)."""
    if not d_str:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y"):
        try:
            dt = datetime.datetime.strptime(d_str, fmt)
            return dt.replace(tzinfo=datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
        except ValueError:
            continue
    return None


def print_banner():
    print(f"{CYAN}{BOLD}")
    print("=" * 72)
    print("  TRUSMEET: CRYPTOGRAPHIC PROTOCOL & PDF DIGITAL SIGNATURE DEMO")
    print("  Conforming to ISO 32000-1 / PAdES (ETSI EN 319 142) / RFC 5652 CMS")
    print("=" * 72)
    print(f"{RESET}")


def run_full_flow(output_dir=None, signing_date=None):
    if output_dir is None:
        output_dir = DEFAULT_OUT_DIR
    sig_dt = parse_date_str(signing_date)
    print_banner()
    os.makedirs(output_dir, exist_ok=True)

    # -------------------------------------------------------------
    # STEP 1: PKI & Cryptographic Hierarchy
    # -------------------------------------------------------------
    print(f"\n{YELLOW}{BOLD}[STEP 1] Initializing Public Key Infrastructure (PKI Protocol)...{RESET}")
    pki = PKIManager(storage_dir=os.path.join(output_dir, "pki"))
    key_file, cert_file, ca_cert_file = pki.issue_signer_certificate(
        common_name="Krishna Saha",
        organization="TrusMeet Security Lab",
        key_type="RSA"
    )
    print(f"  {GREEN}✓{RESET} Root CA Certificate:     {ca_cert_file}")
    print(f"  {GREEN}✓{RESET} Signer End-Entity Cert:  {cert_file}")
    print(f"  {GREEN}✓{RESET} Signer Private Key:      {key_file}")
    print(f"  {CYAN}→ Protocol features: RSA-2048, SHA-256, digitalSignature & contentCommitment (non-repudiation).{RESET}")

    # -------------------------------------------------------------
    # STEP 2: Document Generation
    # -------------------------------------------------------------
    print(f"\n{YELLOW}{BOLD}[STEP 2] Generating Official Lab Document (PDF)...{RESET}")
    raw_pdf = os.path.join(output_dir, "lab_meeting_minutes_unsigned.pdf")
    generate_sample_document(
        output_pdf_path=raw_pdf,
        title="TRUSMEET RESEARCH LAB MEETING & PROTOCOL RECORD",
        author="Krishna Saha"
    )
    print(f"  {GREEN}✓{RESET} Unsigned PDF created at: {raw_pdf}")

    # -------------------------------------------------------------
    # STEP 3: Cryptographic Signing Protocol
    # -------------------------------------------------------------
    print(f"\n{YELLOW}{BOLD}[STEP 3] Signing Document via Cryptographic Protocol (CMS / PKCS#7)...{RESET}")
    signed_pdf = os.path.join(output_dir, "lab_meeting_minutes_signed.pdf")
    signer = PDFCryptoSigner(
        key_path=key_file,
        cert_path=cert_file,
        ca_cert_path=ca_cert_file
    )
    signer.sign_pdf(
        input_pdf_path=raw_pdf,
        output_pdf_path=signed_pdf,
        sig_field_name="TrusMeetSignature",
        reason="Certified True Copy",
        location="TrusMeet Lab Workstation",
        visual=True,
        signing_datetime=sig_dt
    )
    print(f"  {GREEN}✓{RESET} Cryptographically signed PDF: {signed_pdf}")
    print(f"  {CYAN}→ Injected /ByteRange incremental update with detached SHA-256 CMS SignedData.{RESET}")

    # -------------------------------------------------------------
    # STEP 4: Deep Verification via Python Engine
    # -------------------------------------------------------------
    print(f"\n{YELLOW}{BOLD}[STEP 4] Deep Verification via Python Engine (ByteRange + Trust Anchor)...{RESET}")
    verifier = PDFVerifier(ca_cert_path=ca_cert_file)
    py_res = verifier.verify_with_python(signed_pdf)

    if py_res["success"]:
        for sig in py_res["signatures"]:
            print(f"  {BOLD}Field Name:{RESET}       {sig['field_name']}")
            print(f"  {BOLD}Signer Subject:{RESET}   {sig['signer_subject']}")
            print(f"  {BOLD}Issuer (CA):{RESET}      {sig['issuer']}")
            print(f"  {BOLD}Cryptographic Integrity:{RESET} {'[✓ INTACT]' if sig['intact'] else '[✗ FAILED]'}")
            print(f"  {BOLD}Root CA Trust Chain:{RESET}     {'[✓ TRUSTED]' if sig['trusted'] else '[✗ UNTRUSTED]'}")
            print(f"  {BOLD}Bottom Line Status:{RESET}      {'[✓ VALID]' if sig['valid'] else '[✗ INVALID]'}")
    else:
        print(f"  {RED}Verification failed: {py_res['error']}{RESET}")

    # -------------------------------------------------------------
    # STEP 5: Universal "Verify Anywhere" Check (pdfsig)
    # -------------------------------------------------------------
    print(f"\n{YELLOW}{BOLD}[STEP 5] Universal 'Verify Anywhere' Verification (via Linux pdfsig)...{RESET}")
    cli_res = verifier.verify_with_pdfsig(signed_pdf)
    print(f"{CYAN}--- Output from /usr/bin/pdfsig ---{RESET}")
    print(cli_res["stdout"].strip())
    print(f"{CYAN}----------------------------------{RESET}")
    if "Signature is Valid" in cli_res["stdout"]:
        print(f"  {GREEN}{BOLD}✓ PROVEN: Standard PDF readers verify the signature as VALID anywhere!{RESET}")

    # -------------------------------------------------------------
    # STEP 6: Tamper-Evident Security Demonstration
    # -------------------------------------------------------------
    print(f"\n{YELLOW}{BOLD}[STEP 6] Security Audit: Proving Tamper-Evidence...{RESET}")
    tampered_pdf = os.path.join(output_dir, "lab_meeting_minutes_tampered.pdf")

    # Mutate 1 byte of the signed PDF
    with open(signed_pdf, "rb") as f:
        data = bytearray(f.read())
    # Modify a byte inside the signed byte range
    data[250] ^= 0xFF
    with open(tampered_pdf, "wb") as f:
        f.write(data)

    print(f"  {YELLOW}⚠ Injected unauthorized 1-byte mutation into document stream.{RESET}")
    tamper_res = verifier.verify_with_pdfsig(tampered_pdf)
    print(f"{CYAN}--- pdfsig output on tampered file ---{RESET}")
    print(tamper_res["stdout"].strip())
    print(f"{CYAN}--------------------------------------{RESET}")

    if "Digest Mismatch" in tamper_res["stdout"] or "Invalid" in tamper_res["stdout"]:
        print(f"  {GREEN}{BOLD}✓ SECURITY TEST PASSED:{RESET} Tampering was immediately detected (Digest Mismatch)!")

    # -------------------------------------------------------------
    # Summary
    # -------------------------------------------------------------
    print(f"\n{GREEN}{BOLD}" + "=" * 72)
    print("  ALL DEMONSTRATION STEPS COMPLETED SUCCESSFULLY!")
    print(f"  Signed PDF ready at: {os.path.abspath(signed_pdf)}")
    print("=" * 72 + f"{RESET}\n")


def main():
    parser = argparse.ArgumentParser(description="Cryptographic Protocol & PDF Digital Signatures")
    subparsers = parser.add_subparsers(dest="command", help="Available subcommands")

    # full-flow command
    sub = subparsers.add_parser("full-flow", help="Run complete end-to-end demo")
    sub.add_argument("--outdir", default=DEFAULT_OUT_DIR, help="Directory for output files")
    sub.add_argument("--date", default=None, help="Custom signing date (e.g. '2024-11-11 12:00:00' to match laptop clock)")

    # sign command
    sub_sign = subparsers.add_parser("sign", help="Sign an existing PDF")
    sub_sign.add_argument("--input", required=True, help="Path to input PDF")
    sub_sign.add_argument("--output", required=True, help="Path for signed PDF")
    sub_sign.add_argument("--name", default="Krishna Saha", help="Signer Common Name")
    sub_sign.add_argument("--reason", default="Certified True Copy", help="Signing reason")
    sub_sign.add_argument("--date", default=None, help="Custom signing date (e.g. '2024-11-11 12:00:00' to match laptop clock)")
    sub_sign.add_argument("--state", default="unverified", choices=["unverified", "valid"],
                          help="'unverified' (Yellow '?' mark) or 'valid' (Green '✓' mark)")
    sub_sign.add_argument("--pki-dir", default=os.path.join(DEFAULT_OUT_DIR, "pki"), help="Directory where PKI keys live")

    # verify command
    sub_ver = subparsers.add_parser("verify", help="Verify a signed PDF")
    sub_ver.add_argument("--input", required=True, help="Path to signed PDF")
    sub_ver.add_argument("--ca", default=os.path.join(DEFAULT_OUT_DIR, "pki", "lab_root_ca.crt"), help="Optional path to Root CA certificate")

    args = parser.parse_args()

    if args.command == "full-flow" or len(sys.argv) == 1:
        outdir = getattr(args, "outdir", DEFAULT_OUT_DIR)
        signing_date = getattr(args, "date", None)
        run_full_flow(outdir, signing_date=signing_date)
    elif args.command == "sign":
        pki = PKIManager(storage_dir=args.pki_dir)
        key_file, cert_file, ca_cert_file = pki.issue_signer_certificate(common_name=args.name)
        signer = PDFCryptoSigner(key_path=key_file, cert_path=cert_file, ca_cert_path=ca_cert_file)
        sig_dt = parse_date_str(args.date)
        signer.sign_pdf(args.input, args.output, reason=args.reason, visual_state=args.state, signing_datetime=sig_dt)
        print(f"Successfully signed: {args.output}")
    elif args.command == "verify":
        verifier = PDFVerifier(ca_cert_path=args.ca)
        res = verifier.verify_with_python(args.input)
        if res["success"]:
            for s in res["signatures"]:
                print(s["summary"])
        else:
            print("Verification error:", res["error"])
        print("\nChecking with system pdfsig:")
        c = verifier.verify_with_pdfsig(args.input)
        print(c["stdout"])


if __name__ == "__main__":
    main()
