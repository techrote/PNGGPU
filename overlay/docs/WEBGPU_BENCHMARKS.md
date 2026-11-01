# GPU-006 — Comparable performance, VRAM admission and tile profiling

## Context

The original GPU-002 workbench compared a full CPU `PNG2ANSI.convert()` (preprocess + fitting + ANSI + preview PNG) against *only* the GPU matching operation, including tile packing, upload and compact readback. This was not an apples-to-apples measurement. On user hardware (GTX 1650 SUPER) the GPU-002 page reported 49,365 ms CPU / 849 ms GPU for a 320×160, 16×16, FG8/BG8 frame, but that ratio was not a directly comparable end-to-end speedup. There were 9 ANSI-byte mismatches, a fidelity issue that remains visible and is not silently accepted.

## GPU-004 measurement contract

For a given image and profile, **one shared preparation pass** generates the exact same input pixels and low-resolution glyph masks for the CPU and GPU.

* `shared CPU preparation` measures config validation and decoding, existing DejaVu glyph-atlas creation (or cache lookup), and browser canvas resampling / RGBA8 readback. Each substage is reported independently; the sum is charged to *both* CPU and GPU effective one-frame totals, but preparation physically runs once. This is benchmark-neutral preprocessing; NL/Derez/tonal controls remain disabled in this experimental page.
* `CPU render` uses the original photographic matching algorithm extracted verbatim into `src/gpu/reference_photo.js`, executing in a module Web Worker so progress can be displayed during long fits. CPU fit wall time includes worker startup and structured-clone input transfer; the worker compute-only time and non-compute overhead are reported separately. The same prepared samples are used for both render paths. The original `src/core.js` remains completely unchanged. `tests/reference_photo.test.mjs` extracts the private original `photoFit` function in an isolated Node VM during *tests only* and requires bit-identical glyph/FG/BG arrays for several sample configurations.
* `GPU render` is the corresponding WebGPU `fit` call: CPU atlas statistics packing, temporary buffer allocation, tile packing, queue uploads, dispatch, GPU completion/mapAsync readback, and cell unpack. CPU allocations and transfers are not hidden or counted as free.
* `output` measures ANSI bytes and, in preview-enabled single-image mode, the same reference-shaped `renderCells` preview/PNG-generation function for both paths. Batch runs save CPU/GPU time by omitting previews for all but the final sample; per-result `outputKind` identifies this difference.
* `CPU total` = shared prep + CPU match + CPU output. `GPU total` = same shared prep + first GPU match + GPU output. Only these totals should be used as comparable single-conversion timings. First GPU device acquisition / shader compilation is reported separately (`pipelineInitMs`), excluded from warmed conversion totals. GPU repeat runs after the first are optional timing samples and excluded from the headline totals.
* `fit speedup` = CPU fit / first GPU fit, including GPU data movement. `total speedup` = full one-frame CPU total / GPU total. Missing CPU comparisons produce `null` for CPU timings and speedups, never zero.

The workbench measures host wall-clock with `performance.now()`. CPU-prep and final-output timing do **not** represent a future fully GPU-resident preprocessing pipeline.

## GPU diagnostics

`fit().stats` now includes:

- Host timings: atlas packing, allocation/setup, per-tile pixel repacking, queue.writeBuffer **CPU invocation time**, command encoding+submission, mapAsync wait, readback decoding, optional timestamp query retrieval, total wall.
- GPU pass times: sum of `project_glyphs` and `select_cells` in ms **only when `timestamp-query` is available and permission is granted**. WebGPU timestamps count nanoseconds and do not include host overhead or full GPU-side memory transfer; the browser may coarsen timestamps. When unavailable, the values are `null` with the reason stated. Readback wait includes GPU scheduling, dispatch and transfers, and **must not be added** to GPU timestamps as if stages were disjoint.
- GPU totals: allocated temporary buffer bytes (not proof of physical peak VRAM), data passed to writeBuffer, bytes mapped back, projection-buffer size, number/size of tiles and adapter info (when available).
- Workload proxies: cell count, glyph candidates, shortlist colour candidates, estimated RGB sample comparisons; rates are derived from those counts and the measured GPU-fit wall time and **are not hardware counters**.
- Optionally 2–10 GPU fits on the same input (first-run wall + median of all runs); repeats do not rerun CPU prep or CPU matching.

All values are saved to the per-image and five-image JSON report (`png2ansi-webgpu-benchmark-v2` / `png2ansi-webgpu-hardmode-v2`) in addition to being shown in an in-page table and a collapsible technical inspector.

## How to run useful tests

1. Start with 80×40, 4×8 samples and the parity-baseline preset. Verify 0 ANSI mismatches before trusting a performance result.
2. Run a 320×160, 16×16, FG8/BG8 test on your GTX 1650 SUPER with **GPU runs 1**. Record CPU prep, fit, output and GPU equivalents. Large CPU runs may take minutes; they execute in a dedicated module Web Worker, reporting completed-cell progress while the UI remains responsive.
3. Set **GPU runs 3** to estimate repeated-run variability without repeating CPU conversion. Leave `GPU shader timestamps` on when your browser supports them; compare on/off to quantify query overhead.
4. Vary `GPU tile target`: 2048, 8192, 16384. Compare `tilePackMs`, `encodeSubmitMs`, `readbackWaitMs`, shader pass times and tile count. If GPU shader times are small relative to wall time, prioritise tile/host scheduling, transfer and readback rather than WGSL arithmetic.
5. If ANSI mismatches are nonzero, record first-byte offset and glyph/foreground/background mismatch counts. Float32 tie changes are possible; matching visually is **not** the same as bit-identical parity.

## Compatibility and scope

This package remains a one-time-download installer for the pinned original PNG2ANSI source, plus a bundled cumulative GPU-004 overlay and all five original hardmode PNGs. The original CPU app retains its 125M work-unit ceiling; GPU research retains 125B. CPU industrial / NL filtering are unchanged and not represented as GPU implementations. Exact real-hardware GPU-004 shader timing support and parity must still be verified on the user's GPU/browser. No GitHub commits or branches are modified.

## GPU-004 live progress and version tolerance

- CPU progress is generated inside `reference_photo.worker.js` using the unchanged reference fitter's cell-based progress callback (throttled to ~125 ms). The UI is not blocked by the CPU glyph-fitting loop. A final completed-cell event follows the actual completed result.
- GPU progress comes from `PhotographicWebGpuFitter.fit(onProgress)` after each tile's results have completed GPU execution and been mapped and decoded on the CPU. A submitted dispatch is **not** counted as completed. No ETA is manufactured before any cells are complete.
- Each progress bar reports actual completed cells, percentage, elapsed time, average cells/s, approximate remaining time, and an **estimated** algorithmic work-unit rate. These rates reflect observed wall time and are not CPU/GPU hardware counters or measured instruction throughput.
- The profiler accepts absent `gpuStats.timing` fields (as may occur with stale modules or older backends); it reports missing data as unavailable without throwing away completed results. Versioned `?gpu004` module URLs and `Cache-Control: no-store` reduce cross-version mixing.
- Existing 320×160/16×16/FG8/BG8 near-parity observations (9 mismatching ANSI bytes) remain unresolved; no parity change is claimed by these instrumentation changes.

## GPU-006: VRAM admission policy

Standard WebGPU **does not expose reliable dedicated physical VRAM capacity or free VRAM**. Enter the installed card capacity manually (4 GiB for GTX 1650 SUPER; 24 GiB for RTX Titan). The value is persisted locally in the browser for convenience. Selecting a capacity is required before running GPU work or benchmarking. Do not infer VRAM from `GPUAdapterInfo` strings, `navigator.deviceMemory`, or WebGPU `maxBufferSize`.

The **Estimate VRAM** action does a non-rendering preflight: decodes enough of the source to know dimensions, generates/reuses the glyph atlas, creates the WebGPU device/shaders, computes the bounded physical tile plan, and estimates the peak workbench allocation. It does **not** run the CPU matcher or dispatch a glyph-fitting job.

The estimate comprises all simultaneously resident buffers created by `PhotographicWebGpuFitter.fit`, including per-tile raster/projection/output/readback and optional timestamp queries (allocated once and reused across tiles); a **conservative estimate** for browser-backed source/sampling/preview images; and a further uncertainty allowance of at least 64 MiB or 25% of the other accounted bytes. The estimator cannot see hidden driver caches, desktop compositor allocations, other programs, GPU memory fragmentation or actual residency. Being under the limit does not guarantee successful allocation.

Admission is **hard-blocked** when the estimated working set exceeds manually declared VRAM **minus 2 GiB**. No override. Between the warning threshold (**VRAM minus 4 GiB**) and the hard limit, running requires explicit user confirmation. At exactly **4 GiB**, the warning threshold is zero, so **every positive workload requires confirmation**. A five-image hardmode suite requests one confirmation for the worst-case estimate, then checks each image again before executing it. CPU benchmark selection is now off by default; the original CPU app's 125M work-unit guard remains unchanged, and an explicit CPU reference comparison can still use the original photographic algorithm.

## GPU-006: larger tile-target experiments

The UI accepts **1–262,144 requested cells/tile**. Unlike earlier versions, the projection shader supports a 2-D workgroup dispatch. This lifts the previous one-dimensional 65,535-workgroup ceiling but **does not circumvent a GPU's maximum storage-buffer binding size or maximum buffer size**. With 219 glyphs and a typical 128 MiB storage binding maximum, the projection buffer still caps the effective tile at roughly **38,000 cells**. The workbench and JSON report distinguish requested target from effective tile, tile count, projection buffer bytes, actual dispatch X/Y, and device limits. A requested 262,144 tile does **not** imply that many cells occupy one dispatch.

## GPU-006: per-tile profiling

The GPU fitter additionally records an entry for every completed tile, with actual cells, tile wall time, CPU tile packing, `queue.writeBuffer` enqueue time, command encoding/submission time, GPU completion-and-readback wait, and decoded-cell time. When timestamp queries are supported, each tile also receives GPU-only projection/selection times. The inspector reports first/last tile times (useful for warm-up/clocks), per-tile median/p95/max, average tile time per cell, and per-stage medians; JSON stores the raw per-tile values. Repeated GPU-fit times display first-versus-later median, to help distinguish cold-clock behaviour from tile scheduling.

These are **host wall-clock stage timings and GPU timestamps**, not direct PCIe bandwidth, GPU occupancy, temperature, power, clock speed, VRAM utilisation or hardware counters. `readback.mapAsync` includes queue waits and computation. GPU timestamps are *not additive* to those waits. If the browser disables `timestamp-query`, shader durations are unavailable rather than fabricated.

For fair comparisons, warm the GPU with 2–3 runs before judging a steady-state rate. Keep image, terminal dimensions, sampling, palette candidates, and device fixed while changing only tile target. Export the JSON for exact tile plans, memory assumptions and raw durations. The GPU-006 shader uses equivalent mathematical scoring, but changing 1-D to 2-D dispatch must still undergo real-GPU parity validation; device execution and Windows launch have not been hardware-tested in this environment.

## GPU-006: power-of-two tiles, benchmarks to ZIP and buffered pipeline

- **Tile target** is a discrete power-of-two dropdown: 1K through 256K cells. Effective tile size is still clamped by the device's storage-buffer and dispatch limits. For 219 glyphs and a 128 MiB maximum storage binding, approximately 38K cells remains the effective maximum, even if the dropdown selects 65K–256K.
- **Recommended tile-sweep presets** reproduce the 256×256 output, 16×32 samples, 12 FG × 8 BG palette, five GPU repetitions, and tile targets 8K/16K/32K/64K/128K/256K. A 128×128 short-job preset investigates clock-ramping effects. CPU comparison stays opt-in.
- **Run benchmarks → ZIP** evaluates all five user-provided hardmode images with either the currently selected tile size or all six tile targets. The archive stores `results.csv`, `repeats.csv`, `tiles.csv`, `manifest.json`, `README.txt` and a complete per-case JSON in `runs/`. Those JSON reports include every GPU repetition's raw per-tile timing records. Failures are recorded instead of silently discarded, and a requested stop produces a partial archive. The ZIP is written with an offline, dependency-free ZIP32/STORE builder.
- **Tile pipeline depth** (1/2/3 slots): one reusable input/raster/projection/selection/readback buffer set per in-flight slot, each with independent bindings. With depth > 1, subsequent tiles can be submitted while earlier `mapAsync` readbacks are pending. Each slot is reused only after its own readback completes. All completed output is written by original tile index.
- WebGPU guarantees an ordered queue, *not simultaneous execution of independent tile compute shaders*. The method reduces host-induced gaps and permits data transfer/readback overlap where drivers allow. Depth 1 preserves the historical serial baseline. Benchmark both 1 and 2/3 to determine the gain; aggressive pipelining can sometimes regress due to higher buffer residency or contention.
- The VRAM estimator includes **all simultaneously allocated pipeline slots** before any job is admitted. A depth increase can cross the existing warning/hard-block threshold; the application never bypasses it. The batch ZIP preflights the worst combination and asks for one approval if needed.
- Shader equations, glyph masks, shortlist, palette candidates and ANSI encoding are unchanged. The new batching must undergo real-device parity checks before performance improvements can be called accepted. Unit tests exercise out-of-order tile readback, correct cell ordering, VRAM scaling, ZIP integrity and preset contracts.

## GPU-007 extended research controls

- **Tile target** is the projection buffer target in **MiB** (binary MB). 4, 8, 16, 32, 64, 128, 256, 512 and 1024 MiB can be requested. WebGPU usually caps a single storage binding at 128 MiB, so 256–1024 MiB requests often resolve to the same effective tile size. Raster buffer size can clamp earlier when sample density is high. Always compare **actual** tileCells / effectiveProjectionMiB.
- **Pipeline depth**: 1, 2, 3, 4, 6, 8, 12, 16, 24. This means separately allocated per-slot input, projection and readback buffers. The WebGPU submission queue remains ordered; deeper buffering overlaps host prep and readback, not concurrent shader kernels. The manual-VRAM memory gate includes every slot.
- **VRAM estimator** is automatically refreshed after changing parameters, source file or declared GPU capacity. When no file is selected, its source dimensions are provisional. It is an allocation estimate, not true free VRAM telemetry. Warning > capacity–4 GiB, hard block > capacity–2 GiB. On a 4 GiB GPU all nonzero workloads warn.
- **GPU-only extended schema**: 1024×1024 terminal cells, up to 32×64 samples. The original CPU schema/125M work-unit guard is not changed. GPU work-unit reporting supports safe-integer values, but a VRAM pass does **not** imply a reasonable completion time. Very large jobs can run for minutes/hours.
- **Streamed raster**: above 256 MiB or >16,384 pixels along either sample dimension, CPU prepares image data in bounded strips per tile instead of allocating an enormous full RGBA array. The GPU render wall time includes this streamed host sampling, measured separately as `sampleProviderMs` / `sourceSampleMs`. Larger-than-16,384 sample dimensions use a cropped-source resampling path **not yet qualified for pixel-exact equivalence** with the full-frame browser Canvas2D reference. The full photographic matching shader remains unchanged.
- **Preview limit**: when a reconstructed PNG preview would exceed 16,777,216 pixels, the workbench emits ANSI without allocating that PNG.
- **Folder batch**: choose a folder via `webkitdirectory` or select multiple files as fallback. The result is a locally built ZIP with `ansi/` entries, manifest and optional timing CSV/JSON. Source files never leave the browser. Output packaging is capped at 512 MiB per ZIP to protect browser memory; split large batches into smaller folders. Per-source errors and partial stops are recorded.

**Known unknowns:** hardware performance and parity for depth 8/24 and streamed high-resolution sampling require GPU-007 validation; earlier exact parity at small grids does not prove these new paths.
