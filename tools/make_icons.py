"""PWA 用アイコンを icons/ に生成する。使い方: python tools/make_icons.py

暗いグレー地に、重なった 2 枚のカードと 4 色の回答ボタンを描く(文字は使わない)。
図形はすべて中央 60% に収めてあり、maskable アイコン(端が切り取られる)でも欠けない。
iPhone は透過部分を黒で埋めるので、背景は全面塗りつぶし。
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024  # 大きく描いてから縮小して、輪郭をなめらかにする
BG = "#1e1f22"
BACK_CARD = "#44474d"
FRONT_CARD = "#e2e0dc"
BAR = "#a3a6ad"
BUTTONS = ["#e57373", "#d9a05b", "#81c784", "#64b5f6"]  # もう一度/難しい/正解/簡単(index.html の色と同じ)


def draw_master() -> Image.Image:
    img = Image.new("RGB", (SIZE, SIZE), BG)
    d = ImageDraw.Draw(img)

    # 奥のカード
    d.rounded_rectangle((250, 215, 720, 705), radius=64, fill=BACK_CARD)
    # 手前のカード
    d.rounded_rectangle((304, 319, 774, 809), radius=64, fill=FRONT_CARD)

    # 見出し語を表す太い線と、補足を表す細い線
    d.rounded_rectangle((364, 392, 620, 448), radius=28, fill=BG)
    d.rounded_rectangle((364, 478, 700, 512), radius=17, fill=BAR)
    d.rounded_rectangle((364, 538, 640, 572), radius=17, fill=BAR)

    # 4 つの回答ボタン
    x, w, gap = 364, 74, 18
    for color in BUTTONS:
        d.rounded_rectangle((x, 660, x + w, 740), radius=20, fill=color)
        x += w + gap
    return img


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    master = draw_master()
    targets = {
        "icon-192.png": 192,
        "icon-512.png": 512,
        "icon-maskable-512.png": 512,
        "apple-touch-icon.png": 180,
    }
    for name, px in targets.items():
        master.resize((px, px), Image.LANCZOS).save(out / name, optimize=True)
        print(f"wrote icons/{name} ({px}x{px})")


if __name__ == "__main__":
    main()
