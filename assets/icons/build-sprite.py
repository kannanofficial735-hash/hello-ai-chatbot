#!/usr/bin/env python3
"""Build assets/icons/sprite.svg from the 20 individual icon SVGs.

Each icon becomes <symbol id="icon-<name>" viewBox="0 0 24 24" ...>
keeping the source root's fill/stroke attributes (outline vs filled differ).
app-icon.svg / app-icon-192.png are NOT part of the sprite (launcher master).

Regenerate whenever an icon changes; do not hand-edit sprite.svg.
"""
import re
import sys
from pathlib import Path

ICONS_DIR = Path(__file__).resolve().parent
OUT = ICONS_DIR / "sprite.svg"

# The 20 line/filled icons (PLAN §8.3). app-icon.svg excluded deliberately.
NAMES = [
    "home", "home-filled", "chat", "chat-filled", "history", "history-filled",
    "search", "profile", "profile-filled", "mic", "send", "plus", "pin",
    "settings", "close", "back", "sparkle", "more", "share", "check",
]

ROOT_ATTRS = ["viewBox", "fill", "stroke", "stroke-width",
              "stroke-linecap", "stroke-linejoin"]


def build_symbol(name: str) -> str:
    path = ICONS_DIR / f"{name}.svg"
    text = path.read_text(encoding="utf-8")
    m = re.search(r"<svg\s([^>]*)>(.*?)</svg>", text, re.S)
    if not m:
        raise SystemExit(f"{path}: could not parse <svg> root")
    attrs_text, inner = m.group(1), m.group(2).strip()
    attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', attrs_text))
    kept = " ".join(f'{k}="{attrs[k]}"' for k in ROOT_ATTRS if k in attrs)
    if attrs.get("viewBox") != "0 0 24 24":
        raise SystemExit(f"{path}: unexpected viewBox {attrs.get('viewBox')!r}")
    return f'  <symbol id="icon-{name}" {kept}>\n    {inner}\n  </symbol>'


def main() -> None:
    symbols = [build_symbol(n) for n in NAMES]
    out = (
        '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\n'
        "<!-- Generated from the 20 individual icons in this directory.\n"
        "     Do not hand-edit: regenerate with the sprite build script. -->\n"
        + "\n".join(symbols)
        + "\n</svg>\n"
    )
    OUT.write_text(out, encoding="utf-8")
    print(f"wrote {OUT} ({len(symbols)} symbols, {OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    sys.exit(main())
