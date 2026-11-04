# Aspect-correct parkour and larger CUDA tiles

Recorded 4 November 2026. **PR #2 remains draft.** These finite ordinary
comparisons retain the native 2 GiB admission reserve, bounded kernel launches,
watchdog protections and effective queue depth one. No machine setting,
fault/pressure injection or stress qualification was introduced.

## Resolution and previews

The preceding letterboxed clips were 160x80 characters / 1280x1280 pixels.
The new grids are **160x45 / 1280x720 pixels** and **320x90 / 2560x1440 pixels**,
using the same 8x16 glyphs and 4x8 samples per character. The 854x480 source is
center-cropped to **848x477 at (3,1)**, removing six columns and three rows in
total. That source rectangle and both rendered grids are exactly 16:9.

- [120-frame FP32 preview](gtx1650super-motion-cropped/parkour-120-fp32-160x45.mp4)
- [Aligned FP64 preview](gtx1650super-motion-cropped/parkour-120-fp64-160x45.mp4)

Both show the first 120 frames at 160x45/32 MiB and play for four seconds at
30 fps. Playback is for visual assessment, not a realtime processing claim.
Software x264/CRF12/YUV420 previews are compressed; accompanying PNGs and packed
tuples retain the exact renderer output. The renderer was checked against an
original workbench PNG before encoding.

## Thirty-frame performance comparisons

Each sequence initializes once on frame 1, followed by 29 warm frames. Fit wall
includes validation, packing, HTTP/framing, native synchronization, GPU kernels,
readback and result decoding. It excludes source PNG decoding/resampling, input
read/hash, ANSI encoding, diagnostic gaps and presentation. Sequence cleanup is
separate. This is warm-fit latency, not continuously fed throughput or visible
stutter measurement.

| Characters | Tile target | FP32 median ms | FP32 range ms | FP64 median ms | FP64 range ms |
|---|---:|---:|---:|---:|---:|
| 160x45 | 16 MiB | 82.32 | 20.96–117.89 | 78.93 | 42.32–192.61 |
| 160x45 | 32 MiB | 80.53 | 18.72–108.54 | 82.15 | 40.43–181.31 |
| 320x90 | 16 MiB | 98.30 | 87.08–262.41 | 150.75 | 135.60–179.33 |
| 320x90 | 32 MiB | 99.90 | 75.37–234.78 | 147.56 | 131.58–187.97 |
| 320x90 | 64 MiB | 97.25 | 66.19–257.63 | 136.65 | 125.25–176.51 |
| 320x90 | 128 MiB | 85.69 | 71.36–245.07 | 136.71 | 129.81–166.70 |

The longer 120-frame cropped runs have 119 warm frames. Their FP32/FP64 medians
are 89.42/86.97 ms, with ranges 18.44–127.41 / 37.76–187.06 ms. FP32 is not
uniformly faster on this motion workload. Variation includes changing content
and shared display-GPU scheduling; it is not a repeated identical-frame jitter
distribution. No realtime, p95/p99 stability or production claim follows.

At 320x90, FP64 improved from 32 to 64 MiB: paired median fit ratio **0.9422**
(about 5.8% lower), exploratory bootstrap 95% interval **0.9067–0.9689**. FP32's
ratio was 0.9827 with interval 0.8537–1.1695, inconclusive. Before seeing these
results, escalation required a paired median ratio <=0.95 and bootstrap upper
bound <1. The FP64 result triggered 128 MiB comparisons in both precisions.

From 64 to 128 MiB, FP64 plateaued (paired ratio 0.9931, interval
0.9430–1.0287). FP32's aggregate median fell, but its paired ratio 0.9587 and
interval 0.8027–1.0668 did not establish a reliable gain. These bootstraps are
exploratory: they do not control adjacent-frame dependence, run order or GPU
scheduling and are not statistical qualification of an optimum.

## Why testing stops before 256 MiB

| Grid / target | Effective tile cells | HTTP tiles/frame | Effective projection | Declared native buffers |
|---|---:|---:|---:|---:|
| 160x45 / 32 MiB | 7,200 | 1 | 23.9502 MiB | 33,325,472 bytes |
| 320x90 / 32 MiB | 9,619 | 3 | 31.9968 MiB | 42,111,280 bytes |
| 320x90 / 64 MiB | 19,239 | 2 | 63.9969 MiB | 77,051,120 bytes |
| 320x90 / 128 MiB | 28,800 | 1 | 95.8008 MiB | 111,776,672 bytes |

Projection storage is cells x 218 glyphs x 16 bytes. The entire 320x90 frame
fits at 128 MiB, so a 256 MiB target cannot increase the effective tile for this
workload. The 160x45 frame already fits at 32 MiB. No redundant larger-target
runs were performed. The existing native 128 MiB projection cap was not raised;
buffer totals include other allocations and are not peak device residency.

## Comparison with letterboxing

Each cropped grid has **43.75% fewer cells**. At a common 32 MiB target:

| Precision / width | Letterboxed median ms | Cropped median ms | Letterboxed ms/1,000 cells | Cropped ms/1,000 cells |
|---|---:|---:|---:|---:|
| FP32 / 160 | 72.28 | 80.53 | 5.647 | 11.184 |
| FP64 / 160 | 83.28 | 82.15 | 6.506 | 11.409 |
| FP32 / 320 | 142.41 | 99.90 | 2.781 | 3.469 |
| FP64 / 320 | 229.71 | 147.56 | 4.487 | 5.124 |

At that same 32 MiB target, the warm ranges and coefficient of variation
(population standard deviation / mean over the 29 frames) are:

| Precision / width | Letterboxed range ms | Cropped range ms | Letterboxed CV | Cropped CV |
|---|---:|---:|---:|---:|
| FP32 / 160 | 32.91–143.15 | 18.72–108.54 | 39.4% | 54.1% |
| FP64 / 160 | 67.44–245.01 | 40.43–181.31 | 42.4% | 48.2% |
| FP32 / 320 | 116.44–238.81 | 75.37–234.78 | 24.9% | 36.6% |
| FP64 / 320 | 212.55–255.08 | 131.58–187.97 | 3.8% | 10.0% |

These are content/run variability, not repeated identical-frame jitter or
observed presentation stutter. Lower absolute latency did not imply lower
relative variation in these runs.

Cost does not scale linearly with cell count here. The smaller crop did not make
the 160-column median faster; the 320-column absolute medians improved, but less
than the cell-count reduction. Large uniform regions may be cheaper per cell,
but this experiment **does not isolate contiguity as the cause**. Resampling and
cell alignment change, fixed overhead is amortized over fewer cells, tile counts
change, and the runs are separate. At 160 columns the 32 MiB target changes from
two tiles to one. A controlled cell-preserving permutation with identical samples
and cell counts would be the next test for spatial grouping/warp effects.

## Scope, identity and reproduction

Cropped characterization/comparison totals are 480 frames / 6,048,000 cells;
the adaptive 64/128 MiB extension adds four 30-frame sequences / 3,456,000 cells.
Total: **600 frames / 9,504,000 cells**, all from the same first 120 source frames.
Every same-mode output matches across tile sizes, including the larger-tile runs.
The 160-column first-30 comparisons match their longer runs. CPU is explicitly
skipped; `qualificationAccepted:false` remains. FP32/FP64 differences in the
cropped data range from 96–687 tuples/frame at 160x45 (120 frames) and
1,098–5,560 at 320x90 (30 frames); counts are not perceptual scores.

Preparation source is `4427a4afc14d4645485f4ad5fa15c40a18bee5d9` for the
160x45 batch and `fbf1ee09976a368d6eab9338280f1ccd4c4eab98` for the 320x90
batch. Preparation files are unchanged between those commits. Matching
source is `8d6edecd942e8865c7998ee447b888540e411144`.
[Its CI passed all three jobs](https://github.com/techrote/PNGGPU/actions/runs/41876774371).
Native sources and the adapter
arithmetic are unchanged from the preceding motion experiment. The physical
normal worker is still `30fc36d74cbeb29b07b55e70dff08b591f07d858`, SHA-256
`e9306b8e7380fdbe94206ad86f5205c98c504c09c3b02d74623b3cc853cd0c7a`, with receipts
and runtime licenses retained locally. The adaptive orchestration script's exact
SHA-256 is recorded separately because it was first run from ignored build tools.

All jobs completed without frame/cleanup timeout or new driver events. The actual
device remains GTX 1650 SUPER ordinal 0, capability 7.5, driver 616.92, watchdog
enabled. Admission retains its native 2,147,483,648-byte reserve and accurate
device capacity; no excessive allocation or pressure test was used. Desktop
responsiveness is not independently measured, and the prior TITAN failed-stability
gate remains unchanged.

[Summary](gtx1650super-motion-cropped/summary.json),
[per-frame CSV](gtx1650super-motion-cropped/frames.csv),
[adaptive tile sweep](gtx1650super-motion-cropped/tile-sweep.json) and packed
outputs preserve scope, timings, source/input hashes, process IDs/exits, actual
tile/depth/allocation, CPU skips and driver/device evidence. Larger-tile frame
offsets refer to the same cropped `outputs.bin`, after verifying identical bytes.
Full raw inputs/results remain in ignored `build/qualification/parkour-crop*`
and `parkour-larger-tiles/`. Independent pre-matching review checked crop geometry,
caps and export labeling; the earlier letterboxed evidence remains separately
preserved in [its report](GTX1650SUPER_MOTION.md).

Independent post-run review verified all 600 raw/packed/ANSI output hashes,
480 baseline CSV rows, larger-tile equality, counters/process exits, scope,
quality ranges and numerical tables, and recomputed all four paired/bootstrap
results. The orchestration source SHA matches the recorded helper exactly.

From the repo root, after setup with the source-bound worker and local tools:

```powershell
node scripts/prepare_cuda_video.mjs build/qualification-tools/node_modules/playwright/index.mjs benchmarking-material/agenticparkour 160 45 120 build/qualification/parkour-crop160 crop-16:9
node scripts/prepare_cuda_video.mjs build/qualification-tools/node_modules/playwright/index.mjs benchmarking-material/agenticparkour 320 90 30 build/qualification/parkour-crop320 crop-16:9
node scripts/benchmark_cuda_video_matrix.mjs build/ci-30fc36d/build/cuda/pnggpu_cuda_worker.exe build/qualification/parkour-crop160 build/qualification/parkour-crop320 build/qualification/parkour-crop-matrix cropped
node scripts/benchmark_cuda_larger_tiles.mjs build/ci-30fc36d/build/cuda/pnggpu_cuda_worker.exe build/qualification/parkour-crop320 build/qualification/parkour-crop-matrix/matrix.json build/qualification/parkour-larger-tiles
```

The 120-frame characterization uses `benchmark_cuda_video.mjs` with the cropped
160 batch, mode, target 32 and count 120, once per precision. Render/export with
`render_cuda_video.py`, `export_cuda_video.py cropped` and
`export_cuda_larger_tiles.py`. Each job has explicit frame/cell/work bounds,
per-frame 10-second deadlines and driver checks; there is no hidden stress loop.
