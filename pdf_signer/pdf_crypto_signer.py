"""
PDF Cryptographic Signer
Signs PDF documents using standard Cryptographic Message Syntax (CMS / PKCS#7)
and PAdES (ETSI EN 319 142 / ISO 32000-1) specifications.
"""

import os
import datetime
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import fields, signers
from pyhanko.stamp import StaticStampStyle, TextStampStyle
from pyhanko.pdf_utils.images import PdfImage
from PIL import Image, ImageDraw, ImageFont


class CustomPdfSigner(signers.PdfSigner):
    """PdfSigner subclass that supports explicit signing timestamps."""
    def __init__(self, *args, signing_datetime=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.signing_datetime = signing_datetime

    def init_signing_session(self, pdf_out, existing_fields_only=False):
        session = super().init_signing_session(pdf_out, existing_fields_only)
        if self.signing_datetime is not None:
            session.system_time = self.signing_datetime
        return session


def create_signature_badge(signer_name, reason="Certified True Copy", state="unverified", signing_time=None):
    """
    Renders an authentic Adobe Acrobat / Aadhaar style signature stamp:
    - Large semi-transparent Yellow Question Mark '?' centered right in the middle
    - Foreground text rendered cleanly with full opacity on top
    - Transparent canvas seamlessly overlaid onto the document
    """
    w, h = 550, 180
    img = Image.new("RGBA", (w, h), (255, 255, 255, 0))

    font_path = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
    font_bold_path = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"

    font_q = ImageFont.truetype(font_bold_path, 150)
    font_title = ImageFont.truetype(font_path, 28)
    font_text = ImageFont.truetype(font_path, 18)

    # 1. Semi-transparent Question Mark layer
    q_layer = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    q_draw = ImageDraw.Draw(q_layer)

    # Position in the exact middle of the signature text block
    bbox = font_q.getbbox("?")
    q_w = bbox[2] - bbox[0]
    q_h = bbox[3] - bbox[1]
    qx = (w - q_w) // 2 - 25
    qy = (h - q_h) // 2 - 20

    # 3D Drop shadow (semi-transparent black)
    q_draw.text((qx + 4, qy + 4), "?", fill=(20, 20, 20, 90), font=font_q)

    # Outline (semi-transparent black)
    for dx in range(-2, 3):
        for dy in range(-2, 3):
            if dx != 0 or dy != 0:
                q_draw.text((qx + dx, qy + dy), "?", fill=(0, 0, 0, 130), font=font_q)

    # Transparent yellow body (~65% opacity so text remains clear)
    q_draw.text((qx, qy), "?", fill=(255, 245, 60, 165), font=font_q)

    # Composite question mark layer
    img = Image.alpha_composite(img, q_layer)
    draw = ImageDraw.Draw(img)

    # 2. Text layout on top (100% opacity)
    draw.text((10, 8), "Signature Not Verified", fill=(0, 0, 0, 255), font=font_title)

    prefix = "Digitally signed by "
    full_name_line = prefix + signer_name
    if signing_time is not None:
        now_str = signing_time.strftime("%d/%m/%Y %H:%M:%S")
    else:
        now_str = datetime.datetime.now().strftime("%d/%m/%Y %H:%M:%S")

    y = 52
    if len(full_name_line) > 34:
        words = signer_name.split()
        if len(words) >= 2:
            draw.text((10, y), prefix + " ".join(words[:2]), fill=(0, 0, 0, 255), font=font_text)
            y += 24
            draw.text((10, y), " ".join(words[2:]), fill=(0, 0, 0, 255), font=font_text)
            y += 24
        else:
            draw.text((10, y), full_name_line, fill=(0, 0, 0, 255), font=font_text)
            y += 28
    else:
        draw.text((10, y), full_name_line, fill=(0, 0, 0, 255), font=font_text)
        y += 28

    clean_reason = reason.replace("Reason:", "")
    draw.text((10, y), f"Reason:{clean_reason}", fill=(0, 0, 0, 255), font=font_text)
    y += 26
    draw.text((10, y), f"Date:{now_str}", fill=(0, 0, 0, 255), font=font_text)

    return img


class PDFCryptoSigner:
    def __init__(self, key_path, cert_path, ca_cert_path=None):
        self.key_path = key_path
        self.cert_path = cert_path
        self.ca_cert_path = ca_cert_path

    def sign_pdf(
        self,
        input_pdf_path,
        output_pdf_path,
        sig_field_name="TrusMeetSignature",
        reason="Certified True Copy",
        location="TrusMeet Secure Lab",
        visual=True,
        visual_state="unverified",
        signing_datetime=None,
    ):
        """
        Signs an input PDF using detached CMS/PKCS#7.
        - signing_datetime: Explicit datetime to prevent 'Signature signed in future' clock skew errors.
        """
        os.makedirs(os.path.dirname(os.path.abspath(output_pdf_path)), exist_ok=True)

        ca_chain = [self.ca_cert_path] if self.ca_cert_path else None
        signer_info = signers.SimpleSigner.load(
            key_file=self.key_path,
            cert_file=self.cert_path,
            ca_chain_files=ca_chain,
            prefer_pss=False
        )

        sig_meta = signers.PdfSignatureMetadata(
            field_name=sig_field_name,
            reason=reason,
            location=location,
            subfilter=fields.SigSeedSubFilter.ADOBE_PKCS7_DETACHED,
            md_algorithm="sha256",
        )

        with open(input_pdf_path, "rb") as inf:
            w = IncrementalPdfFileWriter(inf)

            if visual:
                sig_box = (50, 65, 360, 160)
                field_spec = fields.SigFieldSpec(
                    sig_field_name=sig_field_name,
                    on_page=0,
                    box=sig_box
                )

                signer_common_name = signer_info.signing_cert.subject.native.get("common_name", "Authorized Signer")
                badge_img = create_signature_badge(
                    signer_common_name, reason, state=visual_state, signing_time=signing_datetime
                )
                stamp_style = StaticStampStyle(
                    background=PdfImage(badge_img),
                    border_width=0
                )

                pdf_signer = CustomPdfSigner(
                    signature_meta=sig_meta,
                    signer=signer_info,
                    stamp_style=stamp_style,
                    new_field_spec=field_spec,
                    signing_datetime=signing_datetime,
                )
            else:
                fields.append_signature_field(
                    w, sig_field_spec=fields.SigFieldSpec(sig_field_name=sig_field_name)
                )
                pdf_signer = CustomPdfSigner(
                    signature_meta=sig_meta,
                    signer=signer_info,
                    signing_datetime=signing_datetime,
                )

            with open(output_pdf_path, "wb") as outf:
                pdf_signer.sign_pdf(w, output=outf)

        print(f"[+] PDF signed cryptographically: {output_pdf_path}")
        return output_pdf_path

