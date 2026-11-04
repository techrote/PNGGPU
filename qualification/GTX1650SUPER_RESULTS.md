# GTX 1650 SUPER bounded qualification — 4 November 2026

**Scoped CUDA parity passed. Full qualification remains incomplete; PR #2 stays
draft.** No production-readiness, sustained-TDR or performance benefit is claimed.
Read [WDDM restrictions](WDDM_RESILIENCE.md) before further GPU work.

Subsequent [bounded small real-image comparisons](GTX1650SUPER_REAL_IMAGES.md)
cover all five original images at 8×4 cells. They retain separate source,
binary and timing identities from this initial saved/synthetic-input session.

## Source and hardware

Engineering/application source: `905db75cc8ae85671bfec49bcf433a64cb94d543`.
The four subsequent GPU reports below all record that clean checkout. The first
one-cell development run records its dirty `c60d79d` provenance separately.
The following evidence/package commit changes no matching or runner code.
Main was fetched at `8b61018b27b890503b968d5937b08e858eea707a`; current PR head
was fetched at `c60d79d34523f2bcec3a3d8abaf4832666e98387` before implementation.
No reset, alternate branch or backend was created. GitHub returned no review
submissions, inline review threads or discussion comments at intake.

- Actual device: NVIDIA GeForce GTX 1650 SUPER, CUDA ordinal 0, capability 7.5,
  active display, watchdog enabled, NVIDIA driver 616.92.
- NVIDIA inventory: 4,096 MiB installed; initially 3,377 MiB free. Runtime reports
  total 4,294,508,544 bytes and free 3,441,950,720 bytes at all recorded probe pairs.
  These are separate API snapshots, not peak residency measurements.
- Windows 11 Pro build 26200; Node 24.21.0; Chrome 156.0.8078.80;
  Playwright 1.64.1; CMake 4.4.3; local host-only compiler MSVC 19.44.35228.0.
  [Hardware inventory](gtx1650super/gtx-hardware-905db75.json).
- CUDA Toolkit and Compute Sanitizer were not found locally. Normal workers
  were downloaded from source-bound CI artifacts; their runtime linkage is
  static. Windows CI used NVCC 12.8.93 / MSVC 19.44.35229.0, with native sm_75 and
  compute_75 PTX and the existing strict arithmetic flags.
- The NVIDIA GPUDebugger registry key is absent. No debugger prerequisite,
  watchdog or TDR setting was changed. GTX sanitizer instrumentation is pending.

Both artifact trees remain intact locally, including `SOURCE_COMMIT.txt`,
`worker-sha256.json` and CUDA runtime licenses. The runner checked receipt hashes
and native-source equality before discovery. Native sources are byte-equivalent
in Git between `c60d79d` and `905db75`; these distinct binaries are not conflated:

| Worker source | SHA-256 | CI |
|---|---|---|
| `c60d79d34523f2bcec3a3d8abaf4832666e98387` | `27fc958c434aaf07c8d7b31fba33dbd87c0062e2848e952b274045cef5be071c` | [41834986300](https://github.com/techrote/PNGGPU/actions/runs/41834986300) |
| `905db75cc8ae85671bfec49bcf433a64cb94d543` | `938ea7b9bf5ef509cd2551e6527322bd650c9c8151913ffe5152e838fa564b1e` | [41838854560](https://github.com/techrote/PNGGPU/actions/runs/41838854560) |

Both CI runs passed all three jobs. The second Windows artifact is
[13327173481](https://github.com/techrote/PNGGPU/actions/runs/41838854560/artifacts/13327173481).
The first is
[13324153393](https://github.com/techrote/PNGGPU/actions/runs/41834986300/artifacts/13324153393).

## Changes and independent review

`replay_cuda_fixtures.mjs` now requires exact `--case` names or explicit `--suite`.
Positive safe-integer repeat/tile/run/cell/work limits are validated before GPU
contact. BigInt aggregation includes both backends, every tile choice and every
repeat. Defaults admit a single converted cell. Work accounting includes full
precise recovery and the native shortlist/candidate work model; logical visits
are neither FLOPs nor a time guarantee. No hidden self-test, cancellation or
failure replay is added. The full browser runner remains outside this scope.

Requests and browser work time out, and later fits stop on a CUDA mismatch,
stall or new NVIDIA/Display warning/error. Windows log-query failures stop the
scope. Cleanup attempts are independent and bounded; failures retain a receipt,
force scoped parity false and prevent a subsequent device probe. Optional
WebGPU comparison uses identical saved bytes and atlas. Scoped reports always
retain `qualificationAccepted:false`; no lifecycle or full-suite gate is waived.

An independent reviewing agent performed no GPU work. Its findings about
selection work accounting, bridge timeout option names, browser evaluate timeout,
cleanup failures and probes after cleanup stalls were fixed before `905db75`.
It reported no remaining supported material finding in this bounded workflow.
It independently passed seven host tests and 13 additional planning assertions.
Its final evidence audit checked the receipt totals, timing/memory tables,
source hashes, distinct worker identities and CI claims, and independently ran
the 12,898-check native host executable; no material error remained.
Batch-file changes also normalize the installer's pre-existing CRLF Git blob;
installer behavior is unchanged.

## CPU, CUDA and WebGPU results

Tests began with the saved material failure, then a deterministic ordinary
17-cell / 4×8 sample conversion with 40 glyphs and six/five color candidates.
The saved failure uses all 218 original atlas glyphs. CUDA/CPU comparisons use
the independent original JavaScript objective and compare every tuple component
and every ANSI byte. Original grouping, strict ties and candidate counts remain.

| Clean source `905db75`, worker | Scope | CUDA vs CPU cells / ANSI bytes | WebGPU vs CPU cells / ANSI bytes |
|---|---|---|---|
| `c60d79d` worker | saved cell 105420, one fit/backend | 0 / 0 | 1 / 2 |
| `c60d79d` worker | 17 cells, tiles 1 and 3, two repeats each/backend | 0 / 0 in all four | 0 / 0 in all four |
| exact `905db75` worker | saved cell 105420, one CUDA fit | 0 / 0 | not rerun |
| exact `905db75` worker | 17 cells, tile 3, two CUDA repeats | 0 / 0 in both | not rerun |

The saved tuple is CPU/CUDA `[182,8,0]`; unchanged WebGPU returns `[141,8,5]`.
Its strict joint scoped parity result is false; CUDA scoped parity is true.
The small case passes joint scoped parity. No acceptance tolerance changed.

All GPU work in this session totals **nine CUDA fits / 105 cells** and **five
WebGPU fits / 69 cells**, including the first dirty-source one-cell smoke.
All 105 CUDA cells requested recovery; zero certified fast-path decisions were
demonstrated. No new NVIDIA/Display warning/error was recorded by per-fit checks,
no observed stall occurred, cleanup passed and no native worker remained.
This short bounded observation is not a desktop-stability or sustained-TDR pass.

## Costs and memory

The exact `905db75` CI worker measured:

| Workload | Direct JS CPU ms | CUDA fit wall ms | CUDA kernel sum ms | Declared native buffer bytes |
|---|---:|---:|---:|---:|
| saved one cell | 3.89 | 196.99 | 2.34 | 42,256 |
| 17 cells, tile 3, first fit | 11.86 | 209.97 | 7.22 | 12,208 |
| 17 cells, tile 3, repeat | 13.27 | 217.18 | 6.78 | 12,208 |

The saved-cell CUDA initialization was 153.53 ms and cleanup 34.52 ms; guard
0.50 ms, recovery projection 0.10 ms, recovery selection 1.26 ms. For the two
17-cell fits, guard was 0.76–0.80 ms, recovery projection 0.29–0.31 ms and
recovery selection 5.11–5.56 ms. Those fits upload 8,192 bytes and read back
544 bytes each; both guard inspection and final result readbacks are counted.
Per-tile intervals and sublaunch counts are retained in full JSON.

The earlier `c60d79d` binary had separate one-cell wall observations of 209.49 ms
(dirty-source initial smoke) and 240.35 ms (clean three-backend comparison).
Its 17-cell CUDA observations ranged 195.67–316.03 ms; declared native buffers
were 8,080 bytes for tile 1 and 12,208 for tile 3. These are separate runs.
WebGPU internal fit times were 15.70 ms for the saved cell and 18.50–54.70 ms
for the small fits. Its external runner wall intervals additionally include
browser evaluation, device/pipeline creation and result serialization. CPU ran
directly in Node. These timings do not establish a CUDA performance benefit.

Native admission still enforces a 2,147,483,648-byte free-memory reserve. Probe
pairs returned the same 3,441,950,720 free bytes after cleanup. This is not a
continuous minimum-free or peak-global-VRAM measurement. No declared capacity
was inflated; no UI warning, native gate, fault-worker restriction, default
backend, matching arithmetic or pipeline depth was changed. Admission failure
on a busy 4 GiB desktop remains legitimate.

## Tests, receipts and reproduction

Clean `905db75` host validation passed 15 original tests, 67 overlay tests,
27 bridge tests, seven bounded-workflow tests, 12,898 native checks, independent
golden-frame regeneration and the 95-file package manifest. CI also built and
tested the native sources on Windows and Linux. Committed receipts:

- [Initial dirty-source smoke](gtx1650super/gtx-first-cell.json).
- [Clean saved-cell CPU/CUDA/WebGPU comparison](gtx1650super/gtx-saved-cell-905db75.json).
- [Clean small CPU/CUDA/WebGPU repeats and tiles](gtx1650super/gtx-small-905db75.json).
- [Exact CI-worker saved cell](gtx1650super/gtx-exact-ci-cell-905db75.json).
- [Exact CI-worker small repeats](gtx1650super/gtx-exact-ci-small-905db75.json).
- [Application test log](gtx1650super/host-app-905db75.txt),
  [bridge/limit test log](gtx1650super/host-bridge-limits-905db75.txt),
  [native CTest log](gtx1650super/host-native-905db75.txt).

After setup, restore the exact artifact tree and preserve its licenses. Host
checks and the first bounded CUDA reproduction from repository root:

```powershell
.\setup.bat
npm test --prefix PNG2ANSI
node --test tests/cuda_bridge.test.mjs tests/cuda_fixture_plan.test.mjs
cmake -S native/cuda -B build/host -G "Visual Studio 17 2022" -A x64 -DPNGGPU_ENABLE_CUDA=OFF -DBUILD_TESTING=ON
cmake --build build/host --config Release --parallel 4
ctest --test-dir build/host -C Release --output-on-failure
node scripts/generate_cuda_regressions.mjs --check
python scripts/package_manifest.py --check
gh run download 41838854560 --repo techrote/PNGGPU --name pnggpu-cuda-Windows-905db75cc8ae85671bfec49bcf433a64cb94d543 --dir build/ci-905db75
node scripts/replay_cuda_fixtures.mjs build/ci-905db75/build/cuda/pnggpu_cuda_worker.exe build/qualification/one-cell.json --case historical-4x8-cell-105420 --repeats 1 --tiles 1 --max-runs 1 --max-cells 1 --max-work 100000 --timeout-ms 10000
```

Only after a responsive exact small result and no new driver errors:

```powershell
node scripts/replay_cuda_fixtures.mjs build/ci-905db75/build/cuda/pnggpu_cuda_worker.exe build/qualification/small.json --case random-4x8-6-5 --repeats 2 --tiles 3 --max-runs 2 --max-cells 34 --max-work 500000 --timeout-ms 10000
```

For the earlier identical-input WebGPU comparison, install
`playwright@1.64.1` under `build/qualification-tools`, use the preserved `c60d79d`
artifact, add `--webgpu build/qualification-tools/node_modules/playwright/index.mjs`
and double the aggregate caps. The report records Chrome and NVIDIA/Turing
adapter identity. Artifact downloads expire after 30 days; rebuild the recorded
source with the pinned CI toolchain when unavailable.

Remaining gates: GTX sanitizer instrumentation after discussing any elevated
prerequisite; broader real-image, candidate and sample coverage; mixed-device
ordinal/driver coverage; isolated context-loss, low-memory and sustained-watchdog
qualification; peak total residency/energy and profiling. The original TITAN
results remain separate, and its failed desktop stability experiment remains
unresolved. Do not run the resilience runner or pressure/fault/stress tests on
this interactive display GPU.
