# -*- coding: utf-8 -*-
"""TransForge のアイコン生成: テラコッタの角丸にクリーム色の羽根
usage: python tools/make_icons.py
  → icons/icon{16,32,48,128}.png と icons/feather.svg（content.js のインライン SVG と同じ制御点）
PIL だけで描く（ベジェは折れ線近似、8 倍スーパーサンプリング → LANCZOS 縮小）。
"""
import math
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "icons")
os.makedirs(OUT, exist_ok=True)

BG = (217, 119, 87)        # #D97757
BG_DEEP = (196, 98, 63)    # #C4623F
CREAM = (250, 249, 245)    # #FAF9F5
ROT = 38                   # 羽根の傾き(度)。SVG rotate と同じ向き(正で先端が右上)
CX, CY = 64.0, 64.0        # 回転中心(128 基準)

# ---- 羽根の形(128 基準・縦向き、先端が上) ----
VANE = [  # 閉じたベジェ列 (P0, P1, P2, P3)
    ((64, 12), (40, 28), (30, 64), (46, 92)),    # 左辺: 先端 → 下
    ((46, 92), (52, 95), (58, 96), (64, 96)),    # 下端: 左 → 軸
    ((64, 96), (70, 96), (74, 94), (78, 90)),    # 下端: 軸 → 右
    ((78, 90), (92, 64), (86, 30), (64, 12)),    # 右辺: 下 → 先端
]
RACHIS = ((64, 20), (62, 48), (62, 86), (64, 92))   # 羽軸(羽弁の中、背景色で抜く)
QUILL = ((64, 90), (64, 100), (65, 110), (67, 122))  # 羽柄(羽弁の外、クリーム)
CUTS = [  # 羽枝の切れ込み: 軸の近く → 外縁の少し外(背景色で抜く)
    ((62, 50), (37, 36)),
    ((62, 72), (33, 62)),
    ((66, 60), (92, 48)),
]


def bez(p0, p1, p2, p3, n=48):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        x = u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0]
        y = u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1]
        pts.append((x, y))
    return pts


def rot(p, deg=ROT):
    a = math.radians(deg)
    dx, dy = p[0] - CX, p[1] - CY
    return (CX + dx * math.cos(a) - dy * math.sin(a), CY + dx * math.sin(a) + dy * math.cos(a))


def vane_polygon():
    pts = []
    for seg in VANE:
        pts.extend(bez(*seg)[:-1])
    return pts


def draw_feather(layer, scale, bold=False):
    """透明レイヤーにクリームの羽根を描く(切れ込みと羽軸は透明で抜く)。scale = px / 128"""
    d = ImageDraw.Draw(layer)
    def P(p):
        q = rot(p)
        return (q[0] * scale, q[1] * scale)
    w_quill = (9 if bold else 6) * scale
    w_rachis = (0 if bold else 2.6) * scale
    w_cut = (0 if bold else 3.2) * scale
    # 羽柄(クリーム、丸端)
    q = [P(p) for p in bez(*QUILL)]
    d.line(q, fill=CREAM + (255,), width=int(w_quill), joint="curve")
    r = int(w_quill / 2)
    for p in (q[0], q[-1]):
        d.ellipse((p[0]-r, p[1]-r, p[0]+r, p[1]+r), fill=CREAM + (255,))
    # 羽弁
    d.polygon([P(p) for p in vane_polygon()], fill=CREAM + (255,))
    if bold:
        return
    # 羽軸と切れ込みを透明で抜く(PIL は合成せず上書きするので、透明色で描く = 消しゴム)
    ERASE = (0, 0, 0, 0)
    rp = [P(p) for p in bez(*RACHIS)]
    d.line(rp, fill=ERASE, width=int(w_rachis), joint="curve")
    for a, b in CUTS:
        pa, pb = P(a), P(b)
        d.line([pa, pb], fill=ERASE, width=int(w_cut))
        r = int(w_cut / 2)
        d.ellipse((pa[0]-r, pa[1]-r, pa[0]+r, pa[1]+r), fill=ERASE)


def render(size):
    SS = 8
    S = 128 * SS
    scale = S / 128.0
    # 背景: 角丸 + 縦グラデ
    grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / (S - 1)
        c = tuple(int(BG[i] * (1 - t) + BG_DEEP[i] * t) for i in range(3)) + (255,)
        gd.line((0, y, S, y), fill=c)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.24), fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)
    # 羽根
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw_feather(layer, scale, bold=size <= 32)
    img.alpha_composite(layer)
    return img.resize((size, size), Image.LANCZOS)


def svg_path():
    def f(v):
        return ("%.1f" % v).rstrip("0").rstrip(".")
    parts = ["M%s %s" % (f(VANE[0][0][0]), f(VANE[0][0][1]))]
    for p0, p1, p2, p3 in VANE:
        parts.append("C%s %s %s %s %s %s" % tuple(f(v) for v in (p1 + p2 + p3)))
    parts.append("Z")
    return " ".join(parts)


def write_svg():
    def f(v):
        return ("%.1f" % v).rstrip("0").rstrip(".")
    def cpath(seg):
        p0, p1, p2, p3 = seg
        return "M%s %s C%s %s %s %s %s %s" % tuple(f(v) for v in (p0 + p1 + p2 + p3))
    cuts = " ".join("M%s %s L%s %s" % tuple(f(v) for v in (a + b)) for a, b in CUTS)
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" class="fe">'
        '<g transform="rotate(%d 64 64)" fill="none" stroke-linecap="round">' % ROT +
        '<path class="fe-c" d="%s" stroke="#FAF9F5" stroke-width="6"/>' % cpath(QUILL) +
        '<path class="fe-c" d="%s" fill="#FAF9F5" stroke="none"/>' % svg_path() +
        '<path class="fe-x" d="%s" stroke="#D97757" stroke-width="2.6"/>' % cpath(RACHIS) +
        '<path class="fe-x" d="%s" stroke="#D97757" stroke-width="3.2"/>' % cuts +
        '</g></svg>'
    )
    with open(os.path.join(OUT, "feather.svg"), "w", encoding="utf-8", newline="\n") as fp:
        fp.write(svg + "\n")
    return svg


if __name__ == "__main__":
    for s in (16, 32, 48, 128):
        render(s).save(os.path.join(OUT, "icon%d.png" % s))
        print("wrote icon%d.png" % s)
    print("wrote feather.svg:", write_svg())
