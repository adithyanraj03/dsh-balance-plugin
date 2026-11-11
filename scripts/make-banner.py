"""Regenerate assets/banner-light.png and assets/banner-dark.png.

Self-contained 1400x400 banners in the dsh-graft grammar: flat background, a
soft teal glow, the balance mark (status pill + gold coin + red sweep hand),
a bold wordmark, a monospace tagline, and two tilted screenshot cards on the
right. Run with the bundled Python: python scripts/make-banner.py
"""
from pathlib import Path
import base64
import io
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
# The bundled Python may be write-sandboxed; '-' emits base64 PNG lines on
# stdout for the caller to decode, an optional path redirects output instead.
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ASSETS
STDOUT = len(sys.argv) > 1 and sys.argv[1] == "-"
W, H = 1400, 400
TEAL = (47, 191, 160)
RED = (239, 74, 87)
GOLD = (232, 160, 32)
GOLD_HI = (255, 215, 106)

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_MONO = "C:/Windows/Fonts/consola.ttf"


def cover(img: Image.Image, w: int, h: int) -> Image.Image:
    """Resize-and-center-crop to exactly w x h."""
    scale = max(w / img.width, h / img.height)
    resized = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    left = (resized.width - w) // 2
    top = (resized.height - h) // 2
    return resized.crop((left, top, left + w, top + h))


def rounded(img: Image.Image, radius: int) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def card(base: Image.Image, shot: Image.Image, x: int, y: int, w: int, h: int, radius: int, angle: float = 0.0):
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([x + 6, y + 8, x + 6 + w, y + 8 + h], radius, fill=(0, 0, 0, 41))
    base.alpha_composite(shadow)
    piece = rounded(cover(shot, w, h), radius)
    border = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle([0, 0, w - 1, h - 1], radius, outline=(0, 0, 0, 36), width=2)
    piece.alpha_composite(border)
    if angle:
        piece = piece.rotate(angle, expand=True, resample=Image.BICUBIC)
    base.alpha_composite(piece, (x, y))


def mark(base: Image.Image, pill: tuple):
    d = ImageDraw.Draw(base)
    ox, oy = 65, 105
    d.rounded_rectangle([ox, oy + 40, ox + 210, oy + 150], 55, fill=pill, outline=TEAL, width=7)
    d.ellipse([ox + 24, oy + 57, ox + 100, oy + 133], fill=GOLD)
    d.ellipse([ox + 30, oy + 63, ox + 88, oy + 121], fill=GOLD_HI)
    d.ellipse([ox + 32, oy + 65, ox + 92, oy + 125], outline=(138, 90, 18, 140), width=2)
    d.line([ox + 62, oy + 95, ox + 86, oy + 67], fill=RED, width=6)
    d.ellipse([ox + 57, oy + 90, ox + 67, oy + 100], fill=RED)
    d.line([ox + 120, oy + 95, ox + 130, oy + 95], fill=TEAL, width=5)
    d.line([ox + 136, oy + 95, ox + 140, oy + 95], fill=TEAL, width=5)
    d.line([ox + 146, oy + 95, ox + 156, oy + 95], fill=TEAL, width=5)
    for start in (300, 330, 0, 30):
        d.arc([ox + 148, oy + 75, ox + 188, oy + 115], start, start + 18, fill=TEAL, width=5)


def glow(base: Image.Image):
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    for r, alpha in ((165, 10), (120, 12), (75, 14)):
        d.ellipse([170 - r, 200 - r, 170 + r, 200 + r], fill=TEAL + (alpha,))
    base.alpha_composite(overlay)


def banner(bg: tuple, ink: tuple, tag: tuple, pill: tuple, out: str):
    base = Image.new("RGBA", (W, H), bg + (255,))
    glow(base)
    mark(base, pill)
    d = ImageDraw.Draw(base)
    d.text((320, 225), "balance", font=ImageFont.truetype(FONT_BOLD, 110), fill=ink, anchor="ls")
    d.text((324, 272), "Balances & peak countdowns in your composer.",
           font=ImageFont.truetype(FONT_MONO, 18), fill=tag, anchor="ls")
    card(base, Image.open(ASSETS / "providers.png"), 975, 22, 400, 235, 14)
    card(base, Image.open(ASSETS / "sidebar-dark.png"), 865, 142, 420, 247, 12, angle=-2)
    if STDOUT:
        buf = io.BytesIO()
        base.convert("RGB").save(buf, format="PNG")
        print(f"{out}\t{base64.b64encode(buf.getvalue()).decode()}")
    else:
        base.convert("RGB").save(OUT / out)
        print("wrote", out)


banner((244, 245, 247), (26, 31, 44), (92, 100, 112), (20, 24, 36), "banner-light.png")
banner((20, 24, 36), (244, 245, 247), (154, 163, 178), (13, 17, 23), "banner-dark.png")
