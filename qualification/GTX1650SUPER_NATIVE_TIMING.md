# GTX native fit boundary timing — 4 November 2026

PR #2 stays draft. The 2 GiB reserve, depth-one queue, bounded launches, watchdog
protections and default backends are unchanged. No kernel/transport/packing
rewrite, stress/fault test or machine-setting change occurred in this phase.

## Finding and next step

Exposing the existing worker `nativeTotalMs` was worthwhile. At 320x90 FP32,
**mean fit is 59.89 ms**, comprising 14.29 ms packing, 21.45 ms inside the native
fit interval, 22.14 ms in the bridge outside that native interval, and 2.01 ms
decoding/other frame work. Native fit itself contains 19.50 ms GPU projection
and selection, 0.93 ms transfers, and only 1.01 ms residual.

This supports prioritizing a layout-aware native input/packing path and fewer
frame-handling hops for FP32. It does **not** assign 22.14 ms to HTTP alone:
that bucket includes HTTP/client/server handling, process pipes, copies,
scheduling, and native work excluded by the fit timer. FP64 is more dominated
by GPU work; the same transport change has a smaller relative ceiling.

Recommended next experiment: expose the existing persistent binary worker
session through a direct client, compare identical packed buffers against HTTP,
then add row-major/stride-aware input and native packing as a separately measured
change. Retain JavaScript orchestration and the browser adapter. A native packer
is a strong target for the measured per-pixel loop; replacing the language alone
does not automatically remove copies and process-boundary costs. Shared memory
or an in-process interface should follow evidence from that direct-pipe test.

## What the new timing means

The worker already emitted `nativeTotalMs`. The browser adapter now validates
and preserves it on every tile and sums it per frame. Missing data stays `null`
if any tile lacks the field; measured zero remains zero. Explicit null,
negative, nonfinite or nonnumeric measurements are rejected with normal session
cleanup. Older protocol-v1 workers that omit the optional field remain usable.

The native interval starts **after** result-vector resize in `Worker::fit` and
covers upload, CUDA events/kernel execution/launch/synchronization, readback and
fit bookkeeping. It excludes INIT/atlas setup, frame reading, TILE parsing,
pre-timer result allocation, JSON/result serialization, pipe writes and optional
CUPTI flushes. Thus it is neither pure GPU time nor total native-process time.

For warm reused frames, `scripts/cuda_timing_breakdown.mjs` derives signed
residuals per frame before aggregation:

```text
native residual = nativeTotal − projection − selection − upload − readback
bridge remainder = bridgeRoundTrip − nativeTotal
other frame = fit − packing − bridgeRoundTrip − result decode
```

These are interval-accounting differences, not sampled CPU cycles or isolated
HTTP time. They retain their sign; no clamping conceals clock/interval effects.
Cold frames are excluded so atlas/INIT costs cannot be misattributed. Means of
the disjoint components add to mean fit; independently computed medians generally
do not. All per-frame closure errors are below 1e-8 ms.

## Six bounded depth-one reruns

First 30 parkour frames per configuration, 29 warm observations, same prepared
inputs, 4x8 samples/cell and 6/5 candidates as the preceding continuation.
FP32 uses the opt-in glyph-major search from the preceding 55 ms case; FP64
uses exact integer RGB totals. Both use sample-major device masks. There are no
algorithm or binary changes between this run and the preceding default/stream
build. Tiles are 32 MiB at 160 columns, 64 MiB at 320x90.

**Arithmetic means, milliseconds:**

| Characters / mode | Whole fit | Packing | Native fit total | Bridge outside native fit | Decode + other frame |
|---|---:|---:|---:|---:|---:|
| 160x45 FP32 | 18.04 | 3.47 | 6.01 | 7.71 | 0.85 |
| 160x45 FP64 | 36.20 | 3.35 | 24.78 | 7.17 | 0.90 |
| 160x80 letterboxed FP32 | 27.33 | 5.32 | 8.57 | 12.57 | 0.86 |
| 160x80 letterboxed FP64 | 55.37 | 3.46 | 39.08 | 12.18 | 0.64 |
| 320x90 FP32 | 59.89 | 14.29 | 21.45 | 22.14 | 2.01 |
| 320x90 FP64 | 124.03 | 9.81 | 92.22 | 20.54 | 1.46 |

Rounding can introduce 0.01 ms discrepancies in the table. Native residuals are
0.30/0.48, 0.52/0.72 and 1.01/1.48 ms for FP32/FP64 at the three geometries.
Even though 320x90 has 41 bounded projection/selection launches, the timed
native residual is small. This does not isolate scheduling effects within GPU
event intervals or measure parsing/serialization outside the native timer.

Packing plus the bridge remainder accounts for roughly **60–66% of mean FP32
fit time**. Native fit accounts for roughly **68–74% of mean FP64 fit time**.
The bridge remainder grows with geometry and is similar across precisions;
its HTTP/pipe/parser/serialization components still require the direct-path
experiment to separate. No claim of an entirely recoverable 22 ms is made.

Whole warm-span conversion rates:

| Characters | FP32 FPS | FP64 FPS |
|---|---:|---:|
| 160x45 | 55.40 | 27.61 |
| 160x80 letterboxed | 36.58 | 18.06 |
| 320x90 | 16.69 | 8.06 |

These are an instrumented rerun, not an optimization speedup. Packing and other
host timings vary between sessions. Conversion rates exclude preloading/hash
checks and post-burst tuple/ANSI/file draining. No live decode/display, paced
arrival, frame-age/drop or realtime-presentation claim is made.

## Evidence and constraints

**180 ordinary frames / 2,928,000 cells**, plus a two-frame startup smoke. Every
actual packed tuple span and ANSI hash matches the prior same-mode/geometry
archive. Large CPU/WebGPU conversions were not rerun; overall qualification
remains false. Processes exited, worker/context/buffers were reused, peak frame
and tile depth stayed one, and fresh post-cleanup driver checks remained clear.
No frame/cleanup timeout, monitor failure or new driver error was observed.

Actual device remains ordinal 0 GTX 1650 SUPER, capability 7.5, 20 SMs, watchdog
enabled, driver 616.92. Maximum declared native buffers: **77,051,120 bytes**;
minimum before/after free-memory snapshot: **3,441,950,720 bytes**. The native
**2,147,483,648-byte reserve** is intact. This does not measure continuous peak
residency or qualify sustained TDR/desktop stability.

Adapter/analysis source is `4009d0f7dc6ca91888fb855b9a57d5e358da12be`;
[its CI passed all three jobs](https://github.com/techrote/PNGGPU/actions/runs/41924101486).
There is no native-source change in this phase. The matching native worker
remains source `15f38f8f3acdbd34c6bbbd427df79adfd3d897f0`, SHA-256
`9d8d478abdf7e955fd4c552d6a03eb8955aea9ce30cb8fddba99777378d9904b`.
Its receipt records NVCC 12.8.93, MSVC 19.44.35228.0, strict Release/profile flags,
sample-major masks/integer totals ON, original-color search OFF, CUPTI OFF.
Native-source equivalence is checked before device discovery. SOURCE_COMMIT.txt,
SHA receipt, executable and licenses remain locally preserved under ignored
`build/projection-stream/`; Git does not transfer those build dependencies.

[Summary](gtx1650super-native-timing/summary.json) and
[frame CSV](gtx1650super-native-timing/frames.csv) preserve source/worker/batch
identities, raw-report and packed-output hashes, per-tile totals, per-frame
breakdowns/distributions and process/driver/admission checks. Raw JSON and actual
packed output remain under `build/qualification/native-total-matrix/`.
Local checks passed 15 original application, **76 overlay**, **63 bridge/planning/
image/queue/accounting** and **36,708 native host** checks, plus both golden
regenerations. New tests cover partial-tile/warm aggregation, missing/zero/mixed
and invalid timers, cold-frame exclusion and signed accounting. Independent
review checks interval semantics, all frame hashes and numerical tables.

## Reproduction

Use the pinned setup and matching normal worker from the preceding
[projection report](GTX1650SUPER_PROJECTION_QUEUE.md). Install the current overlay
adapter into PNG2ANSI; `scripts/setup.ps1` does this on a clean setup. Native
sources are unchanged, so a source-verified matching existing worker is usable.
For this exact configuration, sample-major masks and integer totals are ON,
`PNGGPU_COLOR_MAJOR_FP32=OFF` selects the experimental FP32 search, and tracing is
OFF. Driver monitoring, 2–30 frame cap, 128 MiB preload cap, 10-second frame and
30-second burst bounds remain unchanged.

Use a distinct OUT for each configuration and run one scope at a time:

```powershell
node scripts/benchmark_cuda_video.mjs WORKER build/qualification/parkour-crop160 float32-direct 32 30 OUT.json --continuous
node scripts/benchmark_cuda_video.mjs WORKER build/qualification/parkour-crop160 binary64-direct 32 30 OUT.json --continuous
node scripts/benchmark_cuda_video.mjs WORKER build/qualification/parkour-crop320 float32-direct 64 30 OUT.json --continuous
node scripts/benchmark_cuda_video.mjs WORKER build/qualification/parkour-crop320 binary64-direct 64 30 OUT.json --continuous
node scripts/benchmark_cuda_video.mjs WORKER build/qualification/parkour-queue160x80 float32-direct 32 30 OUT.json --continuous
node scripts/benchmark_cuda_video.mjs WORKER build/qualification/parkour-queue160x80 binary64-direct 32 30 OUT.json --continuous
```

Prepared batches are ignored local artifacts; reconstruct them with the previous
report's crop/contain-black preparation workflow if absent. For each warm raw
frame, import `warmTimingBreakdown(frame)` from
`scripts/cuda_timing_breakdown.mjs`. Require a measured `nativeTotalMs`; do not
substitute zero for null. Aggregate per-frame results with means for additive
budgets, and report median/p95 separately. Keep the original output comparisons
and native/bridge timer boundaries when assessing a future native packer.
