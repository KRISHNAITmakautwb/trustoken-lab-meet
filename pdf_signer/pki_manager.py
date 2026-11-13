"""
PKI Manager for Digital Signatures
Handles X.509 Certificate Authority (Root CA) and Signer Certificate issuance
conforming to RFC 5280 and digital signature requirements.
"""

import os
import datetime
from cryptography.hazmat.primitives.asymmetric import rsa, ec
from cryptography.hazmat.primitives import hashes, serialization
from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID


class PKIManager:
    def __init__(self, storage_dir="pki_store"):
        self.storage_dir = storage_dir
        os.makedirs(self.storage_dir, exist_ok=True)
        self.ca_key_path = os.path.join(self.storage_dir, "lab_root_ca.key")
        self.ca_cert_path = os.path.join(self.storage_dir, "lab_root_ca.crt")

    def get_or_create_root_ca(self, common_name="TrusMeet Lab Root CA", organization="TrusMeet Research Lab"):
        """Creates or loads a self-signed Root Certificate Authority."""
        if os.path.exists(self.ca_key_path) and os.path.exists(self.ca_cert_path):
            with open(self.ca_key_path, "rb") as f:
                ca_key = serialization.load_pem_private_key(f.read(), password=None)
            with open(self.ca_cert_path, "rb") as f:
                ca_cert = x509.load_pem_x509_certificate(f.read())
            return ca_key, ca_cert

        print(f"[*] Generating new Root CA: {common_name}...")
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
        now = datetime.datetime.now(datetime.timezone.utc)

        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COUNTRY_NAME, "IN"),
            x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "West Bengal"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization),
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
        ])

        ca_cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=3650))
            .not_valid_after(now + datetime.timedelta(days=3650))  # 10 years
            .add_extension(
                x509.BasicConstraints(ca=True, path_length=0),
                critical=True
            )
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
                    decipher_only=False
                ),
                critical=True
            )
            .add_extension(
                x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()),
                critical=False
            )
            .sign(ca_key, hashes.SHA256())
        )

        with open(self.ca_key_path, "wb") as f:
            f.write(ca_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption()
            ))

        with open(self.ca_cert_path, "wb") as f:
            f.write(ca_cert.public_bytes(serialization.Encoding.PEM))

        print(f"[+] Root CA saved to {self.ca_cert_path}")
        return ca_key, ca_cert

    def issue_signer_certificate(self, common_name="Krishna Saha", organization="TrusMeet Research Lab", key_type="RSA"):
        """
        Generates a key pair and issues an end-entity certificate signed by Root CA
        with standard digitalSignature and contentCommitment (non-repudiation) key usages.
        """
        ca_key, ca_cert = self.get_or_create_root_ca()

        print(f"[*] Issuing Signer Certificate for: {common_name} ({key_type})...")
        if key_type.upper() == "RSA":
            signer_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        else:
            signer_key = ec.generate_private_key(ec.SECP256R1())

        now = datetime.datetime.now(datetime.timezone.utc)
        subject = x509.Name([
            x509.NameAttribute(NameOID.COUNTRY_NAME, "IN"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization),
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
        ])

        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(ca_cert.subject)
            .public_key(signer_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=3650))
            .not_valid_after(now + datetime.timedelta(days=3650))  # 10 years
            .add_extension(
                x509.BasicConstraints(ca=False, path_length=None),
                critical=True
            )
            .add_extension(
                x509.KeyUsage(
                    digital_signature=True,
                    content_commitment=True,  # Non-repudiation
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=False,
                    crl_sign=False,
                    encipher_only=False,
                    decipher_only=False
                ),
                critical=True
            )
            .add_extension(
                x509.ExtendedKeyUsage([
                    ExtendedKeyUsageOID.CODE_SIGNING,
                    ExtendedKeyUsageOID.EMAIL_PROTECTION,
                ]),
                critical=False
            )
            .add_extension(
                x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
                critical=False
            )
            .add_extension(
                x509.SubjectKeyIdentifier.from_public_key(signer_key.public_key()),
                critical=False
            )
            .sign(ca_key, hashes.SHA256())
        )

        safe_name = "".join(c for c in common_name if c.isalnum() or c in ("-", "_")).lower()
        key_file = os.path.join(self.storage_dir, f"{safe_name}.key")
        cert_file = os.path.join(self.storage_dir, f"{safe_name}.crt")

        with open(key_file, "wb") as f:
            f.write(signer_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption()
            ))

        with open(cert_file, "wb") as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))

        print(f"[+] Signer Certificate saved to {cert_file}")
        print(f"[+] Signer Private Key saved to {key_file}")
        return key_file, cert_file, self.ca_cert_path

