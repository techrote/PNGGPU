# GTX 1650 SUPER — staged outputs through 80×40 characters

Recorded 4 November 2026. **All three selected output sizes matched CPU, CUDA
and WebGPU exactly. PR #2 remains draft.** This extends the previous
[8×4-character tests](GTX1650SUPER_REAL_IMAGES.md) with one ordinary real image,
not a full corpus or sustained-stability qualification. Read
[WDDM_RESILIENCE.md](WDDM_RESILIENCE.md) before further GPU work.

## Source and bounded progression

Every input and result records clean engineering source
`77ae23e10c8b5ae658e21af5905eaa0db50830a1`.
[CI run 41846396890](https://github.com/techrote/PNGGPU/actions/runs/41846396890)
passed all three jobs: application/integrity tests and Windows/Linux CUDA
compiler/native host checks. The normal worker remains the separately identified
`905db75cc8ae85671bfec49bcf433a64cb94d543` CI binary, SHA-256
`938ea7b9bf5ef509cd2551e6527322bd650c9c8151913ffe5152e838fa564b1e`.
Native sources are unchanged, and receipt/hash/source checks precede discovery.
This does not physically qualify the different binary compiled by the newer CI.
The worker's original source receipt, hash receipt and runtime licenses remain
under `build/ci-905db75/`. Compiler/provenance details are retained in
[the earlier GTX report](GTX1650SUPER_RESULTS.md).

The preparation default remains 64 characters. Larger stages require an
explicit `--max-preparation-cells N`, recorded and revalidated during replay.
Its absolute ceiling is 3,200 cells; outputs above 64 cells require 4×8 samples.
The native 2 GiB reserve, exact candidate search and recovery arithmetic,
driver-error stops, timeouts and cleanup protections were unchanged. Matching
preflight still includes every backend, tile choice and repeat.

Only the original `holo-stealth-cloak-1024.png` was used, with its manifest hash,
full-reference Canvas sampling, 218 glyphs, six/five color candidates and
pipeline depth one. Each stage ran once on CUDA and once on WebGPU. Progression
occurred only after the previous stage matched CPU and returned without stalls,
driver events or cleanup failures. Every fit used 16-cell tiles; the larger
output increased tile count, not the size of individual CUDA submissions.

| Output characters | Cells per fit | Preparation cap | Aggregate GPU-cell cap | Logical-work cap / actual |
|---|---:|---:|---:|---:|
| 16×8 | 128 | 128 | 256 | 15,000,000 / 14,976,000 |
| 32×16 | 512 | 512 | 1,024 | 60,000,000 / 59,904,000 |
| 80×40 | 3,200 | 3,200 | 6,400 | 375,000,000 / 374,400,000 |

Each scope allowed two backend fits, one repeat and a 10-second request/browser
operation timeout. Preparation performed zero matching runs. No full self-test,
cancellation exercise, pressure/fault injection, stress loop or machine-setting
change occurred. The later evidence commit changes no preparation/matching code.

## Parity, costs and memory

All tuples and ANSI bytes matched the independent JS CPU reference in all six
backend fits. Total: **three fits / 3,840 cells per GPU backend**, 7,680 converted
cells overall, 449,280,000 logical work visits. CUDA recovered all 3,840 cells;
no certified-fast-path cells were demonstrated. Every result retains
`qualificationAccepted:false` alongside true scoped parity results.

| Output characters | CPU fit ms | CUDA external fit wall ms | WebGPU external wall ms | WebGPU internal fit ms |
|---|---:|---:|---:|---:|
| 16×8 | 94.54 | 272.33 | 417.28 | 37.70 |
| 32×16 | 439.06 | 434.67 | 799.07 | 134.80 |
| 80×40 | 864.05 | 875.10 | 3,256.20 | 676.90 |

CUDA wall time includes native process/context initialization, local bridge,
uploads, kernels, decoding and cleanup. WebGPU external wall additionally
includes browser evaluation, device/pipeline creation and serialization;
internal fit excludes those costs. CPU ran directly in Node. Preparation was
separate. These single observations are not a controlled comparative benchmark
or evidence of a performance benefit. At 80×40, CUDA and direct CPU fitting took
about 0.875 and 0.864 seconds, respectively.

CUDA kernel-event sums were 18.73, 73.26 and 386.67 ms for the three stages.
For 80×40: guard 132.97 ms, recovery projection 12.18 ms, recovery selection
234.51 ms. Maximum observed CUDA projection/selection sublaunch intervals across
all stages were 0.45 / 1.81 ms. These are observations, not watchdog guarantees.

CUDA declared buffers were **201,376 bytes at every output size**, since all
fits reused 16-cell tiles. WebGPU declared 90,560 / 92,096 / 102,848 bytes.
For 80×40, CUDA uploaded 441,248 bytes and read back 102,400 bytes (guard inspection
plus final tuples); WebGPU read back 51,200 bytes. This is declared allocation
accounting, not peak global VRAM. Actual native admission still reserves
2,147,483,648 bytes against fresh reported free memory.

Actual hardware: GTX 1650 SUPER, ordinal 0, capability 7.5, watchdog enabled,
driver 616.92, CUDA runtime 12.8. All native probe pairs reported 3,441,950,720
free bytes before/after. Read-only initial NVIDIA inventory showed 4,096 MiB
installed and 3,350 MiB free. Chrome was 156.0.8078.80 and Playwright 1.64.1.
No stalls, new NVIDIA/Display warning/error events or cleanup failures were
observed, and no native worker remained. The final
[session System-log query](gtx1650super-staged-outputs/driver-final.json) also found
no such events from 14:19:31.247 through 14:22:03.976 UTC. This does not replace
sustained desktop-stability, sanitizer or TDR qualification.

## Evidence and reproduction

[summary.json](gtx1650super-staged-outputs/summary.json) retains scope counters,
input/result SHA-256 identities, hardware, parity and per-stage costs. Complete
prepared inputs and full result reports are beside it for all three sizes.
[holo-80x40.ans](gtx1650super-staged-outputs/holo-80x40.ans) is the actual CUDA
selection encoded by the original ANSI encoder: 26,144 bytes, CP437 plus SGR,
with 80-column wrapping. Its SHA-256
`9db57e7fc6d7ed7bf17c9769304de192ce3ae4fcebb2cc2e8b0890def8038bd7`
equals the CPU acceptance-byte hash. It should be viewed with CP437/ANSI support
at 80 columns; it is not UTF-8 text.

Source review independently passed all 14 planning/image tests and seven
additional cap/argument assertions without browser/GPU work. The combined
[local host log](gtx1650super-staged-outputs/larger-host-precommit.txt) passed
41 bridge/planning/image tests on the bytes committed in `77ae23e`. CI above
independently validates that exact source, including the unchanged original CPU
and overlay tests and native checks.

Final evidence review independently recomputed CPU results for all three inputs
and matched every tuple and ANSI hash against both backends, including the
exported 80×40 ANSI file byte for byte. It verified hashes, counters, source/
worker identities, table values, driver records and CI; no material error was
found. These review computations added no browser/GPU work.

Run setup and preserve the matching normal worker's receipts/licenses. After
the 16×8 and 32×16 stages pass responsively, the 80×40 reproduction is:

```powershell
node scripts/prepare_cuda_image.mjs build/qualification-tools/node_modules/playwright/index.mjs build/qualification/image-80x40.json holo-stealth-cloak-1024.png 80 40 --max-preparation-cells 3200
node scripts/replay_cuda_fixtures.mjs build/ci-905db75/build/cuda/pnggpu_cuda_worker.exe build/qualification/image-80x40-result.json --fixture-file build/qualification/image-80x40.json --case image-holo-stealth-cloak-1024-80x40-4x8 --repeats 1 --tiles 16 --max-runs 2 --max-cells 6400 --max-work 375000000 --timeout-ms 10000 --webgpu build/qualification-tools/node_modules/playwright/index.mjs
```

For the preceding stages, substitute dimensions/case names 16×8 and 32×16,
preparation caps 128 / 512, aggregate cell caps 256 / 1,024 and work caps
15,000,000 / 60,000,000. Keep one fit per backend, tile 16, 4×8 samples and
six/five candidates. Stop on stalls, driver errors or CUDA/CPU mismatch; do not
lower the reserve or inflate capacity to force admission.

The next ordinary coverage gate is the other four original images at 80×40,
followed by repeat/tile variation at that size before another size increase.
Previous larger WebGPU discrepancies, GTX sanitizer instrumentation, mixed-driver/
device coverage and isolated lost-context/low-memory/sustained-TDR gates remain
open. No production-readiness or sustained-stability claim is made.
