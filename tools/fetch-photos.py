"""Downloads the portraits from data/<period>/people.json into photos/<period>/<id>.jpg,
downscaled, so the quiz does not depend on psp.cz answering (it times out under load).

    pip install pillow
    python tools/fetch-photos.py [period]

Existing files are kept; delete one to fetch it again. tools/build.mjs uses the local copy
when it exists and the original URL otherwise.
"""

import io
import json
import sys
import time
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
WIDTH = 320


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (poznej-poslance)"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return res.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def main(period):
    people = json.loads((ROOT / "data" / period / "people.json").read_text(encoding="utf-8"))
    out = ROOT / "photos" / period
    out.mkdir(parents=True, exist_ok=True)
    made = 0
    for p in people:
        target = out / f"{p['id']}.jpg"
        if target.exists():
            continue
        try:
            im = Image.open(io.BytesIO(fetch(p["photo"]))).convert("RGB")
        except Exception as err:
            print(f"  {p['id']} {p['name']}: {err}")
            continue
        if im.width > WIDTH:
            im = im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
        im.save(target, "JPEG", quality=80, optimize=True, progressive=True)
        made += 1
        time.sleep(0.2)  # be gentle with psp.cz
    print(f"{made} new photos, {len(list(out.glob('*.jpg')))} in photos/{period}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "2025-2029")
