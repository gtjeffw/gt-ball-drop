"""Extract the textures the web port uses from an original BallDropGame checkout.

    python3 tools/c4-assets/extract.py ~/Projects/BallDropGame

Writes PNGs to apps/game-web/public/c4/. Pixel rows are kept in C4's stored order
(first stored row = texture v = 0), so load them in three.js with flipY = false. The
skybox orientation was checked by matching pixels along all eight seams.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from c4tex import read_tex, write_png  # noqa: E402

src = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/Projects/BallDropGame')
dst = os.path.join(os.path.dirname(__file__), '..', '..', 'apps', 'game-web', 'public', 'c4')

JOBS = [
    # Skybox of the pre-Oct-2012 worlds (GTBallDrop.wld, GTBallDrop_NO_PT_LIGHTS.wld).
    # C4 face order: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z (top), 5 -Z (bottom).
    *[(f'old_data_GTBallDrop/sky/Bright{i + 1}.tex', f'sky/bright/{i}.png', False) for i in range(6)],
    ('Data/GTBallDrop/texture/red_flame.tex', 'texture/red_flame.png', True),   # clean world's fire pits
    ('Data/GTBallDrop/texture/blue_flame.tex', 'texture/blue_flame.png', True), # a missed ball on fire
    ('old_data_GTBallDrop/texture/Flame.tex', 'texture/Flame.png', True),       # classic world's fire pits
    ('old_data_GTBallDrop/texture/Wall.tex', 'texture/Wall.png', False),        # new_wall material
    ('Data/C4/C4/noise.tex', 'texture/noise.png', False),                       # the fire shader's distortion noise
]

for rel, out, alpha in JOBS:
    info, w, h, px = read_tex(os.path.join(src, rel))
    path = os.path.join(dst, out)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    write_png(path, w, h, px, keep_alpha=alpha)
    print(f'{rel} -> public/c4/{out}  ({w}x{h} {info["format"]} {info.get("s3tc", info["compression"])})')
