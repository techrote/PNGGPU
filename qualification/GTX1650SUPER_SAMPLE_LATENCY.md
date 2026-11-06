# Sampling cost from the full-video FP32 export — 6 November 2026

Doubling sample width and height, from **4x8 to 8x16**, quadruples samples per
cell. In the recorded GTX 1650 SUPER export, mean warm fit latency increases
**10–130%** depending on character grid. At the requested **80x25** focus, it
rises **3.135 to 4.778 ms (+52.4%)**. The reciprocal conversion rate falls
**319.0 to 209.3 FPS**. These are conversion-only observations from the already
completed export, not new GPU measurements or live pipeline throughput.

PR #2 remains draft. This analysis invokes no GPU, worker, browser, fault/stress
runner or machine setting. It does not change the native 2 GiB reserve.

## Like-for-like latency observations

There are 719 delivered frames per configuration. The export opened a fresh
context per bounded chunk. Every `chunks.first` frame is cold: 24 are excluded,
leaving **695 warm frames per configuration**, with matching source-frame indices
in both sample settings. The extra canonical-packet comparison after the first
frame is not one of the stored fit timings and is not included.

**Arithmetic mean warm fit latency and 1000 / that mean:**

| Characters | 4x8 ms | 4x8 conversion FPS | 8x16 ms | 8x16 conversion FPS | Latency increase |
|---|---:|---:|---:|---:|---:|
| 8x4 | 1.595 | 627.0 | 1.792 | 558.1 | 12.4% |
| 16x8 | 1.755 | 569.9 | 1.936 | 516.6 | 10.3% |
| 32x16 | 1.882 | 531.4 | 2.312 | 432.5 | 22.9% |
| 40x12 | 1.920 | 520.7 | 2.296 | 435.5 | 19.6% |
| 80x24 | 3.097 | 322.9 | 4.729 | 211.5 | 52.7% |
| 80x25 | 3.135 | 319.0 | 4.778 | 209.3 | 52.4% |
| 80x40 | 4.595 | 217.6 | 7.214 | 138.6 | 57.0% |
| 120x34 | 5.375 | 186.0 | 8.238 | 121.4 | 53.3% |
| 160x45 | 8.680 | 115.2 | 14.339 | 69.7 | 65.2% |
| 160x80 | 12.359 | 80.9 | 23.734 | 42.1 | 92.0% |
| 320x90 | 26.955 | 37.1 | 55.070 | 18.2 | 104.3% |
| 320x160 | 40.858 | 24.5 | 93.906 | 10.6 | 129.8% |

`fitMs` begins immediately before `frames.fitFrame` and ends when its result
returns. It includes JS tile packing, direct pipes, native fit work and result
decoding. It excludes the preceding FFmpeg/source-frame read/decode, the earlier
worker-info probe, between-chunk driver queries, subsequent ANSI/file writing
and MP4 encoding. Warm fits reuse an initialized context; cold frame fits include
stdio worker/INIT/atlas costs, but still exclude the earlier info probe.

The FPS columns are **reciprocals of mean fit time**, not measured continuously
refilled queue FPS or end-to-end export FPS. Mean instantaneous FPS would give a
different, upward-biased summary and is not used. All MP4 playback stays 30 FPS
regardless of export speed. The previous dedicated queue experiments retain their
separate producer, bounds and throughput measurements.

All 4x8 exports ran before all 8x16 exports, once per variant. Adjacent video
frames are correlated, and the arms are not randomized repeated trials. Paired
source frames, identical crops/parameters and the same worker make the observed
comparison useful, but do not remove JIT, clock, driver or scheduling effects.
No confidence interval or universal speed ratio is claimed. A fourfold increase
in projection samples is not a fourfold increase in all fit stages or fixed costs.

## 80x25 detail

Both variants produce 640x400 pixels at 30 FPS, with the same 768x480 centered
source crop at (43,0), original glyph atlas/palette, 32-glyph shortlist and
6 foreground / 5 background candidates. Both are explicit FP32 direct mode with
zero guarded recovery. Native masks/inputs have four times as many samples in
the 8x16 arm; output dimensions do not change.

| Measurement | 4x8 | 8x16 |
|---|---:|---:|
| Warm mean fit ms | 3.135 | 4.778 |
| Warm median fit ms | 3.049 | 4.556 |
| Warm p95 fit ms | 3.868 | 6.302 |
| Warm max fit ms | 6.031 | 9.646 |
| Cold mean fit ms (24 frames) | 157.497 | 157.613 |
| All-frame mean fit ms (719 frames) | 8.287 | 9.880 |
| Warm native input packing mean ms | 0.117 | 0.474 |
| Observed conversion-stage wall FPS | 22.41 | 21.76 |
| MP4 bytes | 20,679,178 | 15,628,246 |
| Total raw ANSI bytes | 6,553,062 | 5,461,544 |

The wall-FPS row uses `719 / (report.finished - report.started)`. Unlike the
conversion reciprocal, it includes context churn, worker info, frame IO, driver
monitoring, ANSI/file work and cleanup. It excludes earlier provenance/source
validation and later MP4 encoding. This intentionally conservative offline
export workflow therefore runs much slower than an always-ready warm matcher.
Neither row is a live decode-to-display measurement.

Warm native input packing increases roughly fourfold (0.117 to 0.474 ms), as
expected from four times as many RGBA samples. The receipts do not preserve all
per-stage GPU timings, so the rest of the latency increase cannot be apportioned
precisely among projection, selection, transfer and pipe work here.

The 8x16 MP4 is smaller (15.6 MB versus 20.7 MB), despite taking more fit time.
That reflects changed content/compressibility under the same H.264 CRF 12
settings, not evidence of better fidelity. Perceptual quality should be judged
from exact frame-aligned ANSI rendering, without MP4 seeking or compression
confounding a static comparison.

## Frame alignment and exact differences

Across 719 frames, **996–1464 of 2,000 cells** change tuple between sample settings; median **1184** (59.2%). The mean is 1196.0 cells. Frame 1 has the largest tuple difference.


A changed tuple means glyph index and/or foreground/background palette index
changed. It is not a visual improvement score: duplicate glyph shapes, blank
glyph foregrounds and near-identical renderings can change tuples without an
equivalent perceptual change. Use these counts to locate comparison frames,
then inspect the same one-based frame number in each configuration.

[frames-80x25.csv](gtx1650super-sample-latency/frames-80x25.csv) records exact frame
IDs, cold/warm flags, both fit times and per-component tuple-change counts.
Frame `1` means `ansi/frame_0001.ans`; no video timestamp rounding is required.

## Evidence and reproduction

The input is the [complete-video delivery](GTX1650SUPER_VIDEO_EXPORT.md), runner
source `b7d2d7e46244fd8b6fd136e656fe818ecef495ed`. All arms use source-matched
worker `58cc6e24009cf2e522189bfbeb5c9c4ceaf939bc`, SHA-256
`9724dcdd33594ece5f41cdc8fb5695d86fe0c2b7d80913003a5d37c32e58bad7`.
Original worker receipts/build flags, per-report hashes and all/cold/warm
statistics are in [summary.json](gtx1650super-sample-latency/summary.json).

The offline extractor verifies manifest/report/render/tuple identities, actual
video and tuple-buffer hashes, clean completed receipts, chunk bounds, zero
recovery, clear driver checks and child cleanup. It reuses recorded `fitMs`;
no native process or GPU experiment runs. The prior independent delivery audit
separately verified every ANSI byte and rendered preview.

```powershell
node scripts/analyze_cuda_export_latency.mjs build/exports/agenticparkour-fp32-delivery qualification/gtx1650super-sample-latency
```

The extractor produces the compact summary, [pairs.csv](gtx1650super-sample-latency/pairs.csv)
and the 80x25 frame comparison CSV. Raw source PNGs, the delivery ZIP and full
export receipts remain in their ignored local directories.
