"""
PDF Digital Signature Verifier
Verifies PDF signatures using:
1. Python Cryptographic Validation Engine (validates ByteRange integrity, CMS signature, and CA trust chain)
2. Industry-standard poppler utility (pdfsig) for universal interoperability verification
"""

import os
import subprocess
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign import validation
from pyhanko_certvalidator import ValidationContext
from asn1crypto import pem, x509


class PDFVerifier:
    def __init__(self, ca_cert_path=None):
        self.ca_cert_path = ca_cert_path
        self.vctx = None
        if self.ca_cert_path and os.path.exists(self.ca_cert_path):
            with open(self.ca_cert_path, "rb") as f:
                content = f.read()
                if b"BEGIN CERTIFICATE" in content:
                    _, _, der_bytes = pem.unarmor(content)
                else:
                    der_bytes = content
                ca_cert = x509.Certificate.load(der_bytes)
                self.vctx = ValidationContext(trust_roots=[ca_cert])

    def verify_with_python(self, pdf_path):
        """
        Deep cryptographic verification in Python:
        - Checks ByteRange document integrity (hash)
        - Verifies RSA/ECDSA signature over CMS signed attributes
        - Validates X.509 certificate chain against Root CA
        """
        if not os.path.exists(pdf_path):
            return {"success": False, "error": f"File not found: {pdf_path}"}

        results = []
        with open(pdf_path, "rb") as f:
            reader = PdfFileReader(f)
            signatures = reader.embedded_signatures
            if not signatures:
                return {"success": False, "error": "No digital signatures found in document."}

            for idx, sig in enumerate(signatures, 1):
                status = validation.validate_pdf_signature(
                    sig,
                    signer_validation_context=self.vctx
                )

                signer_cert = sig.signer_cert
                subject = signer_cert.subject.human_friendly if signer_cert else "Unknown"
                issuer = signer_cert.issuer.human_friendly if signer_cert else "Unknown"

                res = {
                    "signature_index": idx,
                    "field_name": sig.field_name,
                    "signer_subject": subject,
                    "issuer": issuer,
                    "intact": status.intact,
                    "valid": status.valid,
                    "trusted": status.trusted,
                    "summary": status.pretty_print_details()
                }
                results.append(res)

        return {
            "success": True,
            "total_signatures": len(results),
            "signatures": results
        }

    def verify_with_pdfsig(self, pdf_path):
        """
        Runs Linux /usr/bin/pdfsig to prove universal interoperability (Adobe / Poppler standard).
        """
        try:
            cmd = ["pdfsig", pdf_path]
            proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
            return {
                "exit_code": proc.returncode,
                "stdout": proc.stdout,
                "stderr": proc.stderr
            }
        except FileNotFoundError:
            return {
                "exit_code": -1,
                "stdout": "",
                "stderr": "pdfsig executable not found on system."
            }

