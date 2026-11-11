"""Render design previews of the Alibaba Cloud chip and popover.

Draws assets/chip-alibaba.png (dock strip segment) and
assets/popover-alibaba.png (hover popover) in the dsh dark-accent idiom, so the
README can show the sixth provider before a live session screenshot exists.
Run: python scripts/make-chip-preview.py [-]  ('-' emits base64 PNG lines).
"""
from pathlib import Path
import base64
import io
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
STDOUT = len(sys.argv) > 1 and sys.argv[1] == "-"

STRIP = (35, 36, 39)
CARD = (38, 39, 42)
BORDER = (63, 64, 67)
LABEL = (154, 160, 166)
PRIMARY = (232, 232, 232)
TEAL = (47, 191, 160)
GREEN = (76, 175, 80)

REG = "C:/Windows/Fonts/segoeui.ttf"
BOLD = "C:/Windows/Fonts/segoeuib.ttf"
MARK = Image.open(ASSETS / "qwen-mark.png").convert("RGBA")


def mix(fg, bg, pct):
    return tuple(round(f * pct / 100 + b * (100 - pct) / 100) for f, b in zip(fg, bg))


def mark(img, x, y, color, s=14):
    """The Qwen knot, rasterized from the LobeHub glyph (assets/qwen-mark.png)."""
    m = MARK.resize((s, s), Image.LANCZOS)
    tint = Image.new("RGBA", (s, s), color + (255,))
    tint.putalpha(m.getchannel("A"))
    img.paste(tint, (x, y), tint)


def clock(d, cx, cy, color, r=5):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=1)
    d.line([(cx, cy), (cx + 3, cy - 3)], fill=color, width=1)


def emit(img, name):
    if STDOUT:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        print(f"{name}\t{base64.b64encode(buf.getvalue()).decode()}")
    else:
        img.save(ASSETS / name)
        print("wrote", name)


def chip():
    img = Image.new("RGB", (340, 36), STRIP)
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(REG, 12)
    fb = ImageFont.truetype(BOLD, 11)
    mark(img, 10, 11, LABEL)
    d.text((30, 18), "4.22%", font=f, fill=LABEL, anchor="lm")
    d.ellipse([70, 14, 78, 22], fill=GREEN)
    pill = "−40% · 6h 02m"
    tw = d.textlength(pill, font=fb)
    x0, x1 = 88, 88 + 14 + 6 + tw + 14
    d.rounded_rectangle([x0, 9, x1, 27], 9, fill=mix(TEAL, STRIP, 14), outline=mix(TEAL, STRIP, 38), width=1)
    clock(d, x0 + 10, 18, TEAL)
    d.text((x0 + 20, 18), pill, font=fb, fill=TEAL, anchor="lm")
    emit(img, "chip-alibaba.png")


def popover():
    w, h = 470, 152
    img = Image.new("RGB", (w, h), (24, 25, 28))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([4, 4, w - 5, h - 5], 8, fill=CARD, outline=BORDER, width=1)
    d.rounded_rectangle([4, 4, 7, h - 5], 2, fill=TEAL)
    f = ImageFont.truetype(REG, 12)
    fb = ImageFont.truetype(BOLD, 12)
    mark(img, 16, 14, PRIMARY, 13)
    d.text((34, 21), "Token Plan · Night −40% now", font=fb, fill=PRIMARY, anchor="lm")
    d.text((w - 16, 21), "day in 6h 02m", font=fb, fill=TEAL, anchor="rm")
    d.text((16, 44), "Nights 7:30 PM – 5:30 AM (GMT+5:30)", font=f, fill=LABEL, anchor="lm")
    d.text((16, 63), "Qwen −40% · DeepSeek-on-plan −50% during nights", font=f, fill=LABEL, anchor="lm")
    d.text((16, 82), "4.22% of 1-month credits used · resets in 1d 6h", font=f, fill=LABEL, anchor="lm")
    d.line([(16, 102), (w - 16, 102)], fill=BORDER, width=1)
    d.text((16, 122), "Click to refresh", font=f, fill=LABEL, anchor="lm")
    emit(img, "popover-alibaba.png")


chip()
popover()
