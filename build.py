#!/usr/bin/env python3
"""
Threadkeeper build script.
Produces dist/threadkeeper-firefox.zip and dist/threadkeeper-chrome.zip
"""

import json
import zipfile
import shutil
from pathlib import Path

ROOT = Path.home() / "dev/projects/active/threadkeeper"
DIST = ROOT / "dist"

COMMON_FILES = [
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "icons/icon-96.png",
    "icons/icon-128.png",
    "popup/popup.html",
    "popup/popup.css",
    "popup/popup.js",
    "export/export.html",
    "export/export.css",
    "export/export.js",
    "content-scripts/shared.js",
    "content-scripts/gemini.js",
    "content-scripts/chatgpt.js",
    "content-scripts/claude.js",
    "background/background.js",
    "lib/filename.js",
    "lib/markdown.js",
    "lib/json.js",
    "LICENSE",
    "README.md",
    "ACKNOWLEDGMENTS.md",
]

def build_zip(name: str, manifest_path: Path, extra_files: list = []):
    out = DIST / name
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
        # Write manifest as manifest.json regardless of source filename
        zf.write(manifest_path, "manifest.json")
        for f in COMMON_FILES + extra_files:
            full = ROOT / f
            if not full.exists():
                print(f"  ⚠ missing: {f}")
                continue
            zf.write(full, f)
    size_kb = out.stat().st_size // 1024
    print(f"  ✓ {name} ({size_kb} KB)")
    return out

def main():
    DIST.mkdir(exist_ok=True)

    print("📦 Building Firefox package...")
    build_zip(
        "threadkeeper-firefox.zip",
        ROOT / "manifest.json",
    )

    print("📦 Building Chrome package...")
    build_zip(
        "threadkeeper-chrome.zip",
        ROOT / "manifest.chrome.json",
        extra_files=["background/sw.js"],
    )

    print("\n✨ Done.")
    print(f"   Firefox: dist/threadkeeper-firefox.zip  → addons.mozilla.org")
    print(f"   Chrome:  dist/threadkeeper-chrome.zip   → chrome.google.com/webstore/devconsole")

if __name__ == "__main__":
    main()
