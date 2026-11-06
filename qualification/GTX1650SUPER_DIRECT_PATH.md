# GTX direct pipes and native packing — 4 November 2026

PR #2 remains draft. The native 2 GiB free-memory reserve, truthful capacity,
depth-one queue and bounded kernel launches remain intact. No stress/fault test,
watchdog bypass, sanitizer prerequisite or machine-setting change occurred.

## Result

The private direct-pipe prototype improves warm-frame conversion latency across
all three geometries and both arithmetic modes. At 320x90 FP32, removing HTTP
with **identical already-packed inputs** raises conversion throughput from
24.0 to 38.1 FPS. With packing inside the timed frame, the matched-allocation
HTTP/direct-JS/native-packing arms measure **18.1 / 29.2 / 34.8 FPS**. A subsequent
cache-blocked native gather measures **36.6 FPS**, 27.30 ms mean fit and 31.71 ms
p95. One of its 29 warm frames takes 35.34 ms, exceeding a 30 FPS frame budget.
This does not establish imperceptible lag or a live video pipeline.

Direct transport is the larger measured improvement. Moving per-pixel gathering
to C++ adds an incremental improvement; JavaScript still performs bulk row copies
and orchestration. Pipes, copies, serialization and scheduling remain. The data
support improving representation and boundaries, rather than attributing the
whole gain to a programming language.

## Controlled transport comparison

First 30 prepared parkour frames per run; frame 0 initializes the retained worker,
context, atlas and buffers. FPS uses the complete span of frames 1–29, including
refill gaps. The producer is continuously refilled at depth one, with no paced
arrival model. Canonical command-2 packets are prepared before the timed burst.
Every HTTP/direct pair uses the same worker binary, INIT bytes, complete input
packet hash list and digest, RGBA frame hashes and settings. Prepacking cost is
excluded here; this isolates the transport path with already-packed inputs.

| Characters | Mode | HTTP FPS | Direct-pipe FPS |
|---|---|---:|---:|
| 160x45 | FP32 | 74.61 | 121.82 |
| 160x45 | FP64 | 29.39 | 36.91 |
| 160x80 letterboxed | FP32 | 44.31 | 81.55 |
| 160x80 letterboxed | FP64 | 19.34 | 22.96 |
| 320x90 | FP32 | 24.01 | 38.11 |
| 320x90 | FP64 | 8.81 | 10.06 |

The direct path skips sockets, HTTP parsing and Response objects. It shares the
same bounded native framing/session implementation with the HTTP bridge. This
is an observed route comparison, not a measurement of HTTP parsing alone: host
scheduling, allocator/JIT state and copies can vary too. Route order is reversed
for letterboxed runs. There is one short sequence per arm, without confidence
intervals or a claim of globally optimal parameters.

## Live packing comparison

All three arms allocate and retain one packet set per frame, using the same
optional packet-provider hook. HTTP and direct-JS use the exact original JS
per-pixel encoder; their INIT and packed input hashes match. `--live-pack` is
explicit for both, avoiding comparison of HTTP's default reusable buffer with a
retaining direct prototype. Original browser allocation behavior is unchanged.

Native packing instead bulk-copies compact RGBA row bands in JS; command 3 then
validates, allocates and gathers canonical cell-major RGB words in C++. Alpha is
ignored exactly as before. The pixel payload size stays constant; each tile has
12 extra header bytes. Independent host tests check canonical words, byte-offset/
stride inputs, partial cell rows, varied sample shapes and malformed bounds.
Native packets have a deliberately different layout/hash from command 2.

**Whole warm-span conversion FPS:**

| Characters | Mode | HTTP + JS | Direct + JS | Direct + initial native | Direct + blocked native* |
|---|---|---:|---:|---:|---:|
| 160x45 | FP32 | 60.47 | 97.48 | 112.14 | 120.03 |
| 160x45 | FP64 | 27.40 | 33.29 | 35.66 | 37.13 |
| 160x80 letterboxed | FP32 | 38.55 | 70.21 | 74.87 | 78.27 |
| 160x80 letterboxed | FP64 | 18.34 | 21.33 | 21.96 | 22.98 |
| 320x90 | FP32 | 18.08 | 29.22 | 34.85 | 36.61 |
| 320x90 | FP64 | 8.11 | 9.38 | 9.75 | 9.95 |

*Blocked-native is a separate follow-up phase/source, not a fourth arm with the
same binary. Only its validated host gather changed; kernels, inputs and output
hashes stayed identical. The first three arms share one binary. Compared with
that first native phase, blocks spanning approximately 4 KiB of output improve
gather locality and remove repeated per-word checked-reader calls after full
extent validation. Mean native gather at 320x90 falls from 3.99 to 2.11 ms FP32
and 3.92 to 1.94 ms FP64. Small sequence variance remains a confound in total fit.

## Separately measured packing and remaining costs

Arithmetic means in milliseconds for the **blocked native phase**. JS packet
means include bulk row copying/allocation; native gather includes validation,
allocation and conversion. It is timed before `Worker::fit`, so it is excluded
from `nativeTotalMs` and already included in the bridge interval. The table
subtracts it from the bridge remainder once, avoiding double counting.

| Characters / mode | Whole fit | JS packet | Native gather | Native fit | Remaining bridge | Decode + other |
|---|---:|---:|---:|---:|---:|---:|
| 160x45 FP32 | 8.32 | 0.37 | 0.44 | 5.59 | 1.37 | 0.55 |
| 160x45 FP64 | 26.93 | 0.32 | 0.37 | 24.31 | 1.27 | 0.65 |
| 160x80 FP32 | 12.77 | 0.60 | 0.95 | 8.00 | 2.33 | 0.89 |
| 160x80 FP64 | 43.50 | 0.59 | 0.87 | 38.99 | 2.24 | 0.80 |
| 320x90 FP32 | 27.30 | 1.13 | 2.11 | 18.72 | 4.37 | 0.97 |
| 320x90 FP64 | 100.49 | 1.14 | 1.94 | 92.07 | 4.43 | 0.91 |

Native fit includes GPU projection/selection, transfers, waits/launch and fit
bookkeeping; it excludes packet parsing, pre-timer result allocation, response
serialization and pipe writes. Remaining bridge is a signed elapsed-interval
residual, not pure HTTP/JS time. Command-2 `nativePackingMs:0` denotes no raster
gather, not zero legacy parsing cost. Independent bucket medians do not add;
means do, to <1e-8 ms per frame. Raw per-frame components are in `frames.csv`.

At 320x90 FP32, native fit is 18.72 ms: projection 1.63, selection 15.22, transfers
0.86 and native residual 1.02 ms. Selection remains the largest single stage;
4.37 ms remains outside native fit/gather in the pipe/response/host interval.
FP64 native fit is 92.07 ms and dominates its 100.49 ms whole frame.

**Final warm frame variation (29 observations):**

| Characters / mode | Mean ms | Median ms | p95 ms | Max ms | Frames over 33.33 ms |
|---|---:|---:|---:|---:|---:|
| 160x45 FP32 | 8.32 | 8.41 | 10.13 | 10.18 | 0/29 |
| 160x45 FP64 | 26.93 | 25.95 | 31.38 | 31.39 | 0/29 |
| 160x80 FP32 | 12.77 | 12.61 | 15.64 | 15.73 | 0/29 |
| 160x80 FP64 | 43.50 | 43.03 | 52.05 | 53.05 | 29/29 |
| 320x90 FP32 | 27.30 | 26.54 | 31.71 | 35.34 | 1/29 |
| 320x90 FP64 | 100.49 | 99.86 | 105.71 | 114.37 | 29/29 |

p95 is the nearest-rank statistic. No live decoding/resampling, ANSI serialization,
file draining, display/vsync, network input or dropped-frame policy is included
in fit/FPS. Prepared raw frames are preloaded/hashed before the burst; output
hashing and ANSI generation are after it. Native packing is inside fit in live
arms. Different live JS packing times across routes expose JIT/scheduling noise;
they must not be assigned entirely to transport or native-language speedup.

## Bounds, device and output checks

GTX 1650 SUPER ordinal 0, CC 7.5, 20 SMs, 4,294,508,544 total bytes; driver 616.92,
CUDA runtime 12.8 (driver API 13.4), NVCC 12.8.93 / MSVC 19.44.35228.0, Node 24.21.
Minimum pre/post free snapshot is 3,441,950,720 bytes. These snapshots do not
measure instantaneous peak VRAM. Declared native buffers are 33,325,472 bytes
(160x45, 32 MiB projection tile), 42,111,280 (160x80, 32 MiB) and 77,051,120
(320x90, 64 MiB). The existing free-memory hard gate still reserves 2,147,483,648
bytes. No capacity/reserve limit was lowered or inferred from nominal card size.

The maximum declared retained parent raw+packet+session-payload storage is
223,647,800 bytes, below the 256 MiB cap; it is not total process RSS. Raw preload
is capped at 128 MiB, work at 30 frames/session with 10 s/frame and 30 s/burst.
Kernel work/sublaunch limits and one active request remain. Driver-log monitoring
and fresh post-cleanup queries found no new errors; all tracked children exited.
These observations do not establish desktop responsiveness or sustained stability.

The 36 sessions contain **1,080 ordinary frames / 17,568,000 cells**. All actual
packed output spans and independently re-encoded original-core ANSI bytes match
prior same-mode/geometry archives. CPU and WebGPU motion conversions were not
rerun: this establishes transport/packing equivalence, not CPU parity or a new
CUDA-over-WebGPU comparison. Precision modes are not interchangeable: the
one-cell precision/shortlist counterexamples still differ in FP32. The bounded
one-cell smoke confirms command-2/3 equality in guarded/FP64/FP32 and independent
CPU equality in guarded/FP64. No benchmark cell uses guarded recovery; these are
explicit direct modes, with recovery count zero. Joint qualification stays false.

160x45 and 320x90 use an 848x477 crop from the 854x480 source, matching 16:9
character rendering. 160x80 retains the earlier black-letterbox preparation.
All use 4x8 samples/cell, a 32-glyph shortlist and 6 foreground/5 background
candidates. The experimental glyph-major FP32 build is used consistently;
original color-major FP32 remains the build default. WebGPU remains the app
default and guarded CUDA remains the default arithmetic mode.

## Source, worker and checks

| Phase | Runner source | Native worker source | Worker SHA-256 |
|---|---|---|---|
| packed | `47e3aa05595fd52e9c7b2e0a132f0c1ae48ae265` | `15f38f8f3acdbd34c6bbbd427df79adfd3d897f0` | `9d8d478abdf7e955fd4c552d6a03eb8955aea9ce30cb8fddba99777378d9904b` |
| live | `fd620bad94796cb40154d8e572a1b3d260a11b68` | `d135f6d0127f0921bfbb2ddd5821435ae7c5a6cc` | `001d8ce51bdfde775cc5ff87b40bca660a3d6e8dcd8196326389a2441950b90f` |
| blocked | `c06ed8ac5a3409b40472555dda5c92be3282e6e4` | `c06ed8ac5a3409b40472555dda5c92be3282e6e4` | `9724dcdd33594ece5f41cdc8fb5695d86fe0c2b7d80913003a5d37c32e58bad7` |

Exact-source [c06ed8a CI](https://github.com/techrote/PNGGPU/actions/runs/41931125685)
passed all three jobs: Windows host/application checks and Windows/Linux CUDA
build/native checks. Local validation passes 15 original tests, 78 overlay tests,
79 bridge/direct/raster/planning/accounting tests, **37,032 base native host
checks / 37,092 with both golden fixture sets**, 7 host-only arithmetic CLI
checks, independent CPU golden and frozen FP32 seed regeneration. The separate
golden-inclusive native log uses the same fixture arguments as CTest. CI is
compile/host evidence, not a GPU run.
Independent read-only review found no supported bounds/ownership/packing issue
and separately verified all recorded tuple/ANSI archives and input controls.

[summary.json](gtx1650super-direct-path/summary.json) preserves source/worker/device
identities, raw receipt hashes, complete packet hashes, metrics, limits and
process/monitor evidence; [frames.csv](gtx1650super-direct-path/frames.csv) records
per-frame timing and output hashes. One-cell smoke, host/build logs and original
worker SOURCE_COMMIT/worker-sha256 receipts accompany them. Worker executables,
licenses and full raw JSON/binary outputs remain in ignored local `build/`
directories; Git does not carry those artifacts. Compiler switches retain strict
arithmetic, sm_75 + compute_75 PTX, profile ON, sample-major masks/integer RGB
sums ON, color-major FP32 OFF, CUPTI OFF, fault worker OFF.

## Reproduction

Run setup, install the pinned toolchain, then build a normal source-matched worker
with the switches above. Preserve its SOURCE_COMMIT.txt, worker-sha256.json and
NVIDIA licenses. Current normal worker is `build/direct-native/`; initial native
worker is preserved in `build/direct-native-d135/`, historical transport worker
in `build/projection-stream/`. Do not relabel a historical executable with a new
source revision. After native source changes, rebuild before running: provenance
validation rejects mismatched native trees.

The user-supplied frames remain in `benchmarking-material/agenticparkour`.
Preparation directories are `parkour-crop160`, `parkour-crop320`, and
`parkour-queue160x80` under `build/qualification/`. Reconstruct those from the
original inputs if missing; hashes are checked before any measured work.

Example for one bounded 30-frame arm (use a fresh output filename per arm):

```powershell
node scripts/benchmark_cuda_video.mjs build/direct-native/pnggpu_cuda_worker.exe build/qualification/parkour-crop160 float32-direct 32 30 build/qualification/example.json --continuous --prepacked --direct
```

For transport A/B, run with/without `--direct`, keeping `--prepacked`. For live
JS controls, replace `--prepacked` with `--live-pack` on both routes. For native
packing, use `--direct --native-pack`. Substitute `binary64-direct` for FP64;
use crop320/64 MiB for 320x90 and queue160x80/32 MiB for letterboxing. Keep tests
sequential, retain driver monitoring, and stop on timeout/stall/driver errors.
This command does not authorize longer or stress runs.

Offline audit (no worker/GPU invocation):

```powershell
node scripts/summarize_cuda_direct_bench.mjs build/qualification/direct-transport-ab build/qualification/native-packing-matrix build/qualification/native-packing-blocked qualification/gtx1650super-direct-path
```

Next useful work is response-side copying/serialization and live input integration,
with explicit decode/display latency accounting. A shared-memory or in-process
interface may remove more copies, but the current measured residual sets a
smaller ceiling than the original HTTP path. Sustained watchdog qualification,
sanitizer coverage for the new gather and production realtime behavior remain
unestablished. Prior TITAN sanitizer/stability evidence does not transfer here.
