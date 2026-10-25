# -*- coding: utf-8 -*-
"""README 用画像の仕上げ: tools/capture_readme.mjs が撮った PNG を WebP にし、原文/訳文の比較画像を作る
usage: python tools/make_readme_assets.py [shotsDir]   （既定 docs/shots。PNG は残し、*.webp を同じ場所に書く）
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "docs", "shots")
CREAM = (250, 249, 245)
INK = (31, 30, 29)
LINE = (216, 212, 200)
ACCENT = (217, 119, 87)
FONTS = [
    os.environ.get("README_FONT", ""),
    r"C:\Windows\Fonts\NotoSansJP-VF.ttf",
    r"C:\Windows\Fonts\YuGothB.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
]


def font(size):
    for p in FONTS:
        if p and os.path.exists(p):
            f = ImageFont.truetype(p, size)
            try:
                f.set_variation_by_name("Bold")
            except Exception:
                pass
            return f
    return ImageFont.load_default()


def rounded(im, radius):
    mask = Image.new("L", im.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, im.width - 1, im.height - 1), radius=radius, fill=255)
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    return out


def panel(path, width):
    im = Image.open(path).convert("RGB")
    h = round(im.height * width / im.width)
    im = im.resize((width, h), Image.LANCZOS)
    frame = Image.new("RGB", (width + 2, h + 2), LINE)
    frame.paste(im, (1, 1))
    return rounded(frame, 12)


def compare(before, after, out):
    """原文と置き換え後を横に並べる"""
    W, GAP, M, LABEL = 880, 28, 28, 54
    a, b = panel(before, W), panel(after, W)
    canvas = Image.new("RGB", (M * 2 + W * 2 + GAP + 4, M * 2 + LABEL + a.height), CREAM)
    d = ImageDraw.Draw(canvas)
    f = font(26)
    for x, label, im in ((M, "原文", a), (M + W + GAP + 2, "Yomeru で翻訳（置き換え）", b)):
        d.rounded_rectangle((x, M, x + 10, M + 34), radius=5, fill=ACCENT)
        d.text((x + 22, M + 2), label, font=f, fill=INK)
        canvas.paste(im, (x, M + LABEL), im)
    canvas.save(out, "WEBP", quality=90, method=6)
    print("wrote", os.path.basename(out), canvas.size)


def to_webp(name, max_width=None):
    src = os.path.join(SHOTS, name + ".png")
    if not os.path.exists(src):
        print("skip (missing)", name)
        return
    im = Image.open(src).convert("RGB")
    if max_width and im.width > max_width:
        im = im.resize((max_width, round(im.height * max_width / im.width)), Image.LANCZOS)
    dst = os.path.join(SHOTS, name + ".webp")
    im.save(dst, "WEBP", quality=90, method=6)
    print("wrote", os.path.basename(dst), im.size, os.path.getsize(dst) // 1024, "KB")


if __name__ == "__main__":
    for n in ("replace", "bilingual", "selection", "explanation", "question", "popup", "options"):
        to_webp(n)
    compare(os.path.join(SHOTS, "before.png"), os.path.join(SHOTS, "replace.png"), os.path.join(SHOTS, "compare.webp"))
