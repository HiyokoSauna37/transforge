# -*- coding: utf-8 -*-
"""Yomeru のロゴ: 小文字 y・開いた本・しおりを重ねた、背景のないマーク。
usage: python tools/make_icons.py （Pillow が必要）
SVG / PNG / content UI のマークを同じベジェ座標から生成する。
"""
from pathlib import Path
import re
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
ACCENT = "#C76B4D"
# ゆるやかに開く左右のページが y の両腕に、下へ流れるしおりがディセンダーになる。
OUTLINE = [
    ("M", 18, 24), ("C", 36, 19, 53, 30, 63, 47),
    ("C", 75, 30, 91, 20, 111, 23), ("C", 106, 48, 92, 67, 72, 77),
    ("C", 64, 101, 49, 115, 26, 109), ("L", 29, 96),
    ("C", 42, 100, 53, 90, 58, 77), ("C", 37, 70, 24, 50, 18, 24), ("Z",),
]
FOLDS = [
    [("M", 31, 36), ("C", 44, 40, 56, 54, 62, 67), ("C", 48, 59, 38, 47, 31, 36), ("Z",)],
    [("M", 98, 35), ("C", 85, 39, 73, 54, 68, 67), ("C", 81, 58, 92, 46, 98, 35), ("Z",)],
]


def path_data(commands):
    return " ".join(command[0] + " ".join(str(n) for n in command[1:]) for command in commands)


def mark_svg():
    d = " ".join(path_data(commands) for commands in [OUTLINE, *FOLDS])
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 14 108 108" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="{d}"/></svg>'


def polygon(commands):
    points = []
    current = (0, 0)
    for command in commands:
        op, *v = command
        if op in ("M", "L"):
            current = tuple(v)
            points.append(current)
        elif op == "C":
            p0 = current
            p1, p2, p3 = tuple(v[:2]), tuple(v[2:4]), tuple(v[4:])
            for i in range(1, 65):
                t = i / 64
                u = 1 - t
                points.append(tuple(u**3*p0[j] + 3*u*u*t*p1[j] + 3*u*t*t*p2[j] + t**3*p3[j] for j in (0, 1)))
            current = p3
    return points


def render(size):
    scale = 8
    canvas = Image.new("RGBA", (128*scale, 128*scale))
    draw = ImageDraw.Draw(canvas)
    draw.polygon([(x*scale, y*scale) for x, y in polygon(OUTLINE)], fill=ACCENT)
    for fold in FOLDS:
        draw.polygon([(x*scale, y*scale) for x, y in polygon(fold)], fill=(0, 0, 0, 0))
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    mark = mark_svg()
    (OUT / "mark.svg").write_text(mark + "\n", encoding="utf-8")
    icon = mark.replace('viewBox="10 14 108 108"', 'viewBox="0 0 128 128"').replace('fill="currentColor"', f'fill="{ACCENT}"')
    (OUT / "icon.svg").write_text(icon + "\n", encoding="utf-8")
    for size in (16, 32, 48, 128):
        render(size).save(OUT / f"icon{size}.png")
        print(f"wrote icon{size}.png")
    ui = ROOT / "content" / "ui.js"
    source = ui.read_text(encoding="utf-8")
    replacement = "  // BEGIN GENERATED MARK\n  const MARK = '" + mark + "';\n  // END GENERATED MARK"
    source, count = re.subn(r"  // BEGIN GENERATED MARK\n.*?  // END GENERATED MARK", lambda _: replacement, source, flags=re.S)
    if count != 1:
        raise RuntimeError("content/ui.js のマーク生成範囲が見つかりません")
    ui.write_text(source, encoding="utf-8")
    print("wrote mark.svg, icon.svg and content/ui.js mark")
