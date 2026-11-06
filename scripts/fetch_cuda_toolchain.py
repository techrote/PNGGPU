#!/usr/bin/env python3
"""Fetch the minimal, SHA-pinned NVIDIA CUDA 12.8.1 compiler for CI.

This is a build dependency, not part of normal WebGPU setup. It installs no
driver and makes no system changes. Archives and licenses come from NVIDIA's
redistrib_12.8.1.json. End users may instead use the full NVIDIA CUDA Toolkit.
"""
import argparse
import hashlib
import pathlib
import platform
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile

BASE = "https://developer.download.nvidia.com/compute/cuda/redist/"
PACKAGES = {
    "linux-x86_64": [
        ("cuda_nvcc", "12.8.93", "9961b3484b6b71314063709a4f9529654f96782ad39e72bf1e00f070db8210d3"),
        ("cuda_cudart", "12.8.90", "8d566b5fe745c46842dc16945cf36686227536decd2302c372be86da37faca68"),
        ("cuda_cccl", "12.8.90", "0740e9e01e4f15e17c5ab8d68bba4f8ec0eb6b84edccba4ac45112d2d2174e4b"),
    ],
    "windows-x86_64": [
        ("cuda_nvcc", "12.8.93", "9fdc70b4271ed9aad4d64cd7076a7d96ec36512d074b9995fe638de669197391"),
        ("cuda_cudart", "12.8.90", "4a39058fd8519444a81cfc7ae055d136f48d1a31ffa41ae255b35b2edd61e13b"),
        ("cuda_cccl", "12.8.90", "bd8548fa1ae82f92910bebc3079e14bd58c5a92aa64596d46bd610a478cb39d7"),
    ],
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=pathlib.Path)
    args = parser.parse_args()
    if platform.machine().lower() not in ("amd64", "x86_64"):
        parser.error("This helper supplies x86-64 build tools only.")
    target = "windows-x86_64" if platform.system() == "Windows" else "linux-x86_64"
    if platform.system() not in ("Windows", "Linux"):
        parser.error("Use a Windows or Linux build host.")
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    cache = destination.parent / ".cuda-downloads"
    cache.mkdir(exist_ok=True)
    for package, version, expected in PACKAGES[target]:
        suffix = "zip" if target.startswith("windows") else "tar.xz"
        name = f"{package}-{target}-{version}-archive"
        archive = cache / f"{name}.{suffix}"
        cached_hash = None
        if archive.is_file():
            with archive.open("rb") as data:
                cached_hash = hashlib.file_digest(data, "sha256").hexdigest()
        if cached_hash != expected:
            url = f"{BASE}{package}/{target}/{archive.name}"
            print(f"Downloading {package} {version} ({target})", flush=True)
            partial = archive.with_name(archive.name + ".part")
            with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as output:
                shutil.copyfileobj(response, output)
            with partial.open("rb") as data:
                actual = hashlib.file_digest(data, "sha256").hexdigest()
            if actual != expected:
                partial.unlink()
                raise RuntimeError(f"SHA-256 mismatch for {archive.name}")
            partial.replace(archive)
        with tempfile.TemporaryDirectory(dir=cache) as temporary:
            expanded = pathlib.Path(temporary)
            if suffix == "zip":
                with zipfile.ZipFile(archive) as zipped:
                    # Even pinned archives must not extract outside staging.
                    for member in zipped.namelist():
                        if not (expanded / member).resolve().is_relative_to(expanded):
                            raise RuntimeError("Unsafe archive member")
                    zipped.extractall(expanded)
            else:
                with tarfile.open(archive) as compressed:
                    compressed.extractall(expanded, filter="data")
            source = expanded / name
            for item in source.iterdir():
                if item.name.lower().startswith(("license", "eula")):
                    license_dir = destination / "licenses" / package
                    license_dir.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(item, license_dir / item.name)
                elif item.is_dir():
                    shutil.copytree(item, destination / item.name, dirs_exist_ok=True)
                else:
                    shutil.copy2(item, destination / item.name)
        print(f"Verified and unpacked {package}", flush=True)
    # NVIDIA's redistributable uses lib/, while nvcc's Linux default profile
    # searches lib64/ in a combined toolkit tree.
    if target == "linux-x86_64" and not (destination / "lib64").exists():
        (destination / "lib64").symlink_to("lib", target_is_directory=True)
    print(f"CUDA compiler root: {destination}", flush=True)


if __name__ == "__main__":
    main()
