# GTX projection locality and continuously refilled queues — 4 November 2026

PR #2 remains draft. The native **2 GiB reserve**, accurate buffer admission,
depth one, bounded work/sublaunches, cancellation and watchdog protections remain
unchanged. No fault/pressure/stress runner, machine-setting change or privileged
performance-counter collection was used. Overall `qualificationAccepted:false`.

## Changes and projection profile

Fresh normal builds enable two internal, output-preserving optimizations:

* `PNGGPU_SAMPLE_MAJOR_MASKS=ON`: transpose the static host upload from
  `[glyph][sample]` to `[sample][glyph]`. Neighboring projection lanes now read
  neighboring glyph-mask values at each sample. GPU mask bytes, original host
  atlas/statistics, projection output layout and sample accumulation order are
  unchanged. The temporary host array is 27,904 bytes for this 218-glyph/32-sample
  atlas and survives until upload synchronization. Its one-time repack is
  included in cold `atlasUploadMs` and native initialization, not repeated warm.
* `PNGGPU_INTEGER_PROJECTION_SUMS=ON`: binary64 projection sums RGB8 channels as
  uint32, then converts those totals exactly before the original covariance
  expression. Validated samples/cell <=2048 imply totals <=522240. The original
  double sums, integer additions and conversions are therefore all exact.
  Products, dot accumulation and the objective remain binary64 with unchanged
  grouping. This affects direct FP64 and guarded recovery. Original host/CPU
  helpers retain their old implementation as the oracle.

The [selection experiment](GTX1650SUPER_SELECTION_PROFILE.md) is still controlled
by `PNGGPU_COLOR_MAJOR_FP32`: **ON is the original/default search**, OFF is the
experimental glyph-major stable-rank search. No candidate/tie/arithmetic-mode
default or workbench control was changed. WebGPU remains the application default;
selected CUDA still defaults to guarded binary64 recovery.

Complete CUPTI traces at 160x45, 10 frames/configuration, exclude frame 0:

| Controlled change | Projection kernel-interval median before / after |
|---|---:|
| FP32 glyph-major masks → sample-major masks | 3.512 / 0.403 ms |
| FP64 glyph-major masks → sample-major masks | 11.618 / 11.246 ms |
| FP64 double RGB totals → exact integer totals, sample-major masks | 12.631 / 8.721 ms |

FP32 mask-layout traces use source
`aa0fe810600b998b90c18e3581a20981440dfb42`; integer-total traces use
`2416cd632947848bfd8757e1bd76382c54ceef93`. Each pair has the same source and
explicitly different build controls. The mask-layout change gives about **8.7x**
lower traced FP32 projection time. In ordinary untraced queues, FP32 projection
medians fall 3.36→0.46, 6.23→0.91 and 11.41→1.77 ms at 160x45, 160x80 and
320x90 respectively. FP64 benefits mainly from removing redundant double adds:
final untraced projection medians improve about 20–22%, across all three sizes.
Traced FP32 workers use the experimental search consistently on both layouts;
the untraced mask-layout comparison uses the original search on both layouts.

This access pattern follows [NVIDIA's coalescing guidance](https://developer.nvidia.com/blog/unlock-gpu-performance-global-memory-access-in-cuda/).
No achieved bandwidth/cache counters or active-cycle/preemption measurements were
collected. Kernel lifetime includes scheduling effects. Function attributes show
zero local storage/spills for projection; registers/thread change FP32 45→48 and
FP64 47→48→52. Theoretical occupancy remains 1024 threads/SM and is not achieved
occupancy. Selection code/resource differences are separately identified.

All six accepted traces have exactly their expected kernel counts: 110 per FP32
trace, 160 per FP64 trace, **860 kernels / 60 frames** total. Two initial
background-only traces captured 77/110 and 144/160 kernels and are explicitly
**rejected**. Short bursts ended before their tail was flushed. Instrumented
workers now serialize background flushes with a flush before each completed tile
response. This is a no-op in normal builds; traced wall cost includes it and is
excluded from performance comparisons. Error/drop rows and expected counts are
checked. A killed bridge worker can still lack the orderly-exit footer.

## Continuously refilled depth-one results

All sessions use the first **30** saved parkour frames, 4x8 samples/cell and 6/5
foreground/background candidates. Inputs are read/hashed before the burst;
completed output arrays are retained and serialized to tuples/ANSI afterwards.
The next fit starts immediately after the preceding promise resolves. Exactly
one native worker/context/buffer set is retained, with at most one unresolved
frame and one tile in flight. Frame 0 includes initialization; statistics use
29 warm frames. Refill gaps describe fit-call submissions, not uninterrupted
kernel residency.

Final paired comparison at source `2416cd632947848bfd8757e1bd76382c54ceef93`:
each table entry is **median fit ms / whole warm-span frames per second**.
All columns use sample-major masks. Original FP32 search stays the default;
integer FP64 totals become the default after this experiment.

| Output characters / projection target | FP32 original search | FP32 experimental search | FP64 double totals | FP64 exact integer totals |
|---|---:|---:|---:|---:|
| 160x45 / 32 MiB | 19.08 / 51.45 | **17.25 / 54.86** | 37.00 / 25.56 | **34.77 / 28.08** |
| 160x80 letterboxed / 32 MiB | 32.24 / 29.02 | **29.30 / 33.11** | 61.56 / 15.93 | **58.76 / 17.00** |
| 320x90 / 64 MiB | 62.60 / 15.63 | **55.20 / 17.02** | 133.70 / 7.34 | **121.77 / 8.08** |

Warm FPS is `29 / (last completion − first warm submission)`, not the reciprocal
of median latency. Maximum refill gap over all ordinary comparisons is
0.0483 ms. No queue-depth increase or native sublaunch-limit change was made.

For the experimental FP32 search, fit p95 is 26.41 / 36.62 / 77.39 ms in the
table's geometry order. Corresponding counts above a nominal 33.33 ms conversion
budget are **0 / 5 / 29 of 29** warm frames. With integer FP64 totals, p95 is
45.07 / 65.45 / 140.40 ms, with **21 / 29 / 29** above that budget. These are
unpaced conversion durations, not actual presentation deadlines or dropped-frame
counts. Original FP32 at 160x45 has a lower p95 than the experimental search in
this run despite a slower median. A 30-fps live pipeline is not established.

Repeated observations remain important. An earlier integer-total letterbox run
regressed to 70.34 ms / 13.88 FPS versus the double-total control's 64.78 ms /
15.48 FPS, despite a faster projection stage. The final repeat reverses that
whole-frame result. All runs are retained; defaults follow the exactness and
repeatable kernel-stage improvement, not a claim that every frame/session wins.
These finite sequential measurements are not randomized confidence intervals or
a proof of globally optimal tile parameters.

The always-ready protocol matters substantially. Before changing projection,
the original worker already measured 22.83 ms / 42.40 FPS at 160x45 in the first
continuous run, versus roughly 80 ms median fit in the preceding diagnostic-gap
study. Input/output scheduling and inter-frame conditions differ; **do not label
that entire difference a native algorithm speedup**. Power/clocks/cache residency
and WDDM scheduling were not isolated. Algorithm comparisons above use the same
continuous protocol and same-source controls.

At 320x90, experimental FP32 projection/selection medians are 1.83/17.51 ms,
while whole-fit median is 55.20 ms and tile packing alone is about 11 ms. FP32
projection is now a small part of wall latency; packing, transport and selection
are the next useful targets. Timings overlap: GPU work is contained in bridge
round-trip time and must not be added to it again.

## Letterbox interpretation and measured costs

The crop outputs are 160x45 characters /1280x720 pixels and 320x90 /2560x1440.
They retain the previous 848x477 crop of the 854x480 source. Requested letterbox
comparison is **160x80 characters /1280x1280 pixels**, containing the original
854x480 aspect with black padding. Its regenerated 30 prepared RGBA hashes match
the preceding letterboxed preparation exactly. This is a comparison case, not a
change to the aspect-correct output policy.

Letterboxing has 77.8% more cells than 160x45 and roughly 44% padded area. In the
final fast-search/integer-total columns its whole-warm-span average time is about
1.66x/1.65x that of 160x45, or about 7% less time per cell. These ratios use the FPS/span
averages, not median fit times. Resampling/alignment, tile count and content
coverage change together, so this does not isolate a causal uniform-region
effect. Absolute latency still increases.

Post-burst tuple/ANSI/file/hash draining takes 34.36–58.84 ms total for the final
160-column sessions and 109–130 ms for 320x90. It is separately measured and
**excluded from the conversion queue throughput**. Preload/hash time is also
separate. Live decode/capture/resizing, paced arrivals, renderer/display latency,
frame age and drop policy are not measured. No preview's encoded playback rate
should be interpreted as processing speed.

There are **36 ordinary 30-frame sessions: 1,080 frames / 17,568,000 cells**.
All actual packed output spans and tuple/ANSI hashes match the prior same-mode,
same-geometry archive. FP32 and FP64 are not generally identical to each other.
CPU/WebGPU large conversions were not rerun. Previous comparisons remain in
[the cropped report](GTX1650SUPER_CROPPED_MOTION.md) and
[letterboxed report](GTX1650SUPER_MOTION.md).

Hardware is ordinal 0 GTX 1650 SUPER, capability 7.5, 20 SMs, watchdog enabled,
4,294,508,544 total bytes, driver 616.92; CUDA runtime 12.8, NVCC 12.8.93,
MSVC 19.44.35228.0, Node 24.21.0, Chrome 156.0.8078.80. Strict Release flags,
sm_75/compute_75 and candidate counts are retained. Maximum declared native
buffers are **77,051,120 bytes**; minimum before/after free-memory snapshot is
**3,441,950,720 bytes**. Mask transposition adds no GPU allocation. Admission's
**2,147,483,648-byte reserve** is unchanged. Peak continuous residency/driver
overhead is not measured. Cold atlas repack/upload spans range 0.87–3.60 ms.

The asynchronous monitor permits one PowerShell log query at a time, with a
250 ms delay after each query, 10-second query timeout and 12-second maximum
observation age. Its failure races the active fit and prevents subsequent
refills; cleanup cancels its active query. Maximum observed query duration is
1,245 ms. Detection latency includes query/poll duration; polling cannot promise
detecting an event before the immediately following frame. A fresh final query
after cleanup also checks the complete scope. No new driver warning/error,
frame/cleanup timeout or monitor failure was observed. Maximum ordinary
projection/selection sublaunch event intervals are 3.36/2.96 ms. This is not a
desktop-responsiveness, sustained-TDR or production-readiness qualification.

## Provenance and validation

[Summary](gtx1650super-projection-queue/summary.json),
[frame CSV](gtx1650super-projection-queue/frames.csv),
[accepted/rejected activity evidence](gtx1650super-projection-queue/activity-summary.json)
and [closeout](gtx1650super-projection-queue/closeout.json) preserve each source,
worker SHA-256/build control, prepared batch identity, raw-report hash, timing,
output hash, process/monitor checks and allocation. Activity CSVs are normalized
to LF; both raw and committed hashes are recorded. Raw JSON/packed output and
source-bound workers, SOURCE_COMMIT.txt, SHA receipts and licenses remain under
ignored `build/` directories. They are not carried by Git.

Final performance sources/worker SHA-256:

| Variant at `2416cd632947848bfd8757e1bd76382c54ceef93` | Worker SHA-256 |
|---|---|
| sample-major masks, original FP32, double FP64 totals | `947b1fcba2e6afcd20e7413aef9cb06a5571fd7c0629512b2992de80a356828e` |
| sample-major masks, original FP32, integer FP64 totals | `517b12ae447547550646bbe1e5d4b3f3df4505935eae27ecb7f29430bca0ccbe` |
| sample-major masks, experimental FP32, double FP64 totals | `da0bf279432f7a387b5287f3574246b2d28b513e64baa0279dd65c0de1999fda` |

[That implementation CI passed all three jobs](https://github.com/techrote/PNGGPU/actions/runs/41894216055).
Default promotion is `29eb443345c958ecacd2be537b1e40111eafadcd`, changing CMake
defaults only; [its CI also passed all three jobs](https://github.com/techrote/PNGGPU/actions/runs/41896282968).
Matching local default and streaming workers additionally passed bounded
two-frame FP32 queue smokes. The default worker matches the independent CPU
tuple/ANSI for the saved one-cell guarded and direct-FP64 regression. The saved
direct-FP32 counterexample still differs (CPU `[182,8,0]`, FP32 `[141,8,5]`);
it is recorded with explicitly permitted parity differences, not accepted as
CPU-exact. Documentation/evidence closeouts do not expand hardware test scope.

Local validation: **36,708 native checks**, 15 original application, 73 overlay,
59 bridge/planning/image/queue checks (including seven new queue/monitor tests),
seven host-only arithmetic CLI checks and both fixture regenerations. Native
tests compare every FP32 projection bit across layouts and every FP64 projection
bit across layouts/both RGB sum implementations, for glyph counts 1/7/31/32/33/218,
samples 1/2/32/64/512/2048
and three cells, plus the previous independent golden frames/tie regressions.
Independent review verifies numerical/bounds/cancellation behavior and the
evidence tables/hashes. No GPU sanitizer pass for these binaries is claimed.

## Reproduction

Use pinned setup/toolchain instructions, strict Release flags, and a current
source-matched normal worker with SHA receipt/licenses. Explicitly configure
`PNGGPU_SAMPLE_MAJOR_MASKS=ON -DPNGGPU_INTEGER_PROJECTION_SUMS=ON`, since existing
CMake caches retain older values. Set `PNGGPU_COLOR_MAJOR_FP32=ON` for the
original/default search or OFF for the experimental streaming comparison.
`--info` reports the actual layout/totals/traversal; do not infer them from the
latest defaults when reading historical receipts. Disable CUPTI for timings.

CPU/browser preparation, if the ignored prepared batches are absent:

```powershell
node scripts/prepare_cuda_video.mjs build/qualification-tools/node_modules/playwright/index.mjs benchmarking-material/agenticparkour 160 45 30 build/qualification/queue-crop160 crop-16:9
node scripts/prepare_cuda_video.mjs build/qualification-tools/node_modules/playwright/index.mjs benchmarking-material/agenticparkour 320 90 30 build/qualification/queue-crop320 crop-16:9
node scripts/prepare_cuda_video.mjs build/qualification-tools/node_modules/playwright/index.mjs benchmarking-material/agenticparkour 160 80 30 build/qualification/queue-letterbox160 contain-black
```

Run one finite configuration at a time, with a distinct output per invocation:

```powershell
node scripts/benchmark_cuda_video.mjs WORKER BATCH_DIRECTORY float32-direct 32 30 OUT.json --continuous
node scripts/benchmark_cuda_video.mjs WORKER BATCH_DIRECTORY binary64-direct 32 30 OUT.json --continuous
```

Use the corresponding prepared batch and 64 MiB for 320x90, 32 MiB for both
160-column cases. Continuous mode caps 2–30 frames, 128 MiB prepared input,
30 seconds/burst and 10 seconds/frame. Failure/staleness/driver errors stop the
scope. Omit `--continuous` to retain the preceding diagnostic-gap protocol;
do not pool the protocols' timing distributions. Previous batches used in the
recorded measurements are identified individually in the summary.

For independent traces, build separately with `PNGGPU_CUPTI_ACTIVITY=ON`,
matching CUPTI 12.8.90 via `CUPTI_ROOT`, its runtime DLL/library and license, and
set `PNGGPU_CUDA_ACTIVITY_DIRECTORY` to a fresh directory for one bounded run.
Unset it afterwards. Reject incomplete kernel counts or error/drop rows.
Archive SHA-256 is
`8a09eab5412addc6e132a55bac41ebad0141de3b5b6f6eca3028eb9e49a8cdb6`;
DLL identities are in receipts. No machine setting is needed for this activity
trace. Source-matched build controls and original masks/double sums permit
reproducing the controlled comparisons without resetting the active PR branch.

Remaining gates: packing/transport and selection costs; tile tuning under the
new continuous protocol; a paced bounded producer/consumer with frame-age/drop
and display metrics; GTX sanitizer and isolated sustained-watchdog qualification.
No higher CUDA queue depth, optimality or production-ready claim is made.
