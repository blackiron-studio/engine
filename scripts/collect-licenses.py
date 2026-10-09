#!/usr/bin/env python3
"""Collect installed upstream notices for the versions pinned in the lockfiles."""
from pathlib import Path
import json
import os
import re
import tomllib

root = Path(__file__).resolve().parent.parent
cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
cache = cargo_home / "registry" / "src"
packages = set()
for lockfile in [root / "kernel/Cargo.lock", root / "host/Cargo.lock"]:
    for package in tomllib.loads(lockfile.read_text())["package"]:
        if package.get("source", "").startswith("registry"):
            packages.add((package["name"], package["version"]))

sections = ["Blackiron Engine: upstream licenses and notices\n"]
missing = []


def notices(path):
    return sorted(p for p in path.rglob("*") if p.is_file()
                  and re.match(r"^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)(?:$|[._-])", p.name, re.I))


def collect(label, path, metadata, source):
    sections.append(f"\n{'=' * 72}\n{label}\nLicense: {metadata.get('license', 'See upstream notice text')}\nSource: {source}\n")
    for notice in notices(path):
        try:
            text = notice.read_text()
        except (UnicodeError, OSError):
            continue
        sections.append(f"\n--- {notice.relative_to(path)} ---\n{text}\n")


for name, version in sorted(packages):
    sources = sorted(cache.glob(f"*/{name}-{version}"))
    if not sources:
        missing.append(f"{name}@{version}")
        continue
    path = sources[0]
    collect(f"Rust: {name}@{version}", path,
            tomllib.loads((path / "Cargo.toml").read_text())["package"],
            f"https://crates.io/crates/{name}/{version}")

for manifest in sorted((root / "node_modules").glob("**/package.json")):
    if "/node_modules/.bun/" in str(manifest):
        continue
    metadata = json.loads(manifest.read_text())
    collect(f"npm: {metadata.get('name')}@{metadata.get('version')}",
            manifest.parent, metadata,
            f"https://www.npmjs.com/package/{metadata.get('name')}/v/{metadata.get('version')}")

destination = root / "licenses"
destination.mkdir(exist_ok=True)
(destination / "third-party.txt").write_text("".join(sections))
(destination / "inventory.json").write_text(json.dumps({
    "rustPackages": len(packages),
    "missingRustSources": missing,
    "scope": "Locked dependency sources currently installed; regenerate for additional targets."
}, indent=2) + "\n")
print(f"Collected notices in {destination.relative_to(root)}; missing Rust sources: {len(missing)}")
