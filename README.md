# PNGGPU — WebGPU and optional CUDA

**Fidelity-first GPU-accelerated PNG2ANSI reconstruction research**, with WebGPU/WGSL as the default and an optional local CUDA backend targeting **TITAN RTX / RTX 20-series (Turing, compute capability 7.5)**.

The original [PNG2ANSI](https://github.com/techrote/PNG2ANSI) and [pyANSI](https://github.com/techrote/pyANSI) implementations remain independent CPU correctness references. This repository is the dedicated GPU development line.

## Windows installation

Clone this repository, or download its repository ZIP, and double-click **`start.bat`**. On first launch, `setup.bat` downloads the pinned original PNG2ANSI source from GitHub, applies the complete GPU-007 overlay, validates the five hardmode PNGs, and starts a localhost server. No earlier GPU releases are needed; the one-time upstream download needs internet access. `test.bat` runs the host-side test suite after installation. The workbench URL is `http://127.0.0.1:8000/experiments/webgpu/photographic.html`.

## GPU-007 features

- Photographic glyph matching in WGSL with CPU reference parity comparison and ANSI-byte output.
- Up to **1024 × 1024 ANSI cells** and **32 × 64 samples/cell** in GPU-only research mode.
- Tiled dispatch, requested projection tile sizes **4–1024 MiB**, and buffered tile execution depth **1–24**, subject to adapter limits and memory preflight.
- Explicit manually configured VRAM capacity estimates; WebGPU does not reliably reveal available physical VRAM. Warnings above VRAM−4 GiB; hard block above VRAM−2 GiB.
- Stage and tile instrumentation, benchmark ZIP exports, folder-to-ANSI-ZIP batch conversion with optional performance receipts.
- All **five original-byte hardmode images** and their SHA-256 manifest in `overlay/fixtures/hardmode/`.

## Optional CUDA backend

Install Node.js 22+, CMake 3.21+, Visual Studio 2022 C++ tools and an NVIDIA CUDA
Toolkit (CI baseline: 12.8.1), then run **`build-cuda.bat`**, followed by
**`start-cuda.bat`**. The workbench opens with CUDA selected; enter the selected
GPU's VRAM capacity (24 GiB for TITAN RTX), choose an image and run. WebGPU remains
available in the backend selector, and normal `start.bat` has no CUDA dependency.

The CUDA worker uses the same browser-prepared samples, glyph masks and ANSI
palette, then uses float32 projection, conservative decision certification and
binary64 GPU recovery for ambiguous cells. Fused multiply-add remains disabled.
It contains native `sm_75` code plus
`compute_75` PTX, selects the first compatible GPU (skipping older cards such as
V100), and supports explicit device selection. It reuses one tile-buffer set and
splits large tiles into bounded kernel launches. Actual CUDA pipeline depth is
one; WebGPU's 1–24 depth control is preserved separately.

CUDA reports device identity, full local-bridge/initialization overhead and
actual kernel timings. The existing CPU/ANSI comparison, hardmode benchmark,
ZIP exports and folder-batch paths work with the selected backend. **CUDA
hardware qualification remains incomplete.** Physical TITAN RTX tests pass the
five modest hardmode cases; historical float32 failures at 512×512 now have
precise GPU recovery and regression fixtures undergoing renewed qualification.
PR #2 remains draft. See the CUDA guide for the acceptance runner.
Host tests and compiler CI are not physical GPU acceptance.

See the [CUDA setup, usage and qualification guide](overlay/docs/CUDA_BACKEND.md)
and [native developer documentation](native/cuda/README.md).

## Repository layout

- `overlay/src/gpu/` — JS hosts, WGSL shaders, memory/tiling and benchmarking.
- `overlay/experiments/webgpu/photographic.html` — GPU-007 browser research workbench.
- `overlay/tests/` — host-side validation.
- `overlay/fixtures/hardmode/` — five original benchmark PNGs and manifest.
- `scripts/setup.ps1` — reproducible pinned upstream installation, with `setup.bat`, `start.bat`, and `test.bat` wrappers.
- `native/cuda/` — optional CUDA worker, host protocol/arithmetic tests and CMake build.
- `scripts/cuda_bridge.mjs` — explicitly enabled, same-origin loopback native bridge.
- `overlay/src/gpu/cuda.js` — browser CUDA adapter using the existing sample/ANSI contract.

## Qualification status

**Experimental.** Photographic parity has been observed on user hardware at multiple settings, including zero ANSI-byte mismatches in early GPU-001 runs; some high-load configurations have produced mismatches. **GPU-007's streaming high-resolution sampling path has not been fully demonstrated equivalent to the original full-raster preprocessing.** The benchmark results are research observations, not blanket correctness guarantees. Host-side tests do not substitute for physical GPU qualification. See `overlay/docs/WEBGPU_BENCHMARKS.md` and `overlay/docs/WEBGPU_RESEARCH.md`.

This project prioritises image reconstruction fidelity over raw conversion speed. The existing CPU application is not modified.

## Licensing

Original PNG2ANSI source is MIT licensed, with a separately licensed DejaVu Sans Mono font; both are obtained from the pinned upstream repository by the installer. The GPU code is in this repo. See the original upstream `LICENSE` and `assets/FONT-LICENSE.txt` after installation.
