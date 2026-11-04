# CUDA precise recovery — TITAN RTX evidence

**CUDA parity blocker repaired on the tested workloads. PR #2 remains draft.**
Overall disposition: **CONDITIONAL — PHYSICAL QUALIFICATION REQUIRED**.

Implementation source: `01fc878e7e1741644d6ceb99f2321cd78adb03dd`.
[Implementation CI](https://github.com/techrote/PNGGPU/actions/runs/41757233492)
passed all three jobs: Windows application/bridge tests, Windows CUDA
compilation/native tests and Linux CUDA compilation/native tests. It includes
15 original application tests, 67 overlay tests, 27 bridge tests, package/image
integrity checks and independent CPU golden-frame regeneration. Native tests
with golden frames pass 12,898 checks locally.

## Implementation and proof boundary

The existing float32 projection remains. Conservative outward-rounded intervals
model the original CPU expression tree and certify complete retained shortlist
ordering/membership, palette ordering/membership and the winning tuple against
every candidate. Any overlap requests recovery; no mismatch tolerance changes.

Ambiguous cells rerun projection and the original 32-glyph/candidate search on
the GPU in binary64. Recovery preserves the CPU's stored float32 statistics,
per-channel divisions and SSE updates, strict comparisons and first-winning
ties. This is an explicit arithmetic-mode change requested for parity recovery;
it is not CPU fallback. No search reduction, FP16, fast-math or FMA was added.
The wire arithmetic mode is `float32-guarded-binary64`; old workers are rejected.

Recovery chunks reuse at most 32 MiB / 1,024 cells of double projections.
Admission and browser estimates include that allocation. Both recovery stages
have bounded launches. Recovery counts/reasons, component times, launch maxima
and both device result readbacks are reported. See the
[native interval proof and operation-order notes](../native/cuda/README.md#precise-recovery-and-certification).

## Exact physical results

Device: NVIDIA TITAN RTX, capability 7.5, ordinal 0, 24 GiB, WDDM timeout enabled;
driver 581.80, CUDA runtime 12.8. Browser: Chrome 156.0.8078.80.

The full browser run began from clean implementation source and checked all
installed overlay bytes and original image hashes. It used a local NVCC
12.8.93 / MSVC 19.38.33145 build of that source, with worker SHA-256
`2f8d1bb489bbe609a0a6cdb1b57d89aabafd4a63d90a302ef6c1f3bbd2f5d9ac`.
The distinct CI-built Windows worker is independently tested below; the reports
do not conflate their binary identities.

| Workload | CUDA vs CPU changed cells | CUDA vs CPU ANSI mismatches | WebGPU vs CPU changed cells |
|---|---:|---:|---:|
| Five hardmodes, each 80×40 / 4×8 | 0 | 0 | 0 |
| Partial tail, 17×9 / 4×8 | 0 | 0 | 0 |
| 512×512 / 1×1 | 0 | 0 | 364 |
| 512×512 / 4×8 | 0 | 0 | 8 |

The complete suite was then repeated with the independently compiled **Windows
CI worker** against clean application source
`d31b0763b633ef432a25307e809854471b54c1d6`. It again passed every CUDA-versus-CPU
tuple and ANSI comparison in all eight jobs and three repetitions, including
both 512×512 cases; cancellation/recovery also passed. Its native sources are
identical to the worker's source `01fc878`. The separate
[CI-binary full-suite report](recovery-ci-full-d31b076.json) preserves both
source identities and the binary hash. This validates the local and CI compiler
builds without conflating their measurements.

Every backend ran three fits, including a 64-cell tile variant. Every CUDA
repeat also matched CPU exactly and retained identical tuples. CUDA recovered
all cells in these real-image cases: the conservative guard does not currently
provide a certified fast path for this atlas. This is recorded, not presented
as a performance success.

The former material failure at cell 105420 now returns `[182,8,0]`, matching
CPU, rather than historical CUDA `[141,8,5]`. Its direct reconstruction SSE is
restored from 69,283.918012 to 29,571.557975. Other saved precision/tie failures
also match CPU. WebGPU's existing shader and default selection are unchanged.

`cudaAccepted:true` in the report requires all CUDA cell/ANSI/repeat comparisons
and device/cancellation gates. The pre-existing strict aggregate remains
`accepted:false` because it includes the unchanged WebGPU mismatches. No
comparison threshold or aggregate acceptance criterion was relaxed.

Real cancellation returned `AbortError`, allowed another 128-cell conversion
and returned reported free memory to the same 24,458,035,200-byte snapshot.
This verifies recovery, not peak global residency or a universal leak proof.

## CI worker and independent regressions

The [Windows CI worker](https://github.com/techrote/PNGGPU/actions/runs/41757233492/artifacts/13288457576)
has SHA-256 `8d3b09bc1150963d4bbda3c3a74fee002aeea46849acc64ca9102d4b502ca2cf`.
Its real TITAN RTX regression package passed **81 runs**, covering every saved
physical failure, deterministic sample sizes 1×1 through 32×64, candidate pairs
1/1, 6/5 and 12/8, and tile sizes 1, 3 and 64. Every tuple and ANSI byte matched
the independent JavaScript CPU implementation.

Its physical native self-test passed **45 cases / 2,926 cells**, including
**206 certified decisions checked against unconditional binary64 GPU results**.
The other 2,720 cells requested recovery. All actual GPU tuples also matched
the CPU-grouped native binary64 helper and repeated allocation reuse passed.
That helper is shared code, so the independent JavaScript comparisons remain
the separate reconstruction acceptance evidence.

Both historical defects are native CTest regressions. The binary fixture frames
are regenerated from the independent JS CPU winners and checked in CI, so the
native tests do not merely compare two copies of native arithmetic.

## Measured costs and limitations

These are first-fit observations after fitter creation; CUDA process/context
startup is included, while WebGPU pipeline creation is excluded. Preparation,
ANSI encoding, cold/cache repeats, transfer volumes and stages remain separate
in the report. CPU is the direct JavaScript matching reference, without worker
startup. No CUDA-over-WebGPU speedup is claimed.

| Workload | CPU fit ms | CUDA fit ms | CUDA kernel sum ms | Native declared buffer bytes |
|---|---:|---:|---:|---:|
| Five 80×40 cases, range | 363.3–511.0 | 219.1–270.0 | 12.2–16.7 | 10,883,632 |
| 512×512 / 1×1 | 10,401.8 | 811.5 | 417.6 | 64,623,112 |
| 512×512 / 4×8 | 27,652.5 | 4,370.1 | 990.2 | 66,681,760 |

For 512×512 / 4×8: preparation 130.9 ms, native initialization 123.3 ms,
host-clock upload including atlas 8.84 ms, readback 2.71 ms. GPU guard 265.77 ms,
binary64 recovery projection 168.01 ms, recovery selection 511.38 ms. Throughput
was about 59,986 cells/s for the observed fit. Both guard inspection and final
results contribute to the 8,388,608 device-readback bytes; HTTP returns only
final tuples. Copy and kernel intervals overlap in the wall-time hierarchy.

Measured maximum projection/selection sublaunch intervals in the local full
suite were 1.40 / 3.13 ms. The CI-worker run records its own maxima separately.
This is workload-specific
evidence, not a TDR guarantee for all supported searches. The 64-cell stress
variant is much slower. Pipeline depth remains one. No occupancy, integrated
energy or peak total VRAM claim is made; declared buffer sums exclude runtime,
context and compiler-managed local memory.

## Independent review and remaining gates

Independent exact-source review found no remaining supported material source
defect. It checked the interval proof, CPU grouping, stable ordering, chunk
indexing, memory admission and regression provenance. Supported review findings
were fixed: both device readbacks are counted, zero recovery capacity is
rejected, certified-case coverage is asserted, and independent golden frames
cover both historical defects. The reviewer independently ran 27 focused JS
tests, 12,898 native checks, golden regeneration and the 78-file manifest check.

Keep the PR in draft. Remaining physical gates include successful Compute
Sanitizer instrumentation (the earlier WDDM debugger initialization prerequisite
is still unmet), additional Turing/mixed-device and driver tests, context-loss,
low-memory and sustained TDR stress. Broader proof/physical coverage and
performance profiling are still required before production acceptance. The
unchanged WebGPU CPU-parity discrepancy remains a separate baseline limitation.

## Evidence and Windows reproduction

- [Full-suite summary and source hashes](recovery-01fc878.json).
- [CI-worker exact CPU regressions](recovery-ci-01fc878-fixtures.json).
- [CI-worker GPU self-test](recovery-ci-01fc878-selftest.json).
- [CI-worker complete browser suite](recovery-ci-full-d31b076.json).
- Local full per-tile report: `build/qualification/recovery-01fc878.json`; the
  committed summary retains its SHA-256, all comparison results, stage totals,
  tile counts, launch maxima and first/last tile details.

Use the matching CI worker with its provenance files, or build the same source.
From the repository root after `setup.bat`:

```powershell
node scripts/replay_cuda_fixtures.mjs build/cuda/pnggpu_cuda_worker.exe build/qualification/recovery-fixtures.json --suite --tiles 1,3,64 --max-runs 81 --max-cells 945 --max-work 10000000000
node scripts/qualify_cuda.mjs build/cuda/pnggpu_cuda_worker.exe build/qualification-tools/node_modules/playwright/index.mjs build/qualification/recovery.json "C:\Program Files\Google\Chrome\Application\chrome.exe" --large
```

These are complete historical-suite reproduction commands, not the GTX
interactive-PC starting scope. The bounded fixture CLI now requires explicit
selection and limits; its scoped results never assert full qualification. Read
[the GTX handoff](GTX1650SUPER_HANDOFF.md) and
[the WDDM restrictions](WDDM_RESILIENCE.md) first.

The full browser runner can exit with failure because its strict all-backend aggregate
includes WebGPU. Inspect both `cudaAccepted` and the unchanged detailed
comparisons; do not label the joint run exact. See the
[CUDA setup guide](../overlay/docs/CUDA_BACKEND.md#physical-qualification) for
Playwright installation, worker provenance and full prerequisites.
