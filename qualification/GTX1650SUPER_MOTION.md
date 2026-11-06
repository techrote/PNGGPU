# Parkour motion: warm CUDA FP32/FP64

Recorded 4 November 2026. **Both 120-frame previews and the eight 30-frame
comparisons completed. PR #2 remains draft.** The worker/context/atlas/native
buffers persist between frames. Native admission retains its 2 GiB reserve;
effective queue depth remains one. No stress/fault/pressure experiment or
machine-setting change was performed.

## Preview and scope

- [FP32, first 120 frames](gtx1650super-motion/parkour-120-fp32-160x80.mp4)
- [FP64, the same 120 frames](gtx1650super-motion/parkour-120-fp64-160x80.mp4)

Both clips show 160x80 characters at a 32 MiB tile target. They play four seconds
at the source's 30 fps **for visual assessment, not as a realtime demonstration**.
The MP4 previews use software x264/CRF12/YUV420; exact original-renderer PNGs and
packed tuples accompany them. MP4 color subsampling/compression is not the
arithmetic output. Source aspect is preserved with black letterboxing inside the
square 160x80-character canvas (8x16-pixel glyphs), and those black cells are
included in matching work.

Source: user-provided `benchmarking-material/agenticparkour/agenticparkour.mp4`,
SHA-256 `e444f447d50891af0a1049ed08aef326733bc5dce612258c1a0a4a934d943ada`.
FFprobe reports 854x480 H.264, 30/1 fps, 719 frames, 24.009 seconds. The user
supplied PNGs extracted with `ffmpeg -i input.mp4 frame_%04d.png` and reported
the BtbN 4 November build; that extraction binary/timing was not independently
measured. Preview encoding here uses installed FFmpeg 9.0.1/Gyan, software x264.
Raw media remains local and ignored by Git.

There are **480 converted frames / 10,752,000 cells** in this motion package:
120 frames per precision at 160x80/32 MiB, followed by the same first 30 frames
in each of eight size/precision/tile combinations. These are 120 unique source
frames, not 480 different source frames. All use 4x8 samples, 218 glyphs,
32-glyph shortlist and six/five candidates. All cells are direct; no guard or
recovery work is reported. CPU comparison is explicitly skipped and
`qualificationAccepted:false` remains.

## Measured latency

Each 30-frame sequence includes one cold frame and 29 warm frames. The table
reports warm medians/ranges; timings vary with frame content and shared display
GPU scheduling. One sequence per configuration is insufficient to establish
repeatable differences or tail latency.

| Characters | Tile | Precision | Warm fit median ms | Warm fit range ms | Kernel median ms | Prepared RGBA to ANSI median ms |
|---|---:|---|---:|---:|---:|---:|
| 160x80 | 16 MiB | FP32 | 101.33 | 33.08–146.45 | 83.50 | 103.45 |
| 160x80 | 16 MiB | FP64 | 85.08 | 68.36–154.09 | 66.06 | 87.64 |
| 160x80 | 32 MiB | FP32 | 72.28 | 32.91–143.15 | 47.03 | 74.72 |
| 160x80 | 32 MiB | FP64 | 83.28 | 67.44–245.01 | 62.28 | 86.59 |
| 320x160 | 16 MiB | FP32 | 186.83 | 147.64–404.03 | 76.32 | 195.41 |
| 320x160 | 16 MiB | FP64 | 242.09 | 225.90–272.50 | 165.12 | 250.39 |
| 320x160 | 32 MiB | FP32 | 142.41 | 116.44–238.81 | 65.80 | 150.65 |
| 320x160 | 32 MiB | FP64 | 229.71 | 212.55–255.08 | 165.31 | 237.77 |

The longer 120-frame runs have 119 warm observations. FP32 fit median/range is
**106.35 / 29.20–168.54 ms**; FP64 is **90.86 / 63.37–260.31 ms**. Their kernel
medians are 88.32/69.92 ms, and prepared-RGBA-to-ANSI medians 108.46/92.95 ms.
Thus the earlier still-image FP32 speed advantage is **not universal on this
video**. The 32 MiB target has lower 30-frame medians here, but ranges overlap
and exact optimality is not established.

Fit wall includes validation, packing, HTTP/native framing, CUDA work,
synchronization, readback and result decoding. Frame 0 includes initialization;
warm frames report zero initialization and atlas upload. Input read/hash and ANSI
encoding are separately timed, non-overlapping additions to form
`preparedFrameToAnsiMs`. Sequence cleanup is separate. Offline PNG decoding,
resampling, disk output of results, diagnostic gaps, H.264 decode and visible
presentation are excluded. There is no end-to-end streaming/imperceptible-lag claim.

PNG preparation uses browser `createImageBitmap` and high-quality canvas scaling.
For the 160x80 batch, median decode/resample times were 4.4/4.3 ms. Its median
72.87 ms preparation transport interval **includes** decode, resample, base64/IPC
and host decoding; those intervals must not be added together. This research
transport is not proposed as the live input path. Diagnostic driver-log queries
also leave gaps between frames, so reciprocal fit time is not measured throughput
of a continuously full queue.

GPU selection is a substantial cost, with large variation on motion content.
The FP32 selector currently shares a kernel with the guarded selector. Compiler
register/local-memory use and scheduling should be profiled before attributing
these differences solely to FP32/FP64 hardware throughput. That is a hypothesis
for the next optimization, not a measured cause. Packing and native synchronization
also need profiling. No arithmetic/search reduction was introduced here.

## Output comparisons and evidence

All first-30 outputs are bit-identical across 16/32 MiB tiles **within each
precision**. The 160x80 sequences also match the first 30 outputs of the longer characterization
runs in that precision. Worker PID/session counters prove a single retained
`--stdio` process per sequence, with separate before/after information probes.

Across the 120 160x80 frames, FP32 differs from FP64 in **94–736 character tuples
per frame**. Across the 30 320x160 frames it differs in **1,144–5,990 tuples**.
These counts are not perceptual scores; glyph/color tuple changes can render to
identical pixels. The aligned previews and exact PNGs support visual assessment.
No claim that FP32 outputs are universally identical to FP64 or CPU is justified.

[Summary](gtx1650super-motion/summary.json) and [CSV](gtx1650super-motion/frames.csv)
contain all observations, input/source/byte identities, scope, process exits,
device information, driver queries and per-frame timing. The summary stores both
prepared batch receipts. [outputs.bin](gtx1650super-motion/outputs.bin) preserves
actual four-byte tuples (LE uint16 glyph, uint8 foreground, uint8 background).
Each frame's offset/cell count/hash selects its span; identical outputs share
spans. Raw reports and RGBA batches remain in ignored `build/qualification/`.

Matching/preparation source is `751f153b8766db4aadd0555e04c3add355887705`, with a
clean tracked working tree during measurement.
[CI 41870431842 passed](https://github.com/techrote/PNGGPU/actions/runs/41870431842).
The normal physical worker remains source `30fc36d74cbeb29b07b55e70dff08b591f07d858`,
SHA-256 `e9306b8e7380fdbe94206ad86f5205c98c504c09c3b02d74623b3cc853cd0c7a`.
Native sources are unchanged and checked before discovery; source/hash receipts
and runtime licenses remain under `build/ci-30fc36d/`. Device is the recorded
GTX 1650 SUPER, ordinal 0, capability 7.5, driver 616.92, watchdog enabled.
Declared native allocation remains 24,641,360 / 42,111,280 bytes at 16/32 MiB.

All sequences completed without frame/cleanup timeout or new driver events.
Desktop responsiveness was not independently observed; the user stated stutter
is acceptable on this development machine. That does not establish sustained
stability or remove the original failed TITAN stability gate. No fault/pressure,
watchdog or registry-setting experiment was performed.

Pre-matching independent review found and fixed batch-label validation,
post-cleanup probe validation and PNG byte/IHDR limits before decoding. Corrected
preparation regenerated both batches and matched every RGBA hash of the preceding
preparations (150 prepared frames); neither preparation invokes matching. Host
tests cover the 120-frame cap, aggregate work, bad headers and failed probes.
Preview reconstruction was checked pixel-for-pixel against an original workbench
PNG before encoding.

## Reproduction

Run pinned setup and use the recorded normal worker with its receipts/licenses.
Install Playwright locally; Python preview rendering needs NumPy/Pillow and
software FFmpeg. With the user-supplied PNG directory present:

```powershell
node scripts/prepare_cuda_video.mjs build/qualification-tools/node_modules/playwright/index.mjs benchmarking-material/agenticparkour 160 80 120 build/qualification/parkour-160-checked
node scripts/prepare_cuda_video.mjs build/qualification-tools/node_modules/playwright/index.mjs benchmarking-material/agenticparkour 320 160 30 build/qualification/parkour-320-checked
node scripts/benchmark_cuda_video.mjs build/ci-30fc36d/build/cuda/pnggpu_cuda_worker.exe build/qualification/parkour-160-checked float32-direct 32 120 build/qualification/parkour-initial.json
node scripts/benchmark_cuda_video.mjs build/ci-30fc36d/build/cuda/pnggpu_cuda_worker.exe build/qualification/parkour-160-checked binary64-direct 32 120 build/qualification/parkour-initial-fp64.json
node scripts/benchmark_cuda_video_matrix.mjs build/ci-30fc36d/build/cuda/pnggpu_cuda_worker.exe build/qualification/parkour-160-checked build/qualification/parkour-320-checked build/qualification/parkour-matrix
python scripts/render_cuda_video.py build/qualification/parkour-initial.json build/qualification/parkour-previews/parkour-120-fp32-160x80.mp4
python scripts/render_cuda_video.py build/qualification/parkour-initial-fp64.json build/qualification/parkour-previews/parkour-120-fp64-160x80.mp4
python scripts/export_cuda_video.py
```

Every job validates explicit frame/cell/work limits before discovery, applies a
10-second frame deadline and checks driver errors around frames. There is no
hidden repeat/stress loop. Compare output quality first, then profile the
selection/packing path and a bounded live-input queue with frame-age/drop metrics.
