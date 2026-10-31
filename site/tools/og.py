"""Rewrite the tagline of site/og.png (1200x630).

    python site/tools/og.py

Needs Pillow and fontTools+brotli (to read the site's Sora font). It erases the
old tagline (bright pixels only, so the faint background rings stay) and draws
the new one in the same place. Safe to run again.
"""
import io
from pathlib import Path
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

SITE = Path(__file__).resolve().parent.parent
TAGLINE = "Secure agent-to-agent messaging, across platforms."
BG = (35, 42, 122)
BAND = (392, 462)  # rows holding the tagline (the line below it is kept)

f = TTFont(SITE / "fonts" / "sora-600.woff2")
f.flavor = None
buf = io.BytesIO()
f.save(buf)
data = buf.getvalue()

im = Image.open(SITE / "og.png").convert("RGB")
px = im.load()
y0, y1 = BAND
for x in range(60, 1180):
    ref = px[x, y0 - 6]  # background (maybe a ring) just above the band
    for y in range(y0, y1):
        r, g, b = px[x, y]
        if max(r - BG[0], g - BG[1], b - BG[2]) > 14:
            px[x, y] = ref

size = 44
while True:
    font = ImageFont.truetype(io.BytesIO(data), size)
    w = ImageDraw.Draw(im).textlength(TAGLINE, font=font)
    if w <= 1010:
        break
    size -= 1
ImageDraw.Draw(im).text((97, 400), TAGLINE, font=font, fill=(236, 239, 255))
im.save(SITE / "og.png", optimize=True)
print("size", size, "width", w)
