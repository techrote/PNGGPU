# PNG2ANSI WebGPU GPU-007 — complete cumulative Windows installer

This release is cumulative and needs **no previous GPU package**. Extract the ZIP and double-click **start.bat**. If the original PNG2ANSI source is not already installed, setup downloads the pinned revision from GitHub once; after that it runs on localhost. `setup.bat` installs/updates, `start.bat` launches, `test.bat` tests. Python 3 or Node is needed only for the local HTTP server; Node/npm is needed for tests.

## GPU-007 features

- Pipeline depth options 1, 2, 3, 4, 6, **8**, 12, 16, **24** (host/readback pipelining; WebGPU shader queue is still ordered). Depth and actual GPU allocations are included in the VRAM preflight.
- Projection-buffer **tile target** dropdown: 4–1024 **MiB** (powers of two). Device storage bindings commonly clamp actual tiles below 128 MiB. The UI reports both requested and effective values.
- GPU-only output resolution up to **1024×1024 ANSI cells**; sample width **32**, height **64**. The original CPU reference retains its schema/work-unit guard.
- Very large sample lattices are streamed as bounded raster strips to avoid allocating gigabytes of RGBA sample images. Large source-crop resampling is experimental and **not yet pixel-parity qualified**; an unchanged full-canvas path is retained for modest images.
- Automatic (debounced) VRAM re-estimation as settings or source change. Standard WebGPU cannot measure physical/free VRAM. Manually enter 4 GiB (1650 SUPER), 24 GiB (RTX Titan), or your card's actual capacity. Warnings at capacity−4 GiB, hard block at capacity−2 GiB.
- Folder/multi-file image input: **Batch folder → ANSI ZIP** renders locally to `.ANS`, with optional timing CSV/JSON receipts and source-file error manifest. ANSI ZIP payload limited to 512 MiB to protect browser memory; break larger folders into subsets.
- All five original hardmode benchmark images, six-target ZIP sweep, profiler, CPU worker/reference, ANSI export and stage timestamps retained.

## Usage

1. Extract ZIP completely and double-click `start.bat`.
2. First run downloads the pinned upstream source once; no older GPU version is required.
3. Open `http://127.0.0.1:8000/experiments/webgpu/photographic.html` (normally opened by the launcher).
4. Enter actual GPU VRAM capacity and choose settings. VRAM estimate updates automatically.
5. To export whole folders, choose images using **Folder of images** or the multi-file fallback, choose **Include timing**, then **Batch folder → ANSI ZIP**.
6. For reproducible hardware timing, first run the prior known-good 512×512 / 16×32 / FG12 BG8 setup at depth 1/2/3, then explore depth 8 and 24 at a fixed tile MiB setting. Check memory warnings and exact parity on smaller compatible configurations before trusting new extreme paths.

**Validation status:** Host-side unit tests and ZIP consistency are verified; no real GPU-007 WebGPU shader/pipeline/sampling parity tests were possible in this build environment. The distribution is a *research build*, not a production-quality infinite-resolution converter. Do not interpret VRAM estimate as live GPU memory availability. Details: `PNG2ANSI/docs/WEBGPU_BENCHMARKS.md` after setup.
# Optional CUDA backend

For TITAN RTX / RTX 20-series, see
[the CUDA guide](overlay/docs/CUDA_BACKEND.md). Run `build-cuda.bat` once with
Visual Studio 2022 C++ tools, CMake and CUDA Toolkit installed, then
`start-cuda.bat`. CUDA uses the existing workbench and requires Node.js 22+.
Normal `start.bat` remains the default WebGPU entry point.
