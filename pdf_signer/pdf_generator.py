"""
PDF Document Generator
Generates sample PDF documents (e.g. Lab Meeting Minutes or Formal Reports)
with designated areas for cryptographic digital signatures.
"""

import os
import datetime
import cairo


def generate_sample_document(output_pdf_path, title="LAB MEETING MINUTES & DECISION RECORD", author="Krishna Saha"):
    """Creates a sample PDF document using pycairo."""
    os.makedirs(os.path.dirname(os.path.abspath(output_pdf_path)), exist_ok=True)
    width, height = 595, 842  # A4 points

    surface = cairo.PDFSurface(output_pdf_path, width, height)
    cr = cairo.Context(surface)

    # Background header banner
    cr.set_source_rgb(0.12, 0.23, 0.38)  # Deep Navy
    cr.rectangle(0, 0, width, 90)
    cr.fill()

    # Header text
    cr.set_source_rgb(1.0, 1.0, 1.0)
    cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
    cr.set_font_size(18)
    cr.move_to(50, 45)
    cr.show_text("TRUSMEET RESEARCH LABORATORY")

    cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(11)
    cr.move_to(50, 68)
    cr.show_text("Digital Signature & Cryptographic Protocol Verification Unit")

    # Document Title
    cr.set_source_rgb(0.15, 0.15, 0.15)
    cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
    cr.set_font_size(15)
    cr.move_to(50, 130)
    cr.show_text(title)

    # Metadata table
    cr.set_source_rgb(0.92, 0.94, 0.97)
    cr.rectangle(50, 145, width - 100, 65)
    cr.fill()
    cr.set_source_rgb(0.7, 0.75, 0.85)
    cr.set_line_width(1)
    cr.rectangle(50, 145, width - 100, 65)
    cr.stroke()

    cr.set_source_rgb(0.2, 0.2, 0.2)
    cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
    cr.set_font_size(10)
    now_str = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    cr.move_to(65, 168)
    cr.show_text(f"Document ID:   DOC-TM-{datetime.datetime.now().strftime('%Y%m%d%H%M')}")
    cr.move_to(65, 185)
    cr.show_text(f"Generated On:  {now_str}")
    cr.move_to(65, 201)
    cr.show_text(f"Author/Host:   {author} (Verified Participant)")

    # Body Content
    sections = [
        ("1. Purpose & Cryptographic Scope",
         "This document records the official decisions and minutes of the TrusMeet Lab. "
         "In compliance with ISO 32000-1 and ETSI PAdES specifications, this document "
         "is digitally signed using an asymmetric cryptographic protocol with SHA-256 "
         "message digesting and detached CMS/PKCS#7 packaging."),
        
        ("2. Discussion Points & Research Findings",
         "- Validated C-DAC TrusToken USB hardware presence protocol.\n"
         "- Established Root Certificate Authority (CA) and X.509 end-entity certificate hierarchy.\n"
         "- Implemented detached digital signature architecture over document ByteRange.\n"
         "- Confirmed non-repudiation and global verification across Adobe Acrobat and Poppler."),
        
        ("3. Binding Confirmation",
         "The cryptographic signature appended below certifies the authenticity, data integrity, "
         "and non-repudiation of all contents in this file. Any alteration after signing will "
         "render the signature cryptographically invalid.")
    ]

    y = 240
    for heading, text in sections:
        cr.set_source_rgb(0.12, 0.23, 0.38)
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(12)
        cr.move_to(50, y)
        cr.show_text(heading)
        y += 18

        cr.set_source_rgb(0.25, 0.25, 0.25)
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        cr.set_font_size(10)
        for line in text.split("\n"):
            cr.move_to(50, y)
            cr.show_text(line)
            y += 15
        y += 15

    # Signature Area Placeholder Border
    cr.set_source_rgb(0.85, 0.88, 0.92)
    cr.set_dash([4.0, 4.0])
    cr.set_line_width(1)
    cr.rectangle(50, 680, width - 100, 90)
    cr.stroke()
    cr.set_dash([])

    cr.set_source_rgb(0.5, 0.55, 0.6)
    cr.set_font_size(9)
    cr.move_to(60, 698)
    cr.show_text("[Designated Cryptographic Digital Signature Area - Appended below via Incremental Update]")

    # Footer
    cr.set_source_rgb(0.6, 0.6, 0.6)
    cr.move_to(50, 815)
    cr.show_text("TrusMeet Security Architecture - Page 1 of 1")

    surface.finish()
    print(f"[+] Sample PDF document generated at: {output_pdf_path}")
    return output_pdf_path

