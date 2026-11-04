# GTX 1650 SUPER: retained CUDA worker and warm frames

Recorded 4 November 2026. **The worker, context, atlas and native buffers now
persist across explicitly submitted frames.** The ordinary one-image `fit()` API
and default WebGPU/guarded-CUDA behavior are unchanged. PR #2 stays draft; the
native 2 GiB admission reserve and display protections are unchanged.

## Measured still-image baseline

Eight finite sessions completed: FP32/direct FP64 x 160x80/320x160 characters x
16/32 MiB projection targets. Each session submits the same ordered five original
real images followed by the first image again: one cold frame and five warm
frames, **48 frames / 1,536,000 cells total**. All use 4x8 samples, 218 glyphs,
32-glyph shortlist, six/five candidates and effective depth one. No native buffer
allocation or atlas upload occurs between successful frames. Output arrays remain
independently owned; one host upload buffer is reused. Concurrent refill is
rejected, providing caller backpressure rather than accumulating a queue.

| Characters | Tile | Precision | First frame ms | Warm median ms | Warm range ms | Warm kernel median ms |
|---|---:|---|---:|---:|---:|---:|
| 160x80 | 16 MiB | FP32 | 230.20 | 43.46 | 40.15–54.61 | 20.23 |
| 160x80 | 16 MiB | FP64 | 251.15 | 78.66 | 75.51–84.61 | 55.90 |
| 160x80 | 32 MiB | FP32 | 215.21 | 41.36 | 38.49–49.11 | 20.40 |
| 160x80 | 32 MiB | FP64 | 258.79 | 76.68 | 70.12–81.53 | 55.00 |
| 320x160 | 16 MiB | FP32 | 355.43 | 150.48 | 145.72–182.05 | 80.36 |
| 320x160 | 16 MiB | FP64 | 454.84 | 249.37 | 235.02–254.91 | 178.42 |
| 320x160 | 32 MiB | FP32 | 384.74 | 143.07 | 131.22–151.13 | 80.20 |
| 320x160 | 32 MiB | FP64 | 436.01 | 240.03 | 231.81–253.21 | 177.80 |

Frame wall includes packing, HTTP/native framing, upload, kernels, synchronization,
readback and result decoding. The first frame additionally includes native
initialization (154.48–187.58 ms here); warm initialization and atlas upload are
zero. Final sequence cleanup (35.33–40.17 ms) is separate from frame wall.
Preparation, video decoding, ANSI encoding/rendering and diagnostic gaps are not
included. Driver-log checks occur around every frame, so this is a guarded warm-fit
latency experiment, **not continuously fed throughput or end-to-end video latency**.
Five different warm images are not a repeated-frame latency distribution. No
p95/p99, realtime, sustained stability or statistically optimal tile claim follows.

Reuse clearly removes startup cost. At 32 MiB, same-image first/last observations
were 215.21/41.24 ms and 258.79/74.40 ms for FP32/FP64 at 160x80; at 320x160 they
were 384.74/146.61 ms and 436.01/237.64 ms. Warm image/content and device clock
effects are included; this is not an isolated attribution of every saved millisecond.
The 32 MiB warm medians were modestly lower than 16 MiB, with overlapping ranges.

Remaining costs matter: median packing takes about 5.8–6.9 ms at 160x80 and
19.8–24.3 ms at 320x160. Bridge intervals include GPU work and host synchronization,
so their difference from event sums cannot all be attributed to HTTP. Native
upload/readback medians are about 0.3–0.4/0.1–0.2 ms at 160x80 and
1.3–1.5/0.3–0.5 ms at 320x160. Further profiling should separate CPU packing,
native synchronization and framing before choosing the next optimization.

## Correctness, safeguards and provenance

All 48 outputs match saved fresh-context outputs **in the same arithmetic mode**
byte for byte at the tuple level. One `--stdio` PID is retained per session;
separate before/after `--info` probes are recorded and excluded from fit timing.
The repeated first image also matches within the retained context. This checks
reuse correctness; it does not assert FP32/FP64/CPU equality. CPU is explicitly
skipped in this larger benchmark. See the preceding
[precision report](GTX1650SUPER_PRECISION_BENCHMARK.md) for quality differences.

Before this matrix, one-cell and 512-cell sequences ran twice in each precision:
eight diagnostic frames / 2,052 cells, separately recorded. No fault, pressure,
stress loop, sanitizer, watchdog bypass or machine-setting change was performed.
All completed ordinary frames report no frame/cleanup timeouts or new driver
events. Desktop responsiveness was not independently observed. Largest observed projection/selection launch intervals were 2.68/3.00 ms;
those event intervals do not establish watchdog stability.

Device: GTX 1650 SUPER, ordinal 0, capability 7.5, driver 616.92, display watchdog
enabled, 4,294,508,544 reported total bytes. Before/after CUDA free-memory probes
were 3,441,950,720 bytes. Declared native allocation was 24,641,360 bytes at 16 MiB
and 42,111,280 bytes at 32 MiB, identical across precisions. Admission still uses
the native 2,147,483,648-byte reserve; snapshots are not peak residency measurements.

Tiny diagnostics use source `04b6aa422e8789e1a8e75a2eb89c84cca071cc77`; the matrix
uses `23f135f25f0077994a62d76d8bc27f412a161e93`. The latter changes only active-close
timing so its cancellation wait is included. All physical work uses the unchanged
normal worker from `30fc36d74cbeb29b07b55e70dff08b591f07d858`, SHA-256
`e9306b8e7380fdbe94206ad86f5205c98c504c09c3b02d74623b3cc853cd0c7a`, with source/hash
receipts and runtime licenses under `build/ci-30fc36d/`. Native-source equality is
checked before discovery. Its [source CI passed all three jobs](https://github.com/techrote/PNGGPU/actions/runs/41852436477).

Literal Git statuses in the matrix record untracked local media arriving/moving
from `agenticparkour/` to `benchmarking-material/`. Those files were not consumed
in this still-image matrix; tracked matching sources were unchanged. The temporary
package inventory accidentally included those then-untracked media hashes.
[CI 41866763487](https://github.com/techrote/PNGGPU/actions/runs/41866763487) exposed
that manifest mismatch; its host behavioral tests passed and compiler jobs passed.
The package correction excludes local media and regenerates the inventory. It
does not reclassify that earlier run as passing CI.

Local checks passed 15 original tests, 73 overlay tests and 47 bridge/planning/image
tests, plus independent CPU golden regeneration. Independent review ran the 68
focused adapter/bridge/planning/image tests and reviewed lifecycle/caps. Review
findings on early validation cleanup, tiny-only reference skipping and active-close
timing were addressed. Native/kernel arithmetic and the earlier failed TITAN
stability disposition remain unchanged.

## Artifacts and reproduction

[Summary](gtx1650super-warm-frames/summary.json) preserves every frame's component
timings, actual process IDs/exits, source hashes, input provenance, raw-report
hashes, device/driver checks and explicit CPU skip. [CSV](gtx1650super-warm-frames/frames.csv)
contains all 48 frame observations. [outputs.bin](gtx1650super-warm-frames/outputs.bin)
stores the actual tuples as little-endian uint16 glyph index + uint8 foreground +
uint8 background; summary offsets/hashes identify each frame. Each matches its
named cold reference in the preceding committed archive. Local full raw receipts
remain in ignored `build/qualification/warm-matrix/`. Tiny inputs/results are
included separately, not counted in the matrix totals.

```powershell
node scripts/benchmark_cuda_warm.mjs build/ci-30fc36d/build/cuda/pnggpu_cuda_worker.exe build/qualification/precision-large-packed build/qualification/warm-matrix
python scripts/export_cuda_warm.py
```

These commands require the previous locally preserved prepared-input receipts;
Git does not carry those large raw files or worker/tool installations. The exact
source-bound worker/receipt/licenses and setup instructions remain in the previous
report. A single bounded session uses `scripts/benchmark_cuda_frames.mjs WORKER
PLAN_JSON OUTPUT_JSON`; its plan records exact input paths/order, mode, tile and
aggregate limits. Larger sessions require the saved cold reference. A missing
reference may only be explicitly skipped for smoke inputs of at most 512 cells.

The user selected the local [parkour motion candidate](gtx1650super-warm-frames/motion-candidate.json):
`benchmarking-material/agenticparkour/agenticparkour.mp4`, 854x480 H.264, 30 fps,
24.009 seconds, with existing FFmpeg-extracted PNGs. It was **not** used in this
still baseline. The requested next scope is the first 120 frames for assessment,
then 30-frame comparisons, with preparation/decode/fit/output costs kept separate.
