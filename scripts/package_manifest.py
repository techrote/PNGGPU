#!/usr/bin/env python3
"""Regenerate/check distributable source hashes, normalizing text CRLF to LF."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
TEXT_SUFFIXES = {".bat", ".ps1", ".mjs", ".js", ".wgsl", ".json", ".md",
                 ".html", ".yml", ".yaml", ".py", ".cpp", ".hpp", ".cu", ".txt"}


def inventory():
    paths = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT
    ).decode("utf-8").split("\0")
    result = {}
    for name in sorted(set(paths) - {"", "PACKAGE_MANIFEST.json"}):
        path = ROOT / name
        if not path.is_file():
            continue
        data = path.read_bytes()
        if path.suffix.lower() in TEXT_SUFFIXES or name in (".gitignore", ".gitattributes"):
            data = data.replace(b"\r\n", b"\n")
        result[name] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    path = ROOT / "PACKAGE_MANIFEST.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    files = inventory()
    if args.check:
        expected = manifest["files"]
        changed = sorted(name for name in files.keys() | expected.keys() if files.get(name) != expected.get(name))
        if changed:
            raise SystemExit("Package manifest differs: " + ", ".join(changed))
        print(f"Package manifest verified: {len(files)} source files (text hashes normalize CRLF to LF)")
    else:
        manifest["file_hash_policy"] = "SHA-256 and byte sizes after CRLF-to-LF normalization for text; raw bytes for binary. Manifest excludes itself."
        manifest["files"] = files
        path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(f"Recorded {len(files)} source files")


if __name__ == "__main__":
    main()
