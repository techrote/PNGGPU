# GTX 1650 SUPER — bounded small real-image comparisons

Recorded 4 November 2026. **All selected CPU/CUDA/WebGPU comparisons passed.
PR #2 remains draft; full qualification remains incomplete.** Read
[WDDM_RESILIENCE.md](WDDM_RESILIENCE.md) before further GPU work.

## Scope and source identity

Engineering and application source was the clean checkout
`684a86d04b46728ac8cb7e016d0f00e2f09f8db6` for every preparation and fitting
receipt. Its [CI run 41842541336](https://github.com/techrote/PNGGPU/actions/runs/41842541336)
passed all three jobs, including 39 bridge/planning/image tests, 15 original
application tests, 67 overlay tests, native compilation/host tests on Windows
and Linux, independent CPU golden regeneration and the 110-file source manifest.
The evidence commit following it changes no preparation, matching or runner code.

The normal worker was the retained, independently identified Windows CI binary
from `905db75cc8ae85671bfec49bcf433a64cb94d543`, SHA-256
`938ea7b9bf5ef509cd2551e6527322bd650c9c8151913ffe5152e838fa564b1e`.
Its [CI](https://github.com/techrote/PNGGPU/actions/runs/41838854560) passed.
The runner verifies the binary receipt and native-source equality before GPU
discovery. Native sources are unchanged between that worker commit and `684a86d`;
this is not a hardware test of the distinct binary compiled by the later CI run.
Original `SOURCE_COMMIT.txt`, `worker-sha256.json` and runtime licenses remain in
`build/ci-905db75/`. Earlier TITAN and synthetic/saved-cell results remain
[separate evidence](GTX1650SUPER_RESULTS.md).

Actual device in every receipt: NVIDIA GeForce GTX 1650 SUPER, ordinal 0,
capability 7.5, watchdog enabled, 4 GiB installed, NVIDIA driver 616.92, CUDA
runtime 12.8. Native total memory is 4,294,508,544 bytes; reported free bytes
before/after every scope were 3,441,950,720. Read-only NVIDIA inventory before
work reported 3,376 MiB free. Chrome was 156.0.8078.80, Playwright 1.64.1 and
Node 24.21.0. CUDA admission still enforces its 2,147,483,648-byte reserve.

## Preparation and bounds

`prepare_cuda_image.mjs` prepares one exact manifest image. It checks original
image hashes, uses the unchanged workbench `font`, `masksFor` and `makeConfig`
function bodies, and captures the same full-reference Canvas2D image sampling
with smoothing enabled at high quality. Image transforms are neutral and NL/
derez are disabled, as in the workbench's comparison path. It records the
complete RGBA8 sample raster, float32 masks, CP437 code order, palette, config,
source/font/script hashes, browser identity and driver observations.

Preparation is capped at 64 cells and 128 samples/cell, with six foreground and
five background candidates. It performs **zero matching runs**. Both preparation
and replay now use minimal pages without UI startup or the full workbench's
automatic GPU memory estimate. No matching arithmetic or UI behavior changed.

Replay's `--fixture-file` validates input integrity and preparation source hashes
before discovery, then applies exact-case/repeat/tile/run/cell/work limits to
all backend fits. Request and browser work time out after 10 seconds in these
runs. New NVIDIA/Display warnings/errors, log-query failure or stalled work stop
later fits. Image replay checks events since preparation began, covering the
gap before fitting. Cleanup remains independently bounded and preserves failure
receipts. Source/binary provenance and an input hash are recorded in every report.

The session began with a fresh one-cell image. Only after its exact, responsive
result did it advance to 32 cells. Each subsequent scope allowed four backend
fits, 128 aggregate converted cells and at most 8,000,000 logical work visits;
actual work was 7,488,000. Total session work was 37,557,000 logical visits.
These units conservatively include full precise recovery, not FLOPs or a time
guarantee. No native self-test, cancellation experiment, failure replay, stress
loop, pressure/fault injection or machine-setting change was performed.

## Exact comparisons

All cases used 4×8 samples per cell, the original 218-glyph font atlas, six/five
color candidates and pipeline depth one. CPU used the independent JavaScript
reference validated against the pinned original CPU core. CPU, CUDA and WebGPU
received identical prepared samples, masks and palette. Every tuple component
and ANSI byte was compared without a tolerance change.

| Original image | Cells per fit | CUDA fits / WebGPU fits | Tiles / repeats | Changed cells / ANSI bytes, each fit |
|---|---:|---:|---|---|
| Holographic cloak, initial smoke | 1 | 1 / 1 | tile 1, once | 0 / 0 |
| Holographic cloak | 8×4 = 32 | 2 / 2 | tiles 7 and 11, once each | 0 / 0 |
| Forestry CRT | 8×4 = 32 | 2 / 2 | tile 7, twice | 0 / 0 |
| Bland blocks | 8×4 = 32 | 2 / 2 | tile 7, twice | 0 / 0 |
| Holographic boots | 8×4 = 32 | 2 / 2 | tile 7, twice | 0 / 0 |
| Colour blocks | 8×4 = 32 | 2 / 2 | tile 7, twice | 0 / 0 |

This is **11 fits / 321 cells per GPU backend**, 22 backend fits / 642 converted
cells overall, on six prepared datasets from five original images. The one-cell
tuple was `[141,8,0]` for CPU, CUDA and WebGPU. All repeated/tile-varied results
equal CPU exactly. CUDA recovered all 321 cells; zero certified-fast-path cells
were observed. All six reports have `scopedParityPassed:true` and
`cudaScopedParityPassed:true`, while retaining `qualificationAccepted:false`.

No stalls or new NVIDIA/Display driver warnings/errors were observed. Each
scope's driver checks and cleanup passed, probe pairs returned the same free
bytes, and no native worker remained. The final
[session-wide System-log query](gtx1650super-real-images/driver-final.json)
also found no such events from 13:55:33.428 through 13:59:26.542 UTC. This is a
bounded observation, not a sustained desktop-stability or TDR qualification pass.

## Measured costs

Pairs below retain run order. CUDA wall time includes process/context startup,
uploads, matching, bridge transfer and cleanup. WebGPU internal fit time excludes
device/pipeline creation and browser serialization; CPU fitting ran directly
in Node. Preparation is separately recorded, so these intervals do not form a
controlled end-to-end throughput comparison.

| Case | JS CPU fit ms | CUDA external fit wall ms | WebGPU internal fit ms |
|---|---:|---:|---:|
| Initial one cell | 6.77 | 243.75 | 11.50 |
| Holographic cloak, tiles 7 / 11 | 75.58 / 50.29 | 242.48 / 186.70 | 24.40 / 16.40 |
| Forestry CRT, two repeats | 28.51 / 51.94 | 275.34 / 209.67 | 25.20 / 24.50 |
| Bland blocks, two repeats | 30.98 / 54.35 | 271.43 / 198.49 | 22.90 / 23.70 |
| Holographic boots, two repeats | 30.23 / 57.29 | 267.50 / 194.61 | 23.60 / 27.10 |
| Colour blocks, two repeats | 28.62 / 56.26 | 250.60 / 194.21 | 26.60 / 21.20 |

For the 32-cell fits, CUDA kernel-event sums were 7.23–11.27 ms. Across all fits,
guard totals were 0.48–4.26 ms, recovery projection 0.07–0.57 ms and recovery
selection 1.01–6.45 ms. Maximum observed projection/selection sublaunch intervals
were 0.58 / 1.68 ms, respectively; these do not guarantee watchdog safety.
WebGPU external runner intervals for 32 cells were 141.86–336.69 ms and include
device/pipeline creation and serialization. Every fit creates a fresh backend;
cache-repeat observations are not persistent-context warm-kernel timings.

Native declared buffer sums were 42,256 bytes for one cell, 105,904 bytes for
tile 7 and 148,336 for tile 11. Each 32-cell CUDA fit uploaded 35,744 bytes and
read back 1,024 bytes, counting both guard inspection and final tuples. WebGPU
declared 57,536 bytes at tile 7 and 72,000 at tile 11 and read back 512 bytes.
Buffer sums and free-memory snapshots are not measured peak global residency.
No reserve/capacity declaration was lowered or inflated. CUDA did not establish
a performance benefit on these small jobs; all cells required recovery.

## Receipts, review and reproduction

[summary.json](gtx1650super-real-images/summary.json) retains aggregate counters,
scope limits, input/report SHA-256 identities, device snapshots and detailed
per-fit timing/memory/parity observations. Full prepared inputs and result JSONs
are committed alongside it for `one`, `holo`, `forest`, `bland`, `boots` and
`colour`. These small sample rasters are derived from the original-byte images
whose hashes remain in the manifest. Source-file hash checks reject stale
preparation scripts or mismatched installed core/font/image files.

Independent source review found no remaining supported material finding after
preparation script identities and failure receipts were improved. The reviewer
independently passed all 12 planning/image host tests without browser/GPU work.
Its final evidence audit recomputed CPU tuples and ANSI hashes from all six
prepared inputs and matched all 22 recorded backend fits. It also verified
receipt/source hashes, counters, table values and CI identities; no material
error was found. These review computations added no GPU work.
Local precommit host logs validate the bytes committed in `684a86d`:
[39 bridge/planning/image tests](gtx1650super-real-images/host-real-image-precommit.txt)
and [15 original plus 67 overlay tests](gtx1650super-real-images/host-real-image-app-precommit.txt).
The clean-source CI results above independently cover that exact commit.

After setup and restoring the source-bound normal worker with its receipts and
licenses, reproduce the first scope from repository root:

```powershell
.\setup.bat
npm install --prefix build/qualification-tools playwright@1.64.1 --no-audit --no-fund
node scripts/prepare_cuda_image.mjs build/qualification-tools/node_modules/playwright/index.mjs build/qualification/image-one.json holo-stealth-cloak-1024.png 1 1
node scripts/replay_cuda_fixtures.mjs build/ci-905db75/build/cuda/pnggpu_cuda_worker.exe build/qualification/image-one-result.json --fixture-file build/qualification/image-one.json --case image-holo-stealth-cloak-1024-1x1-4x8 --repeats 1 --tiles 1 --max-runs 2 --max-cells 2 --max-work 200000 --timeout-ms 10000 --webgpu build/qualification-tools/node_modules/playwright/index.mjs
```

After a responsive exact result with no new driver errors, prepare one 8×4
image and compare it within the same bounds used here:

```powershell
node scripts/prepare_cuda_image.mjs build/qualification-tools/node_modules/playwright/index.mjs build/qualification/image-small.json holo-stealth-cloak-1024.png 8 4
node scripts/replay_cuda_fixtures.mjs build/ci-905db75/build/cuda/pnggpu_cuda_worker.exe build/qualification/image-small-result.json --fixture-file build/qualification/image-small.json --case image-holo-stealth-cloak-1024-8x4-4x8 --repeats 1 --tiles 7,11 --max-runs 4 --max-cells 128 --max-work 8000000 --timeout-ms 10000 --webgpu build/qualification-tools/node_modules/playwright/index.mjs
```

The other four scopes use their exact manifest filenames, 8×4 geometry,
`--repeats 2 --tiles 7` and the same run/cell/work caps. Preserve source and worker
identities, stop on stalls or new driver errors and do not automate unbounded
repetition. Native admission may legitimately reject a busy 4 GiB desktop.

These results cover only tiny full-reference rasters at 4×8 sampling and the
original six/five search. The previous larger WebGPU discrepancies remain
separate and unresolved. Broader sample/candidate/real-image coverage, GTX
sanitizer instrumentation and isolated context-loss/low-memory/sustained-TDR
qualification remain gates; peak memory/energy and performance optimization are
unestablished. No production or sustained stability claim is made, and none of
the disruptive tests belongs on this interactive display GPU.
