# TITAN RTX qualification — 4 November 2026

For continuation on the other computer, read the
[GTX 1650 SUPER handover and Codex prompt](GTX1650SUPER_HANDOFF.md), including
the display-GPU stability restrictions.

**Current disposition: CONDITIONAL — PHYSICAL QUALIFICATION REQUIRED. PR #2 remains draft.**

The CUDA parity blocker described below was repaired by guarded binary64 GPU
recovery in `01fc878e7e1741644d6ceb99f2321cd78adb03dd`. Renewed TITAN RTX tests
match CPU exactly across the five modest hardmodes, partial tiles and both
512×512 workloads. See [current recovery evidence](RECOVERY.md). Remaining
sanitizer and broader hardware qualification gates still prevent acceptance.

The following report preserves the **historical float32-only failure** and its
original source identities. It must not be mistaken for the current worker's
qualification result.

Physical GPU execution is available and has been tested. Production acceptance
has failed; this is no longer merely a missing-hardware gate.

## Source and artifacts

- Application / runner tested: `37706c3e85d538ac3c0de7c89e23cfc1dc21200a`.
- Full physical reconstruction run used the historical green CI Windows worker
  from `3ffa2054392a6ea01d7f228cf4c71ef9b2f3a40d`, SHA-256
  `afd40fc583677d49c5e752fc5e4fde0d0ea0ba85a03c2898800865672957441b`.
  The runner verified that native sources had no differences between these
  revisions. It independently hashed and checked all installed overlay files
  and original hardmode images. Source status was clean when the run began.
- [Exact implementation CI, all three jobs passed](https://github.com/techrote/PNGGPU/actions/runs/41754021173).
- The newly compiled worker from that implementation CI has SHA-256
  `88fdf73f3c5b25b8b61a35e4bb663080b091f93b9403a5dc01eac7ed9d2815d8`.
  Its physical self-test also passed during the sanitizer attempt. The full
  reconstruction report does **not** claim to have used that newer binary.
- [Physical report, inputs and isolated replays](turing-37706c3.json).
- [Arithmetic diagnosis](arithmetic-37706c3.json). Explicit float32 intermediate
  values are a JavaScript model of the native operation sequence, not captured
  GPU intermediate buffers. Actual output tuples come from the real GPUs.
- [Compute Sanitizer log](memcheck-37706c3.txt).
- Full per-tile local report: `build/qualification/37706c3.json`. The committed
  report retains stage totals, all mismatch fixtures, source inventories,
  tile counts, maxima and first/last tile; it records the full report hash.

The evidence commit adds reports, diagnostics and a CPU fixture regression to
the tested implementation. It does not change the CUDA kernel, WGSL, bridge or
workbench arithmetic. CI on the final PR head remains a separate integration gate.

## Physical environment and results

Windows WDDM, NVIDIA TITAN RTX (ordinal 0, capability 7.5, 24 GiB), driver
581.80, CUDA runtime 12.8, Chrome 156.0.8078.80. WDDM execution timeout is
enabled. Initial snapshot: 1350 MHz SM, 7000 MHz memory, about 64 W idle power,
280 W cap. These are snapshots, not load-clock or energy measurements.

Every case used 218 browser-rasterized glyph masks, six foreground/five
background candidates and identical prepared source samples across backends.
Three fits per backend included identical repeats and a 64-cell tile variant.
All recorded repeats and tile variants were deterministic.

| Workload | CPU vs CUDA changed cells | CPU vs WebGPU | CUDA vs WebGPU |
|---|---:|---:|---:|
| All five hardmodes, each 80×40, 4×8 samples | 0 | 0 | 0 |
| 17×9, 4×8 samples, partial tail | 0 | 0 | 0 |
| 512×512, 1×1 samples | 366 | 364 | 6 |
| 512×512, 4×8 samples | 7 | 8 | 1 |

ANSI bytes were exact in the six modest cases. The larger cases failed ANSI
equality too. Positional byte mismatch counts can be much larger than cell
counts because a changed colour transition changes SGR sequence lengths and
shifts later bytes; the report preserves both counts rather than conflating them.

Native self-test: 39 cases, 2,601 compared cells, repeated allocation reuse.
Real HTTP cancellation: aborted after requesting a tile; received `AbortError`,
then successfully converted 128 cells. Reported free memory before and after
was 24,458,035,200 bytes. This checks recovery, not a global peak-memory bound.

## Precise parity causes and unresolved quality loss

Isolated one-cell replays retain the same differing outputs. Tile indexing,
partial tiles and repeated execution do not explain these fixtures.

- At 1×1, pixel `[210,210,208]`, all projection covariances are exactly zero.
  CPU chooses glyph 15 / FG 15 / BG 7, CUDA and WebGPU choose glyph 8 / 15 / 7.
  CPU scoring gives glyph 15 error 2.6716335490 versus glyph 8 error
  2.6799052432. Explicit no-FMA float32 scoring reverses the order:
  2.66845703125 versus 2.6650390625. The original candidate ordering and strict
  comparisons remain intact; rounding has changed the winner.
- At 4×8 cell 65622, accumulation and subtractive scoring reverse two close
  candidate errors. CPU chooses glyph 188; CUDA/WebGPU choose 189.
- At cell 110138, float32 changes the first two shortlist positions. FG equals
  BG, so both glyphs have identical reconstruction error; this is a distinct
  tie-order case, still an exact tuple/ANSI parity failure.
- **At cell 105420, float32 replaces CPU glyph 182 at shortlist position 32
  with glyph 123.** CPU selects tuple `[182,8,0]`; CUDA and WebGPU select
  `[141,8,5]`. An independent reviewer computed direct sample reconstruction
  SSE (without the subtractive score formula): **29,571.557975** for CPU and
  **69,283.918012** for CUDA/WebGPU. This is material quality loss, not an
  equivalent-image glyph tie. The principal CPU objective also prefers the CPU
  tuple (29,571.585365 versus 69,283.929467).
- Cell 129687 is an additional CUDA/WebGPU difference: CUDA and CPU choose
  `[148,13,5]`; WebGPU chooses `[145,13,5]`. The exact WebGPU compiler arithmetic
  responsible has not been instrumented; it is not claimed to match a modeled
  CUDA intermediate merely because the WGSL equations look similar.

The preserved float32 operation sequence cannot guarantee the original
binary64 shortlist decisions. Recovery requires a separately reviewed precise
policy for ambiguous projection/ranking/selection decisions. No tolerances,
candidate-space reductions, FP16, fast-math, altered ties or silent CPU fallback
were introduced to make these tests pass. Exact physical acceptance exits with
failure, and the principal CPU winner remains a regression fixture.

## Measured performance and limits

These are first fit wall times, measured after fitter initialization. CUDA
worker/context startup is included; WebGPU pipeline creation is excluded and
reported separately in ordinary workbench reports. CPU here is the direct
independent JavaScript reference, without a Web Worker launch. Preparation is
shared. Later fits are fresh CUDA processes and cache-repeat observations.

| Workload | CPU fit ms | CUDA fit ms | WebGPU fit ms | CUDA kernels ms | CUDA buffer bytes |
|---|---:|---:|---:|---:|---:|
| Five 80×40 cases, range | 338.9–516.6 | 206.4–218.6 | 18.5–26.6 | 3.63–5.69 | 3,747,184 |
| 512×512, 1×1 | 9,040.1 | 456.0 | 68.8 | 75.40 | 57,479,688 |
| 512×512, 4×8 | 31,293.8 | 3,358.0 | 253.5 | 276.31 | 59,538,336 |

For 512×512 / 4×8: initialization 111.2 ms; host-clock upload including atlas
7.35 ms; readback 1.14 ms. The report records preparation, ANSI encoding,
packing, round trips, throughput, work counts and allocation sums separately.
The buffer sums exclude runtime/context/other applications; peak total VRAM and
integrated energy were not measured. No CUDA-over-WebGPU speedup was observed.
Failed-parity stress timings are diagnostic and are not accepted quality-equivalent
speedups over CPU.

Copies occupy a small fraction of wall time, while native startup, protocol and
per-tile synchronization dominate. The 64-cell stress variant is substantially
slower. Retain pipeline depth one until correctness is recovered and profiling
justifies complexity. Register pressure/occupancy, Nsight measurements and
cross-device tuning remain unqualified.

## Independent review and gates

A separate review agent identified and verified remediation of:

1. Stop failed to reach CUDA/CPU cancellation: connected signals and worker
   termination; active conversion cleanup and subsequent reuse regressions pass.
2. Repeat outputs were discarded: cell/ANSI comparisons now persist, flag
   failures in UI, suite counts and ZIP CSVs, and preserve canonical first output.
3. Harness provenance, CLI flag parsing and summary propagation: repaired;
   installed hashes, explicit worker source revision and native-source guard added.

The reviewer found no new supported defect in those fixes and independently
confirmed the material shortlist quality failure above. Review recommendation:
**BLOCKED — CORRECTNESS DEFECT**.

Compute Sanitizer 12.8.93 was downloaded from NVIDIA's official redistribution
manifest and SHA-256 verified. `memcheck --error-exitcode 1 --self-test` could
not initialize the WDDM debugger interface and reported two errors. The program
self-test ran, but **memory sanitization did not**. Enabling the debugger
interface requires administrator machine configuration; no such system changes
were made. Keep this as an outstanding physical gate.

Still required: exact parity recovery and renewed full qualification; successful
sanitizer execution; additional Turing models and mixed TITAN/V100 ordinal
selection; driver/toolkit matrix; context-loss, low-memory and sustained TDR
stress; measured peak memory/energy and occupancy before performance tuning.
No merge or ready-for-review transition is justified by compiler CI alone.

Windows reproduction commands are in
[the CUDA guide](../overlay/docs/CUDA_BACKEND.md#physical-qualification).
