"""Extract the textures the web port uses from an original BallDropGame checkout.

    python3 tools/c4-assets/extract.py ~/Projects/BallDropGame

Writes PNGs to apps/game-web/public/textures/. Pixel rows are kept in C4's stored order
(first stored row = texture v = 0), so load them in three.js with flipY = false.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from c4tex import read_tex, write_png  # noqa: E402

src = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/Projects/BallDropGame')
dst = os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'game-web', 'public', 'textures')

JOBS = [
    # The two flames. The sky, noise and gravel are procedural (apps/game-web/src/procedural.ts).
    ('Data/GTBallDrop/texture/red_flame.tex', 'red_flame.png', True),   # fire pits
    ('Data/GTBallDrop/texture/blue_flame.tex', 'blue_flame.png', True), # a missed ball on fire
]

for rel, out, alpha in JOBS:
    info, w, h, px = read_tex(os.path.join(src, rel))
    path = os.path.join(dst, out)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    write_png(path, w, h, px, keep_alpha=alpha)
    print(f'{rel} -> public/textures/{out}  ({w}x{h} {info["format"]} {info.get("s3tc", info["compression"])})')
