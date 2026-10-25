# -*- coding: utf-8 -*-
"""TransForge のロゴ: 原文と訳文を表す二枚のページと、変換の矢印。
usage: python tools/make_icons.py （Pillow が必要）
  → icons/icon{16,32,48,128}.png、icons/mark.svg、icons/icon.svg
  → content/ui.js 内の同じマークも更新する。
SVG と PNG は同じ座標から生成。8 倍スーパーサンプリングで小サイズを描画。
"""
from pathlib import Path
import re
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
BG = "#C76B4D"
CREAM = "#FAF9F5"
# (bounds, radius, fill, stroke, stroke width)。背面が原文、前面が訳文。
PAGES = [
    ((23, 23, 72, 87), 9, None, CREAM, 6),
    ((54, 39, 106, 105), 10, CREAM, BG, 6),
]
LINES = [
    ([(35, 41), (55, 41)], CREAM, 5),
    ([(35, 53), (45, 53)], CREAM, 5),
    ([(67, 61), (92, 61)], BG, 5),
    ([(85, 54), (92, 61), (85, 68)], BG, 5),
    ([(68, 82), (91, 82)], BG, 5),
    ([(68, 92), (82, 92)], BG, 5),
]


def mark_svg():
    parts = []
    # 原文の罫線を先に描き、訳文のページで自然に覆う。
    for i, (bounds, radius, fill, stroke, width) in enumerate(PAGES):
        x, y, right, bottom = bounds
        parts.append(f'<rect x="{x}" y="{y}" width="{right-x}" height="{bottom-y}" rx="{radius}" fill="{fill or "none"}" stroke="{stroke}" stroke-width="{width}"/>')
        for points, color, line_width in (LINES[:2] if i == 0 else LINES[2:]):
            coords = " ".join(f'{x},{y}' for x, y in points)
            parts.append(f'<polyline points="{coords}" fill="none" stroke="{color}" stroke-width="{line_width}" stroke-linecap="round" stroke-linejoin="round"/>')
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="16 16 96 96" aria-hidden="true">' + ''.join(parts) + '</svg>'


def render(size):
    scale = 8
    canvas_size = 128 * scale
    image = Image.new("RGBA", (canvas_size, canvas_size))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, canvas_size-1, canvas_size-1), radius=28*scale, fill=BG)
    for i, (bounds, radius, fill, stroke, width) in enumerate(PAGES):
        # Pillow は輪郭を内側に描くため、SVG の中心線基準へ合わせる。
        half = width / 2
        x, y, right, bottom = bounds
        box = tuple(round(v*scale) for v in (x-half, y-half, right+half, bottom+half))
        draw.rounded_rectangle(box, radius=round((radius+half)*scale), fill=fill, outline=stroke, width=width*scale)
        for points, color, line_width in (LINES[:2] if i == 0 else LINES[2:]):
            scaled = [(x*scale, y*scale) for x, y in points]
            draw.line(scaled, fill=color, width=line_width*scale, joint="curve")
            r = line_width*scale/2
            for x, y in scaled:
                draw.ellipse((x-r, y-r, x+r, y+r), fill=color)
    return image.resize((size, size), Image.Resampling.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    mark = mark_svg()
    (OUT / "mark.svg").write_text(mark + "\n", encoding="utf-8")
    icon = mark.replace('viewBox="16 16 96 96"', 'viewBox="0 0 128 128"').replace('aria-hidden="true">', f'aria-hidden="true"><rect width="128" height="128" rx="28" fill="{BG}"/>', 1)
    (OUT / "icon.svg").write_text(icon + "\n", encoding="utf-8")
    for size in (16, 32, 48, 128):
        render(size).save(OUT / f"icon{size}.png")
        print(f"wrote icon{size}.png")
    ui = ROOT / "content" / "ui.js"
    source = ui.read_text(encoding="utf-8")
    pattern = r"  // BEGIN GENERATED MARK\n.*?  // END GENERATED MARK"
    replacement = "  // BEGIN GENERATED MARK\n  const MARK = '" + mark + "';\n  // END GENERATED MARK"
    source, count = re.subn(pattern, lambda _: replacement, source, flags=re.S)
    if count != 1:
        raise RuntimeError("content/ui.js のマーク生成範囲が見つかりません")
    ui.write_text(source, encoding="utf-8")
    print("wrote mark.svg, icon.svg and content/ui.js mark")
