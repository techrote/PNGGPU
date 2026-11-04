# GTX 1650 SUPER precision and tile benchmarks

Recorded 4 November 2026. **210 ordinary, finite fits completed across all five
original images, including 160x80 and 320x160 output characters. PR #2 stays
draft.** These are visual/performance experiments, not strict parity or sustained
desktop-stability qualification. WebGPU and guarded CUDA remain the defaults.
Read [WDDM_RESILIENCE.md](WDDM_RESILIENCE.md) before GPU work.

## What the measurements show

At 4x8 samples per character, **16–32 MiB is the observed useful tile range**
for these two larger geometries on this GTX. GPU time improves substantially
from 1 MiB to 8 MiB, improves a little more at 16 MiB, then largely plateaus.
The 32 MiB target sometimes reduces whole-fit time even when kernel time does
not improve. There is one observation per image/mode/budget, with mode order
rotated. Medians below span five different images, not repeated measurements
of a single image; they do not establish a statistically optimal budget.

All CUDA results use **effective queue depth 1**. The user's earlier TITAN
WebGPU depth-4/8 observation is not a CUDA queue implementation or a measurement
on this GTX. Tile size and queue depth are separate variables.

Each table entry is **GPU kernel sum / fit wall milliseconds**, median across
the five images. GPU kernel sum is projection plus selection, measured with
CUDA events. Fit wall includes a fresh worker process/context and bridge work;
it excludes shared browser image/font preparation. Component intervals overlap
and must not be added to wall time.

| Characters | Projection target | FP32 | Direct FP64 | FP16 mixed |
|---|---:|---:|---:|---:|
| 160x80 | 1 MiB | 40.87 / 319.74 | 109.18 / 397.93 | 40.64 / 310.11 |
| 160x80 | 4 MiB | 26.36 / 261.90 | 67.82 / 297.48 | 26.25 / 260.71 |
| 160x80 | 8 MiB | 22.41 / 254.36 | 59.61 / 294.01 | 22.23 / 250.10 |
| 160x80 | 16 MiB | 21.18 / 249.28 | 55.93 / 279.31 | 21.31 / 241.26 |
| 160x80 | 32 MiB | 21.25 / 241.61 | 56.19 / 275.45 | 21.34 / 242.83 |
| 320x160 | 1 MiB | 159.81 / 668.68 | 379.96 / 902.76 | 159.04 / 656.85 |
| 320x160 | 4 MiB | 103.51 / 445.90 | 255.24 / 607.72 | 102.86 / 447.02 |
| 320x160 | 8 MiB | 87.58 / 400.39 | 223.16 / 537.27 | 87.82 / 401.17 |
| 320x160 | 16 MiB | 80.84 / 366.66 | 204.37 / 503.44 | 80.99 / 376.73 |
| 320x160 | 32 MiB | 80.63 / 358.32 | 209.91 / 499.51 | 81.10 / 352.74 |

At 16 MiB, FP32 kernels were about 2.6x faster than FP64 at 160x80 and 2.5x
faster at 320x160. Mixed FP16 did not demonstrate a useful speed improvement
over FP32. At 80x40/4x8, increasing tiles from 16 to 256 characters reduced
FP32 kernel time from 110.11–115.52 ms to 12.17–12.90 ms; corresponding wall
times fell from 537.05–589.14 ms to 261.46–269.57 ms. Tiny launch batches were
therefore a major cost in the preceding small-work measurements.

These results **do not establish realtime streaming or imperceptible latency**.
At the larger sizes, even FP32 compute alone is about 21 ms and 81 ms. Fresh-fit
wall time is much higher. The next engineering step is persistent worker/context
and reusable frame buffers, followed by bounded warm-frame latency distributions
and profiling of upload, bridge and output costs. Queue overlap can be investigated
separately after that; depth 4/8 must not be reported until implemented/measured.

## Precision and visible quality

All modes preserve the 218-glyph vocabulary, 32-glyph shortlist, six foreground
and five background candidates, and stable strict comparisons. Experimental modes
are explicit runner/bridge choices, not a shipped workbench toggle:

- `float32-direct`: unguarded original float32 projection and scoring.
- `binary64-direct`: original CPU-grouped binary64 projection and scoring,
  retaining the original float32 statistics; skips the float32 guard/pass.
- `float16-mixed`: actual FP16 mask/RGB products, FP32 accumulation, statistics
  and scoring. It is **not full FP16**, packed-half storage, Tensor Cores or
  a mature FP16 optimization. Conversion cost may consume any arithmetic gain.

All 4,951,680 converted cells in the primary dataset are direct cells; zero are
certified or recovered. This is intentionally different from the guarded runs
where every real-image cell needed recovery. Guarded CUDA remains available.

| Output characters | FP32 changed cells vs FP64, per output | FP16 mixed changed cells vs FP64, per output |
|---|---:|---:|
| 32x16 | 0 | 0–4 |
| 80x40, both sample settings | 0 | 5–27 |
| 160x80 | 0–1 | 30–87 |
| 320x160 | 0–11 | 227–369 |

These counts identify tuple changes, not a perceptual score. FP32 agreement on
these particular modest images is not a general parity guarantee: the separately
saved one-cell failure still differs in unguarded FP32. The first 60 fits compare
both tuples and ANSI bytes with the independent original JS CPU; FP32 and FP64
matched it in those fits. CPU comparison is explicitly **skipped/null** in the
150 larger fits, whose comparison reference is direct FP64 on the same GPU.
No larger CPU equality is implied. `qualificationAccepted` stays false throughout;
benchmark completion and strict parity are distinct.

This phase benchmarks CUDA precision modes. It does not rerun WebGPU at 160x80 or
320x160 or establish a CUDA-over-WebGPU speedup. Earlier one-image CPU/CUDA/WebGPU
results through 80x40, including their timing boundaries, remain in the
[staged report](GTX1650SUPER_STAGED_OUTPUTS.md). Historical larger WebGPU/CPU
disagreements and TITAN stability failures remain unresolved by this experiment.

## Hardware, memory and interruption record

Actual device: NVIDIA GeForce GTX 1650 SUPER, ordinal 0, capability 7.5,
4,294,508,544 device-reported total bytes, driver 616.92, interactive display
watchdog enabled. Node 24.21.0, Chrome 156.0.8078.80, Playwright 1.64.1.
The physical worker is compiled by pinned NVCC 12.8.93 in Windows CI; a local
CUDA toolkit/compiler is not assumed. GTX sanitizer remains pending and no
debugger prerequisite or other machine setting was changed.

The native **2,147,483,648-byte free-memory reserve remains enforced**. Minimum
before/after native free-memory snapshots were 3,441,950,720 bytes; these are
snapshots, not peak residency. Equal allocations across arithmetic modes control
this comparison; some buffers are unused by direct modes. The budgets refer to
the float32 projection buffer, not all native allocations:

| Target MiB | Effective tile cells | Effective projection MiB | Maximum declared total bytes |
|---:|---:|---:|---:|
| 1 | 300 | 0.997925 | 3,214,048 |
| 4 | 1,202 | 3.998352 | 11,540,736 |
| 8 | 2,404 | 7.996704 | 15,906,400 |
| 16 | 4,809 | 15.996735 | 24,641,360 |
| 32 | 9,619 | 31.996796 | 42,111,280 |

Each fit has one repeat, a 10-second whole-fit deadline, explicit run/cell/work
caps and bounded sublaunches. The largest declared logical work is 2,995,200,000
visits, below the explicit 3,000,000,000 cap. Largest observed individual
projection/selection event intervals were 3.55/3.25 ms. These timings are not
watchdog-stability proof. All 210 primary fits completed without reported stalls,
new NVIDIA/Display driver events or cleanup failures. No stress, fault/pressure,
sanitizer or settings-change experiment was performed.

An earlier large-sweep attempt at source `2148bdf` completed 15 ordinary 160x80
fits, then **stopped on a host/browser preparation timeout before any 320x160
CUDA matching**. Its browser-close cleanup also timed out; the failure is
preserved in [the receipt](GTX_PRECISION_BENCHMARK/preparation-timeout-2148.json),
not called successful cleanup. Driver queries found no new events. The corrected
preparation transports packed RGBA rather than millions of individual Playwright
numbers, without extending the deadline. A 6,553,600-byte host regression checks
the largest transport, and a 32x16 fixture matched the preceding preparation
exactly. The complete 150-fit sweep then restarted from clean source `4d9e1e6`.
Those earlier 15 fits are excluded from the primary 210-fit totals. Four one-cell
mode checks and a 512-cell tile-128 diagnostic are also separate from the totals.

## Source, binary and durable outputs

The primary dataset has 70 fits per mode, 1,650,560 cells per mode:

- 45 fits: five images x 32x16/4x8, 80x40/4x8 and 80x40/8x16, tile 16.
- 15 fits: same five 80x40/4x8 inputs, tile 256.
- 150 fits: five images x 160x80 and 320x160, 4x8 samples, tile targets
  1/4/8/16/32 MiB, all three modes, depth 1.

First 60 fits: clean runner source
`ad9d5ea85dd00ee2f54f7681e0d6f4128fc04717`,
[CI 41853125375 passed](https://github.com/techrote/PNGGPU/actions/runs/41853125375).
Complete larger sweep: clean source
`4d9e1e63767c7cbc2dd6359c84b00312a197c150`,
[CI 41858458788 passed](https://github.com/techrote/PNGGPU/actions/runs/41858458788).
The interrupted source's [CI 41857714827 also passed](https://github.com/techrote/PNGGPU/actions/runs/41857714827);
passing host CI did not predict its browser preparation timeout.

All physical fits use the normal Windows worker from source
`30fc36d74cbeb29b07b55e70dff08b591f07d858`,
[CI 41852436477](https://github.com/techrote/PNGGPU/actions/runs/41852436477),
Windows artifact 13334649224, SHA-256
`e9306b8e7380fdbe94206ad86f5205c98c504c09c3b02d74623b3cc853cd0c7a`.
All native sources are unchanged after that worker source, checked before
discovery. Source receipt, worker receipt and NVIDIA runtime licenses remain in
`build/ci-30fc36d/`. Compiler CI does not physically qualify its other binaries.

The [machine-readable summary](GTX_PRECISION_BENCHMARK/summary.json) contains
all 210 observations, source/font/script and raw input/report hashes, native
device probes, timing boundaries, actual tile/depth, CPU skip fields and final
driver query. The complete primary run window is 15:01:34.612–15:39:17.270 UTC;
the final recorded driver query at 15:41:01.187 UTC found no new events.

The folder also preserves [CSV measurements](GTX_PRECISION_BENCHMARK/results.csv),
52 unique exact-font PNG previews, 210 original-encoder ANSI files, glyph atlas
and all tuples in [outputs.bin](GTX_PRECISION_BENCHMARK/outputs.bin).
Each tuple occupies four bytes: little-endian uint16 glyph index, uint8 foreground
index, uint8 background index. Summary offsets, cell counts and SHA-256 values
identify each output. FP64-identical outputs share PNG paths. Previews are made
with the original workbench renderer and bundled font, not generated illustrations.
The inline view reconstructs those same pixels with synchronized zoom.

Local raw inputs/reports remain under ignored `build/qualification/precision-matrix/`
and `build/qualification/precision-large-packed/`; the interrupted attempt is
under `build/qualification/precision-large/`. Git does not carry those large
raw inputs or local tools. Durable packed tuples, ANSI, PNGs and hashes let the
results be inspected without claiming those ignored receipts are distributed.

## Reproduction

Run normal pinned application setup first (`setup.bat`) and install Playwright
locally. Preserve exact-source worker receipts and licenses when downloading
the identified CI artifact; do not substitute the older float32-only worker.
The following commands reproduce the finite matrices, not stress loops. Start
with one explicitly bounded case on any new machine and recheck device/free
memory and driver events before increasing work. Never lower the native reserve
to get admission. These commands intentionally keep queue depth one.

```powershell
gh run download 41852436477 --repo techrote/PNGGPU --name pnggpu-cuda-Windows-30fc36d74cbeb29b07b55e70dff08b591f07d858 --dir build/ci-30fc36d
node scripts/benchmark_cuda_precisions.mjs build/ci-30fc36d/build/cuda/pnggpu_cuda_worker.exe build/qualification-tools/node_modules/playwright/index.mjs build/qualification/precision-matrix
node qualification/GTX_PRECISION_BENCHMARK/run_tile_comparison.mjs
node scripts/benchmark_cuda_large.mjs build/ci-30fc36d/build/cuda/pnggpu_cuda_worker.exe build/qualification-tools/node_modules/playwright/index.mjs build/qualification/precision-large-packed
node qualification/GTX_PRECISION_BENCHMARK/export_results.mjs
```

For a single selected prepared large input, use `scripts/replay_cuda_fixtures.mjs`
with `--fixture-file`, exact `--case`, `--repeats 1`, `--tile-mib 16`,
`--max-runs 1`, matching `--max-cells`, `--max-work 3000000000`,
`--timeout-ms 10000`, and one explicit `--cuda-mode`. To reproduce the larger
benchmark's CPU omission, add **both** `--allow-parity-differences --skip-cpu`.
Without those, strict comparison behavior remains. No resilience runner or
hidden native GPU self-test is part of this path.

Host validation covers CLI modes before discovery, bridge/adapter protocol,
work-limit planning, skipped-comparison labeling and packed transport. Existing
CPU golden regeneration and native host tests remain in CI. Broader parity,
GTX sanitizer, persistent streaming latency, peak residency/energy and isolated
sustained-watchdog qualification remain open gates.

Local checks passed 15 original application tests, 70 overlay tests, 45
bridge/planning/image tests, seven host-only arithmetic CLI checks and independent
CPU golden regeneration. Gallery QA exercised all 70 image/setting selections,
all zoom/focus controls, narrow layouts down to a 328-pixel content width and
all 52 unique previews. Its 105,447,424 reconstructed pixels matched the original
renderer PNGs exactly, with no browser script errors or horizontal overflow;
see [QA receipt](GTX_PRECISION_BENCHMARK/gallery-qa.json).
