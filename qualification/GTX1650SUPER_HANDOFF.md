# Continue PR #2 on the GTX 1650 SUPER computer

Recorded 4 November 2026. Repository: https://github.com/techrote/PNGGPU
PR: https://github.com/techrote/PNGGPU/pull/2
Branch: `feat/optional-cuda-turing`. **Keep PR #2 in draft; do not merge.**

Continuation completed a bounded first GTX pass. Read
[GTX1650SUPER_RESULTS.md](GTX1650SUPER_RESULTS.md) for the explicit limited CLI,
hardware/binary provenance and independent CPU/CUDA/WebGPU comparisons. The
historical starting instructions below do not imply permission for larger or
disruptive work.

## Checkpoint and source authority

Latest engineering checkpoint before this documentation handover:
`a23cdd6a178fd65658635ec36de9cabbbbafd5a5`.
[Its CI passed all three jobs](https://github.com/techrote/PNGGPU/actions/runs/41761326123).
Fetch the actual current branch and main before working; this SHA is historical
provenance, not an instruction to reset or discard later commits.

Runtime parity recovery was implemented at
`01fc878e7e1741644d6ceb99f2321cd78adb03dd`. The exact source/worker/compiler
identities of each measurement are preserved in the qualification reports.

## Completed work

- Optional native C++17/CUDA backend targets sm_75 with compute_75 PTX.
  Compatible-device selection skips older devices such as V100; explicit
  ordinals remain supported. WebGPU is still the default.
- Arithmetic mode `float32-guarded-binary64`: float32 projection, conservative
  outward-rounded CPU-objective decision intervals, and binary64 GPU recovery
  for ambiguous shortlist, palette and selection decisions. Preserve the exact
  CPU expression grouping, float32 statistics, strict comparisons, stable ties,
  32-glyph shortlist and requested foreground/background candidate counts.
- Recovery stays on GPU and reuses at most 32 MiB / 1,024 cells. Native admission
  and browser estimates include its storage. Pipeline depth remains one.
- Fixed active cancellation and repeat-result qualification. Bridge framing,
  origin restrictions, concurrency, process cleanup and memory admission remain.
- On TITAN RTX, both local and CI builds matched the independent CPU's tuples
  and ANSI bytes in all five modest hardmodes, partial tiles and both 512x512
  workloads (1x1 and 4x8 samples), including repeated/tile-varied execution.
- CI-worker regression package: 81 runs. GPU self-test: 45 cases / 2,926 cells,
  with 206 certified decisions checked against unconditional binary64 GPU output.
  Native host tests with independent golden frames: 12,898 checks. Host CI also
  covers 15 original tests, 67 overlay tests and 27 bridge tests.
- The real-image guard recovered every cell. No certified-fast-path or CUDA-
  over-WebGPU performance benefit is established. The unchanged WebGPU shader
  still differs from CPU by 364 and eight cells in the large cases. Strict joint
  `accepted:false` is preserved; `cudaAccepted:true` reports CUDA-specific parity.

## Critical stability history

Read [WDDM_RESILIENCE.md](WDDM_RESILIENCE.md) before any GPU experiment.

On the TITAN machine, the NVIDIA debugger prerequisite was enabled via elevated
registry change: HKLM\SOFTWARE\NVIDIA Corporation\GPUDebugger\EnableInterface=1.
Compute Sanitizer12.8.93 then instrumented the exact 0e8993d CI worker's complete
native self-test with zero errors. This setting is local to that PC; it does not
transfer through Git, and must not be silently applied on another machine.

An intentional context-fault / OOM / VRAM-pressure development experiment
subsequently caused two user-observed PC lockups. All workers were stopped.
Windows recorded nvlddmkm event153; a full system TDR was not established. The
pressure allocation left only 1,958,199,296 bytes free, below the intended 2 GiB
floor. Eighteen completed exact-parity stress conversions do not constitute a
stability pass. Desktop stability failed; sustained TDR qualification is incomplete.

Fault-worker compilation defaults OFF. The separate fault worker now refuses
context/pressure injection on watchdog-enabled devices. The resilience runner
also requires an explicit disruption acknowledgement. **Do not remove or bypass
these protections, run that runner, inject faults, exhaust VRAM, or change TDR
settings on the GTX computer's interactive display GPU.** A different PC or GPU
does not itself make these experiments safe.

## GTX 1650 SUPER constraints and first work

The GTX 1650 SUPER is a Turing card normally supplied with 4 GB VRAM; verify the
actual name, ordinal, capability, memory and driver on the machine rather than
assuming support or borrowing TITAN measurements. [NVIDIA specifications](https://www.nvidia.com/en-us/geforce/graphics-cards/compare/).

The native 2 GiB free-memory reserve must remain intact. On this smaller card,
ordinary desktop/browser allocations may legitimately prevent CUDA admission.
Do not lower the reserve or falsify declared capacity to make tests pass. The
workbench's existing VRAM-minus-4-GiB warning policy can warn for every positive
estimate on a 4-GiB card; this is distinct from the native free-memory hard gate.

Start with read-only device discovery, host tests and matching-worker provenance.
Then add or use a narrowly scoped, ordinary one-cell parity smoke test. At handover,
`replay_cuda_fixtures.mjs` runs all 81 cases, and `qualify_cuda.mjs --large` runs
both large suites; neither is a one-cell smoke mode. Implement explicit case,
repeat, tile and work limits if necessary before using them on the smaller PC.
Advance only after small work returns exact CPU results and the desktop remains
responsive; stop and record any stalls or new driver errors.

Git does not carry ignored `PNG2ANSI/`, `build/`, `.cuda-toolchain/` or local raw
receipts. Run setup, install required tools locally, and build a matching normal
worker or download an exact-source CI artifact. Preserve SOURCE_COMMIT.txt,
worker-sha256.json and licenses. Do not use an older float32-only worker.

## Copyable prompt for Codex

Continue development of https://github.com/techrote/PNGGPU PR #2 on the existing
branch feat/optional-cuda-turing. This machine has a GTX 1650 SUPER. Keep the PR
in draft and do not merge. Read qualification/GTX1650SUPER_HANDOFF.md first,
then qualification/WDDM_RESILIENCE.md, qualification/RECOVERY.md,
overlay/docs/CUDA_BACKEND.md, native/cuda/README.md and repository instructions.

Fetch current PR head, main, checks and review history. Preserve newer work;
do not reset to a historical checkpoint or create a competing backend/branch.
The pre-handover checkpoint a23cdd6a178fd65658635ec36de9cabbbbafd5a5 passed CI
run41761326123. Runtime recovery at01fc878 restored exact CPU parity on tested
TITAN RTX workloads. Preserve the original CPU objective, strict ties, candidate
counts and float32-guarded-binary64 GPU recovery. WebGPU remains the default.

First inventory this computer's actual GPU capability, ordinal, total/free VRAM,
driver, toolkit/compiler, Node and browser. Reconstruct the pinned application
and use a source-matched normal worker with recorded SHA-256. Run host checks.
Preserve the native2GiB reserve and accurate capacity declarations; admission
failure on a4GB display card is legitimate, not a reason to weaken safeguards.

Prioritise a narrowly bounded qualification workflow: implement explicit
single-case/repeat/tile/work limits in the acceptance tools if missing, start
with one saved failing cell and independent CPU tuple/ANSI comparison, then
small ordinary conversions. Preserve exact criteria and report recovery rate,
timings, allocations and device identity. Separate GTX evidence from TITAN data.

Do not run qualify_cuda_resilience.mjs, inject CUDA traps, exhaust VRAM, disable
watchdog protections, bypass display-GPU restrictions, or start sustained/large
stress on this interactive PC. Those experiments caused two desktop lockups on
the previous machine. Stop immediately on a stall or new GPU driver error.
Read-only inspection and ordinary bounded matching are the starting scope.
Inspect sanitizer prerequisites; discuss any necessary elevated machine setting
before changing it on this computer. A prior sanitizer pass applies only to its
recorded TITAN source/binary, not automatically to the GTX machine.

Continue actionable engineering and independent review within these limits.
Commit/push to the existing PR branch, regenerate PACKAGE_MANIFEST.json, record
exact-source tests/CI and hardware evidence under qualification/, and keep PR#2
draft. Finish with exact commit, changes, CPU/WebGPU/CUDA comparisons, measured
costs, remaining gates and reproduction instructions. No production-ready or
sustained-TDR claim without the missing evidence.
