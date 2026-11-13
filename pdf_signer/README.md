# Cryptographic Digital Signature Protocol on PDF

This toolkit implements a complete, standards-compliant **Digital Signature via Cryptographic Protocol** for PDF documents, conforming to:
- **ISO 32000-1 / ISO 32000-2**: PDF Document Management Specifications
- **RFC 5652 (CMS / PKCS#7)**: Cryptographic Message Syntax
- **RFC 5280**: X.509 PKI Certificate and CRL Profile
- **ETSI EN 319 142 (PAdES)**: PDF Advanced Electronic Signatures

It fulfills the requirement to **sign a PDF using a standard cryptographic protocol** and **verify the signature anywhere** (e.g. Adobe Acrobat Reader, Foxit, Poppler `pdfsig`, or custom scripts).

---

## Architecture & Cryptographic Workflow

```
1. PKI Infrastructure Setup
   [Lab Root CA (X.509)]
          │ (Signs with digitalSignature + certSign)
          ▼
   [Signer End-Entity Certificate & RSA Private Key]
   (Extensions: BasicConstraints=CA:FALSE, KeyUsage=digitalSignature, contentCommitment)

2. PDF Document & ByteRange Preparation
   Original Document Bytes ───► Allocate Signature Dictionary (/Contents & /ByteRange)
                                Exclude /Contents from digest calculation

3. Cryptographic Signature Generation
   Hash(/ByteRange Bytes) ───► SHA-256 Digest
   SHA-256 Digest + Attributes (SigningTime, Cert) ───► Encrypt with Signer Private Key (RSA)
   Bundle into DER-encoded CMS (PKCS#7) SignedData Structure

4. Incremental Injection
   CMS SignedData (Hex) ───► Injected into /Contents via Incremental Save
   Visual Signature Stamp ───► Appended to designated signature placeholder

5. Universal Verification ("Verify Anywhere")
   - Integrity Check: Recalculates SHA-256 hash across /ByteRange. Must match CMS SignedData.
   - Crypto Validation: Decrypts signature with Signer public key to verify attribute integrity.
   - Trust Path: Traces Signer Certificate back to the Root CA trust anchor.
   - Tamper Detection: Any single-byte modification invalidates the digest ("Digest Mismatch").
```

---

## Directory Structure

```
pdf_signer/
├── pki_manager.py         # Root CA & End-Entity Certificate issuance (X.509)
├── pdf_generator.py       # Professional PDF document generator (pycairo)
├── pdf_crypto_signer.py   # Detached CMS / PKCS#7 incremental PDF signer (pyhanko)
├── pdf_verifier.py        # Dual verification engine (Python API + Poppler pdfsig)
├── demo.py                # Command-line interface and full-flow demonstration runner
├── output/                # Generated keys, certificates, signed PDFs, and reports
└── README.md              # Technical documentation
```

---

## Quick Start & Demonstration

### 1. Run the Full End-to-End Demonstration
Run this command to execute all 6 stages of the cryptographic protocol:
```bash
python3 demo.py full-flow
```

The script will automatically:
1. **Initialize PKI**: Creates a 4096-bit RSA Root Certificate Authority and issues a 2048-bit Signer Certificate with `digitalSignature` and `contentCommitment` (non-repudiation).
2. **Generate Document**: Creates a sample Lab Meeting Minutes document with metadata and designated signature block.
3. **Sign via Cryptographic Protocol**: Signs the PDF with detached CMS/PKCS#7 and embeds a visual stamp.
4. **Deep Verification (Python)**: Validates `/ByteRange` integrity, cryptographic soundess, and Root CA trust path.
5. **Universal Verification (`pdfsig`)**: Uses the Linux Poppler standard utility `/usr/bin/pdfsig` to prove compatibility.
6. **Tamper Test**: Intentionally mutates 1 byte in the document stream and proves that the system flags it as `Digest Mismatch`.

---

## Signing Any Custom PDF

To sign your own PDF document with your name:
```bash
python3 demo.py sign --input /path/to/mydoc.pdf --output /path/to/signed_doc.pdf --name "Krishna Saha"
```

## Verifying Any Signed PDF

To verify a signed PDF:
```bash
python3 demo.py verify --input /path/to/signed_doc.pdf
```

Or using the standard Linux utility directly:
```bash
pdfsig /path/to/signed_doc.pdf
```

---

## Verifying in Adobe Acrobat Reader

1. Copy `output/lab_meeting_minutes_signed.pdf` to your Windows / macOS machine.
2. Open it in **Adobe Acrobat Reader**.
3. You will see the signature badge at the top:
   > *"Signed and all signatures are valid."*
4. Click on the **Signature Panel** to view:
   - Certificate Path (Signer -> Lab Root CA)
   - Date & Time of Signing
   - Hash Algorithm: SHA-256
   - Document Integrity: *"Document has not been modified since this signature was applied."*

