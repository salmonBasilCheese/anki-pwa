"""PWA 用アイコンを生成する。
使い方: python tools/make_icons.py        → icons/(安定版)
       python tools/make_icons.py --dev  → icons-dev/(開発版。背景が紫で見分けがつく)

暗いグレー地に、重なった 2 枚のカードと 4 色の回答ボタンを描く(文字は使わない)。
図形はすべて中央 60% に収めてあり、maskable アイコン(端が切り取られる)でも欠けない。
iPhone は透過部分を黒で埋めるので、背景は全面塗りつぶし。
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024  # 大きく描いてから縮小して、輪郭をなめらかにする
BG = "#1e1f22"
BACK_CARD = "#44474d"
DEV_BG = "#4a2a6e"        # 開発版: ホーム画面で安定版と見分けるため背景を紫にする
DEV_BACK_CARD = "#7a5aa0"
FRONT_CARD = "#e2e0dc"
BAR = "#a3a6ad"
BUTTONS = ["#e57373", "#d9a05b", "#81c784", "#64b5f6"]  # もう一度/難しい/正解/簡単(index.html の色と同じ)


def draw_master(bg: str = BG, back_card: str = BACK_CARD) -> Image.Image:
    img = Image.new("RGB", (SIZE, SIZE), bg)
    d = ImageDraw.Draw(img)

    # 奥のカード
    d.rounded_rectangle((250, 215, 720, 705), radius=64, fill=back_card)
    # 手前のカード
    d.rounded_rectangle((304, 319, 774, 809), radius=64, fill=FRONT_CARD)

    # 見出し語を表す太い線と、補足を表す細い線
    d.rounded_rectangle((364, 392, 620, 448), radius=28, fill=bg)
    d.rounded_rectangle((364, 478, 700, 512), radius=17, fill=BAR)
    d.rounded_rectangle((364, 538, 640, 572), radius=17, fill=BAR)

    # 4 つの回答ボタン
    x, w, gap = 364, 74, 18
    for color in BUTTONS:
        d.rounded_rectangle((x, 660, x + w, 740), radius=20, fill=color)
        x += w + gap
    return img


def main() -> None:
    dev = "--dev" in sys.argv[1:]
    dirname = "icons-dev" if dev else "icons"
    out = Path(__file__).resolve().parent.parent / dirname
    out.mkdir(exist_ok=True)
    master = draw_master(DEV_BG, DEV_BACK_CARD) if dev else draw_master()
    targets = {
        "icon-192.png": 192,
        "icon-512.png": 512,
        "icon-maskable-512.png": 512,
        "apple-touch-icon.png": 180,
    }
    for name, px in targets.items():
        master.resize((px, px), Image.LANCZOS).save(out / name, optimize=True)
        print(f"wrote {dirname}/{name} ({px}x{px})")


if __name__ == "__main__":
    main()
