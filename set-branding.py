#!/usr/bin/env python3
"""Sets the name and logo this TrusMeet installation shows in the app and on minutes.

Examples:
  python3 set-branding.py --name "Crypto Lab, IIT Example" \
      --organisation "Indian Institute of Technology Example" \
      --department "Department of CSE, Crypto Lab" --logo ~/Downloads/logo.png
  python3 set-branding.py --show
  python3 set-branding.py --reset          # back to the built-in defaults

Writes data/branding/branding.json and three logo files made from your image:
logo.png (app header, 256 px), favicon.png (browser tab, 64 px) and
logo-pdf.jpg (minutes letterhead, 360 px). Needs Pillow for --logo
(sudo apt install python3-pil). Reload the page afterwards; no restart needed.
"""
import argparse
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("TRUSTOKEN_DATA_DIR", os.path.join(HERE, "data"))
BRANDING_DIR = os.path.join(DATA_DIR, "branding")
CONFIG = os.path.join(BRANDING_DIR, "branding.json")
LIMITS = {"name": 120, "subtitle": 160, "organisation": 200, "department": 200}


def load():
    try:
        with open(CONFIG, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_logo(path):
    try:
        from PIL import Image
    except ImportError:
        sys.exit("Pillow is needed for --logo: sudo apt install python3-pil")
    try:
        src = Image.open(os.path.expanduser(path))
    except OSError as err:
        sys.exit(f"Could not open the logo: {err}")
    # Transparent parts become white, and the image is centred on a square.
    src = src.convert("RGBA")
    white = Image.new("RGBA", src.size, (255, 255, 255, 255))
    src = Image.alpha_composite(white, src).convert("RGB")
    side = max(src.size)
    square = Image.new("RGB", (side, side), (255, 255, 255))
    square.paste(src, ((side - src.width) // 2, (side - src.height) // 2))
    square.resize((256, 256), Image.LANCZOS).save(os.path.join(BRANDING_DIR, "logo.png"), optimize=True)
    square.resize((64, 64), Image.LANCZOS).save(os.path.join(BRANDING_DIR, "favicon.png"), optimize=True)
    square.resize((360, 360), Image.LANCZOS).save(os.path.join(BRANDING_DIR, "logo-pdf.jpg"), "JPEG",
                                                  quality=90, progressive=False, optimize=True)


def main():
    parser = argparse.ArgumentParser(description="Set the name and logo of this TrusMeet installation.")
    parser.add_argument("--name", help="Shown in the app header and browser tab, e.g. 'Crypto Lab, IIT Example'")
    parser.add_argument("--subtitle", help="Second line of the app header")
    parser.add_argument("--organisation", help="Pre-filled in new minutes, e.g. 'Indian Institute of Technology Example'")
    parser.add_argument("--department", help="Pre-filled in new minutes, e.g. 'Department of CSE'")
    parser.add_argument("--logo", help="Path to the logo image (PNG, JPG or another common format)")
    parser.add_argument("--show", action="store_true", help="Show the current settings")
    parser.add_argument("--reset", action="store_true", help="Remove all branding and use the defaults")
    args = parser.parse_args()

    if args.reset:
        shutil.rmtree(BRANDING_DIR, ignore_errors=True)
        print("Branding removed; the built-in defaults are used.")
        return
    if args.show:
        print(json.dumps(load(), indent=2, ensure_ascii=False) or "{}")
        print("Custom logo:", "yes" if os.path.exists(os.path.join(BRANDING_DIR, "logo.png")) else "no (default logo)")
        return

    config = load()
    for key, limit in LIMITS.items():
        value = getattr(args, key)
        if value is None:
            continue
        value = value.strip()
        if len(value) > limit:
            sys.exit(f"--{key} is too long (at most {limit} characters).")
        config[key] = value
    os.makedirs(BRANDING_DIR, exist_ok=True)
    if args.logo:
        save_logo(args.logo)
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    print("Saved branding:", json.dumps(config, ensure_ascii=False))
    if args.logo:
        print("Saved the logo for the header, the browser tab and the minutes letterhead.")
    print("Reload the meeting page to see it.")


if __name__ == "__main__":
    main()
