# GTX 1650 SUPER selection profile — 4 November 2026

PR #2 remains draft. The 2 GiB native reserve, depth one, 1,024-cell selection
sublaunch cap and work limits are unchanged. No fault/pressure runner, machine
setting change or privileged counter collection was used.

## Result

An opt-in glyph-major FP32 candidate search improves the measured 160x45 median,
but regresses 320x90 medians. **Original color-major traversal stays the default**
(`PNGGPU_COLOR_MAJOR_FP32=ON`). Set it `OFF` explicitly for the experiment.
This is a build control for the normal worker; there is no new workbench toggle.

Same-source confirmation at `5de0fb39a53d8aa87472b6b9ee9c9b18e03826ae`, first
30 parkour frames per session, frame 0 excluded from warm statistics:

| Characters / tile | Search | Selection median ms | Fit median ms | Fit p95 ms |
|---|---|---:|---:|---:|
| 160x45 / 32 MiB | original | 53.60 | 80.23 | 105.48 |
| 160x45 / 32 MiB | glyph-major | 24.76 | 49.89 | 107.25 |
| 320x90 / 64 MiB | original | 35.69 | 92.86 | 238.41 |
| 320x90 / 64 MiB | glyph-major | 40.56 | 108.93 | 183.24 |

The 160x45 median fit improves 37.8%, while its p95 does not improve in this
repeat. At 320x90 the median worsens 17.3% despite a better tail. A separate
30-frame glyph-major 32 MiB run at 320x90 gives 40.65 ms selection / 110.27 ms
fit median, so the smaller tile does not resolve that regression.

The earlier full four-session candidate matrix at
`e985b7061b325b199586d9fc073fa9bef7dd7b4f` gives FP32/FP64 median fit
46.85/83.04 ms at 160x45, and 104.66/131.37 ms at 320x90. FP64 code is unchanged
and serves as a control; its timing also varies. These are finite sequential
experiments, not randomized confidence intervals or realtime certification.

## What the profile establishes

* A 30-frame CUPTI activity trace before traversal reordering captures all 330
  expected kernels. Selection's warm median is 54.67 ms by CUDA events and
  54.57 ms by summed kernel activity intervals. Thus host gaps between the event
  records are not the main explanation for those slow intervals. Kernel lifetime
  can include GPU scheduling/preemption; this is not a measurement of active
  instruction cycles or a proof that WDDM is irrelevant.
* FP32 and FP64 are different implementations and memory schedules, not merely
  identical instructions with a type substitution. FP32 first projects the HTTP
  tile; FP64 projects/selects in bounded recovery-storage chunks. Both do stable
  shortlist/color ranking and irregular candidate accesses. Scalar FP32 peak
  arithmetic throughput therefore does not predict end-to-end latency.
* Splitting direct FP32 from guarded selection reduces registers/thread from 95
  to 72 and local stack bytes/thread from 768 to 352. The seed-color hoist then
  computes the final winning seed once. Neither change produces a convincing
  standalone latency win in the four-session measurements.
* Glyph-major traversal loads one shortlisted glyph's statistics/projection
  before its color-pair loop. At the source level this changes those loads from
  960 to 32 per cell for 6x5 colors / 32 glyphs. Every error expression retains
  its original grouping. Equal errors choose the earliest original fi/bi/gi
  rank, including sentinel fallback. No candidate is removed. Compiled FP32
  register use falls further to 64; stack stays 352 bytes and reported register
  spills remain zero. The 160x45 gain supports pursuing access reuse, but no
  hardware memory/cache counters were collected to isolate its cause.
* Reducing selection blocks from 64 to 32 threads did not reliably help and was
  reverted. The measured device has 20 SMs, whereas a full bounded 64-thread
  selection launch has only 16 blocks. Theoretical occupancy is not achieved
  occupancy, and reducing a kernel's register footprint alone cannot guarantee
  faster execution of this small grid.

Ten-frame FP32 and FP64 traces of the later worker capture exactly 110 and 160
expected kernels respectively. They include eight easy warm frames and one
later frame, so their medians must not be compared with the 30-frame trace as
an optimization speedup. Full ordered activity records and per-frame event
comparisons are included. No dropped/error records were observed. Bridge workers
are terminated on close and can lack the orderly footer; completeness here is
checked by expected kernel counts. A separate ordinary one-cell EOF smoke on
the fixed tracer has two kernel records and `traceErrors=0`.

NVIDIA documents [NVCC resource reporting](https://docs.nvidia.com/cuda/archive/12.8.1/cuda-compiler-driver-nvcc/index.html#resource-usage-res-usage)
and the [CUPTI Activity API](https://docs.nvidia.com/cupti/12.8.1/api/group__CUPTI__ACTIVITY__API.html).
Local stack storage is not the same as register spilling. Activity tracing adds
overhead and is excluded from the comparison table.

## Evidence, identity and limits

There are 25 ordinary 30-frame sessions: 750 frames / 13,824,000 cells, plus 50
traced motion frames and separately bounded one-cell diagnostics. Every ordinary
frame's tuple **and ANSI hash** matches the prior same-mode cropped archive.
This checks preservation of optional FP32 behavior, not FP32/FP64 equality or
independent CPU acceptance. CPU and WebGPU conversions were not rerun. Their
prior comparisons remain in [the cropped report](GTX1650SUPER_CROPPED_MOTION.md).
Guarded one-cell saved-failure replays after split/seed changes retain exact
independent CPU tuples/ANSI. The guarded backend and original CPU objective
remain the defaults; `qualificationAccepted:false` remains explicit.

Actual GPU: ordinal 0, NVIDIA GeForce GTX 1650 SUPER, capability 7.5, 20 SMs,
4,294,508,544 total bytes, watchdog enabled, driver 616.92. CUDA runtime 12.8,
NVCC 12.8.93, MSVC 19.44.35228.0; strict Release arithmetic flags are preserved.
Maximum declared native buffers in these ordinary comparisons: 77,051,120
bytes; minimum before/after free-memory snapshot: 3,441,950,720 bytes.
These snapshots do not measure continuous residency or include all driver costs.
The 2,147,483,648-byte admission reserve was never reduced. No new System-log
NVIDIA/Display warning/error or 10-second frame timeout was observed; this is
not a sustained stability or desktop-responsiveness pass.

The source-bound confirmation workers are:

| Search | SHA-256 |
|---|---|
| glyph-major | `6cc6814cb8eee2389e1cdbde0785271d8ccc0cfde6e491941829ac297313dac2` |
| original | `8e4115007f36322ed76e6719cfd7ed12369a58b7ce97e669ba926e080909be7b` |

Both bind to full source `5de0fb39a53d8aa87472b6b9ee9c9b18e03826ae` with different
explicit build controls. Later default-policy/test/documentation commits are not
misrepresented as those measurement sources. Local binaries, SOURCE_COMMIT.txt,
SHA receipts and licenses remain under ignored build directories. Committed
[summary](gtx1650super-selection-profile/summary.json),
[frame CSV](gtx1650super-selection-profile/frames.csv),
[activity summary](gtx1650super-selection-profile/activity-summary.json), compiler
logs and worker receipts preserve individual identities, raw-report SHA-256,
allocations, timing distributions, driver checks and output hashes. Raw JSON
reports/packed outputs remain under `build/qualification/selection-*`.

Pinned local CUPTI 12.8.90 archive SHA-256:
`8a09eab5412addc6e132a55bac41ebad0141de3b5b6f6eca3028eb9e49a8cdb6`.
The DLL SHA is in its worker receipt. It was unpacked locally without installing
services or changing registry settings. The fixed optional tracer caps client
record buffers at 4 MiB and separately limits a host-pinned profiling pool;
buffer/error handling received independent read-only review.

## Reproduction and next gate

Use the pinned setup/toolchain instructions in the native README. Configure two
separate Release build directories with `PNGGPU_ENABLE_CUDA=ON`, architecture
75, `PNGGPU_CUDA_PROFILE=ON`, and explicitly
`PNGGPU_COLOR_MAJOR_FP32=ON` (original) or `OFF` (experiment). Bind each executable
to its exact source with SOURCE_COMMIT.txt / worker-sha256.json and preserve
licenses before using the acceptance scripts. Do not substitute the older
float32-only worker. The current native source must match the receipt.

For each worker, run one finite comparison at a time:

```powershell
node scripts/benchmark_cuda_video.mjs WORKER build/qualification/parkour-crop160 float32-direct 32 30 OUT.json
node scripts/benchmark_cuda_video.mjs WORKER build/qualification/parkour-crop320 float32-direct 64 30 OUT.json
node scripts/benchmark_cuda_video.mjs WORKER build/qualification/parkour-crop160 binary64-direct 32 30 OUT.json
```

The crop batches are local prepared artifacts from the prior report. Restore
them through its preparation workflow if absent; Git does not carry video/raw
RGBA or build directories. Choose a distinct OUT per invocation. Scripts retain
the same native worker/context/buffers, validate prepared source/frame hashes,
check driver logs around frames and stop on errors/timeouts. Diagnostic log
queries introduce inter-frame gaps. Fit includes packing/HTTP/CUDA/decode;
input read/hash and ANSI encoding are reported separately. These are warm-frame
latencies, not continuously replenished queue throughput or live capture/display
latency. No queue-depth increase was made.

Next: profile projection/access locality and test a finite continuously refilled
depth-one sequence with a separate bounded driver monitor. The optimized 160x45
median still exceeds a 33.3 ms 30-fps budget, tails remain variable, and 320x90
needs a different improvement. Wider stress/TDR/production claims remain gated
by the missing qualification described in WDDM_RESILIENCE.md.
