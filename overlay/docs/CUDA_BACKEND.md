# Optional CUDA backend — TITAN RTX / RTX 20-series

PNGGPU can run its photographic glyph matcher through either the existing
WebGPU backend or an optional local CUDA worker. **WebGPU remains the default.**
CUDA is explicitly selected in the workbench; it never silently falls back to
WebGPU or CPU after an error.

The primary targets are **NVIDIA TITAN RTX and RTX 2060, 2070, 2080 and 2080 Ti,
including Turing variants**. These are compute capability 7.5 devices. The build
contains native `sm_75` code and `compute_75` PTX. A browser cannot launch native
CUDA directly: the optional Node.js server connects the workbench to the worker
on the same localhost origin.

## Windows quick start

Prerequisites for building:

- Windows 11 x64 and a compatible NVIDIA display driver.
- Node.js 22 or newer; CI uses Node 24. The CUDA bridge requires Node even if
  normal WebGPU startup uses Python.
- CMake 3.21+ on PATH.
- Visual Studio 2022 with the **Desktop development with C++** workload.
- NVIDIA CUDA Toolkit with Visual Studio integration. The compiler baseline
  used by CI is **CUDA 12.8.1 / NVCC 12.8.93**.

From a checkout of this change:

1. Run **`build-cuda.bat`**. It compiles the worker and runs native host tests.
2. Run **`start-cuda.bat`**. It refreshes the pinned PNG2ANSI installation and
   overlay, then starts the optional local bridge on port 8000.
3. Open `http://127.0.0.1:8000/experiments/webgpu/photographic.html?backend=cuda`.
   The CUDA launcher opens this address in your default browser on Windows.
4. Enter the selected GPU's installed VRAM — **24 GiB for TITAN RTX** — and
   choose an image. Start with 80 × 40 cells, 4 × 8 samples, six foreground and
   five background candidates. Enable **Compare against CPU** for the first run.
5. Check the reported cell differences and ANSI-byte mismatches, then save the
   benchmark JSON. Increase workload only after the small case succeeds.

Do not run the normal and CUDA servers on the same port simultaneously. Stop
the first with Ctrl+C, or choose another port:

```bat
start-cuda.bat 8001
```

To choose CUDA device ordinal 1 explicitly:

```bat
start-cuda.bat 8000 1
```

Without that second argument, the worker selects the first usable GPU with
compute capability at least 7.5. It skips a V100 in a mixed TITAN RTX/V100 system.
The capability report and benchmark receipt show the actual model and ordinal.
CUDA ordinals follow the runtime's enumeration and are not necessarily Windows
Task Manager's GPU numbers.

The existing `start.bat` still starts the ordinary WebGPU workbench and requires
no CUDA compiler, CUDA worker or CUDA-capable GPU.

## Using a CI-built worker

The `PNGGPU validation` workflow compiles Windows and Linux workers on hosted
CPU runners and uploads an artifact whose name contains the source SHA. This
is compiler validation, not a physical GPU test. Use an artifact from the same
commit as your checkout.

For the Windows artifact, put `pnggpu_cuda_worker.exe` in `build\cuda\` (or
`build\cuda\Release\`) and retain the accompanying CUDA runtime license files.
Then run `start-cuda.bat`. Building locally is unnecessary when using a matching
worker, but Node, the NVIDIA display driver and the current **Microsoft Visual
C++ v14 x64 Redistributable** are still required. CUDA runtime linkage is static;
the MSVC C++ runtime uses the normal shared `/MD` linkage. Install the
[Microsoft x64 redistributable](https://aka.ms/vc14/vc_redist.x64.exe) if Windows
reports a missing `VCRUNTIME` or `MSVCP` DLL.

No GitHub Release or automatically downloaded executable is part of setup.

## Linux launch

The workbench uses the same pinned original source as Windows. If you have not
run the Windows installer, reconstruct it explicitly from the repository root:

```sh
git clone https://github.com/techrote/PNG2ANSI.git PNG2ANSI
git -C PNG2ANSI checkout 67ae97295ab9a9ab32fdee5410c2371e4b21ce87
cp -a overlay/. PNG2ANSI/
cmake -S native/cuda -B build/cuda -DCMAKE_BUILD_TYPE=Release -DPNGGPU_ENABLE_CUDA=ON
cmake --build build/cuda --parallel 4
ctest --test-dir build/cuda --output-on-failure
node scripts/serve.mjs PNG2ANSI 8000 --cuda ./build/cuda/pnggpu_cuda_worker
```

Use a fresh `PNG2ANSI` destination for that clone; preserve any existing local
work before changing its source revision. `--device N` may be appended to the
server command. The local server binds to `127.0.0.1` only.

## What CUDA changes

The browser continues to decode and sample the image, rasterize the same font,
construct the same glyph masks and palette, display previews and encode ANSI
bytes. The CUDA worker replaces only these two matching passes:

| Pass | Preserved behavior |
|---|---|
| Glyph projection | Every supplied glyph/sample, original sample order, float32 projection followed by CPU-objective decision certification |
| Cell selection | Stable 32-glyph shortlist, all requested foreground/background candidates, original palette order and strict first-winning tie behavior |

The build disables fused multiply-add and fast-math. It uses neither Tensor
Cores nor half precision. The arithmetic mode is now `float32-guarded-binary64`:
conservative outward-rounded intervals certify the original CPU shortlist,
palette and selection decisions; ambiguous cells rerun all matching stages on
the GPU in binary64 using the original CPU expression grouping and stable ties.
The recovery preserves candidate counts and never falls back to CPU execution.
WebGPU's existing float32 behavior is unchanged and can differ from both CPU
and recovered CUDA. The old float32-only worker is rejected by the new adapter.

Recovery reuses at most 32 MiB / 1,024 cells of additional projection storage,
included in native admission and browser estimates. See the
[native fidelity/proof notes](../../native/cuda/README.md#precise-recovery-and-certification).

The existing cell comparison and ANSI-byte comparison remain the acceptance
measure. A GPU-only run reports comparison as skipped, not zero mismatches.
The large-raster streamed Canvas2D sampling path retains its existing separate
qualification limitation.

## Memory and execution limits

The UI keeps its manual-capacity estimate: warn above VRAM minus 4 GiB, block
above VRAM minus 2 GiB. CUDA also checks its real device-buffer allocation against
a fresh reported free-memory snapshot minus 2 GiB before allocating. That second
check accounts for other GPU workloads at the time of initialization; neither
check guarantees an allocation will succeed.

CUDA starts a persistent native worker for each fit and reuses its atlas and
one set of tile buffers across every tile. **Actual CUDA pipeline depth is one**;
the WebGPU depth setting is preserved for switching back, and requested versus
effective depth is recorded. This first CUDA backend does not implement the
WebGPU path's 24 buffered slots.

Requested projection targets remain 4–1024 MiB. Native limits clamp each tile
to 128 MiB of projections, 64 MiB of source samples and 65,536 cells. The worker
further splits large tiles into bounded projection/selection kernel launches
without repeating the HTTP transfer. This limits submission size but is not
proof against Windows watchdog timeouts on every supported GPU. Normal use must
not require changing Windows TDR settings.

One active fit is admitted per bridge. A second tab receives a busy error.
Cancellation, malformed output, a worker failure or a request timeout closes
the native session; idle sessions expire. The bridge rejects foreign origins
and unexpected Host headers and exposes no arbitrary command or file-write API.

## Timings and saved reports

CUDA results are explicitly marked `backend: "cuda"`. Existing JSON schema names
are retained for compatibility with GPU-007 readers; the additive `backend`
field and `gpuStats.backend` identify the actual implementation. CSV outputs
also include the backend.

| Measurement | Includes |
|---|---|
| Shared CPU preparation | The same image/mask preparation charged to both comparison paths |
| Capability probe | Native capability discovery; outside conversion fit totals |
| `nativeInitMs` | Worker startup, CUDA context, allocation and initial atlas upload; included in fit wall time |
| `bridgeRoundTripMs` | Local HTTP request/response wall time, including native tile execution |
| `gpuProjectionMs`, `gpuSelectionMs` | Sum of CUDA-event kernel intervals |
| `uploadMs`, `readbackMs` | Native host-clock copy plus stream-completion time, not isolated PCIe event measurements |
| `cleanupMs` | Session shutdown and resource release |
| Fit / total | Full observed fit, then shared prep and ANSI/preview output as applicable |

These intervals overlap in meaning: kernel time is contained in native work and
bridge round trips, so do not add all rows together. Every repeated fit starts
a fresh native process. Later-run timings can show filesystem/driver/browser
cache effects; they are not persistent-context warm-kernel measurements.

The same image, geometry, sampling, candidate counts, preview setting and CPU
comparison setting should be used when comparing CUDA with WebGPU. Save each
backend's JSON/ZIP report. No CUDA speedup claim is made without physical results.

## Physical qualification

The float32-only baseline failures below are preserved as historical evidence.
The current guarded recovery passes the saved failures and deterministic
sample/candidate sweeps through a real native worker. Full hardmode and 512×512
requalification must use a matching new worker. PR #2 remains draft.

The minimal no-browser regression package compares all saved physical failing
cells and deterministic fixtures against the independent JS CPU, with exact
cell and ANSI comparisons and tile sizes 1, 3 and 64:

```powershell
node scripts/replay_cuda_fixtures.mjs build/cuda/pnggpu_cuda_worker.exe build/qualification/recovery-fixtures.json
node scripts/generate_cuda_regressions.mjs --check
```

The native CTest also reads binary regression frames generated from those CPU
winners. `--self-test` unconditionally runs binary64 GPU matching for every
fixture and checks all certified tuples against it; it additionally requires
nontrivial certified decisions. Its native helper remains shared code, so the
independent JS comparisons are a separate mandatory acceptance gate.

Reports retain the strict aggregate `accepted` flag for all backend comparisons.
`cudaAccepted` separately requires every CUDA tuple/ANSI/repeat comparison to
match CPU plus device/cancellation gates. Existing WebGPU mismatches remain
visible and keep the all-backend aggregate false; they are not relabeled exact.

Recovery counts/reasons and guard/recovery event times are additive fields.
Projection and selection totals include recovery. Device readback byte counts
include both guard inspection and recovered results, whereas HTTP response
bytes contain only the final tuples. Launch maxima are measured event intervals,
not a watchdog guarantee.

Physical testing on a TITAN RTX / driver 581.80 has now exercised the baseline
worker. All five 80×40 / 4×8 hardmode cases and a 17×9 partial-tile case matched
CPU, CUDA and WebGPU exactly. **This is not blanket qualification:** 512×512
tests exposed cell and ANSI mismatches at both 1×1 and 4×8 sampling. Keep PR #2
in draft pending parity recovery. The arithmetic/search/precision contract has
not been changed to hide those failures.

The reproducible acceptance runner uses a real Chrome browser, the installed
reference application and a real native worker. It refuses stale installed
overlay files, checks the hardmode hashes, records worker/source identities,
compares every cell component and ANSI byte, changes tile sizes, checks repeats,
and exercises cancellation followed by another conversion. Exit code 2 is an
acceptance failure and still preserves the report. A single-cell fixture with
the complete mask atlas is saved for each captured discrepancy.

```powershell
.\setup.bat
npm.cmd install --prefix build/qualification-tools playwright@1.56.1 --no-audit --no-fund
node scripts/qualify_cuda.mjs build/cuda/pnggpu_cuda_worker.exe build/qualification-tools/node_modules/playwright/index.mjs build/qualification/turing.json "C:\Program Files\Google\Chrome\Application\chrome.exe" --large
node scripts/analyze_cuda_fixture.mjs build/qualification/turing.json build/qualification/arithmetic.json
```

Keep `SOURCE_COMMIT.txt` beside the matching CI worker. For older artifacts,
append `--worker-commit` followed by the artifact's exact 40-character source
SHA. The runner rejects native source differences against that revision. Worker
hashes and source revision assertions are evidence labels, not signed binary
attestations. CI artifacts now also contain `worker-sha256.json`. The optional
`--large` cases are 512×512 with 1×1 and 4×8 samples; they take longer and can
fail parity. No fallback worker or simulated GPU is used.

Reports record full per-tile measurements. Copies of upload/readback times are
host-clock intervals; device `allocatedBytes` is the declared buffer sum, not
measured peak total VRAM. The NVIDIA snapshot records clocks, power and VRAM at
the start; it is not an integrated energy measurement. Every CUDA fit creates
a new process/context; a second run is a cache-repeat observation, not a warm
persistent CUDA context. Pipeline depth remains one: observed startup/bridge
costs dominate small conversions and copy time alone does not justify streams.

The workbench Stop control now aborts active CUDA and CPU fitting, then retains
completed suite/batch records. WebGPU work already submitted is allowed to
finish before its cancelled result is discarded. Repeated workbench fits compare
cell tuples and ANSI bytes against the first run; nondeterminism is a failure
in detailed reports, suite counts and ZIP summary/repeat CSVs.

Run these from the repository root on the Turing machine:

```powershell
.\build\cuda\Release\pnggpu_cuda_worker.exe --info
.\build\cuda\Release\pnggpu_cuda_worker.exe --self-test
```

If using a CI artifact, omit `Release\` when appropriate. The self-test checks
synthetic constant, random, alternating, duplicate and near-degenerate masks,
shortlists larger than 32 glyphs, partial blocks, repeated buffer reuse and
internal sublaunch boundaries. Its comparison oracle is native binary64 with
shared arithmetic and unconditional GPU verification; it is not the original
independent JS CPU oracle.

Then use the workbench to run the five-image hardmode suite with CPU comparison
at modest settings. Compare both cell components and ANSI bytes. Repeat with
different projection targets and the same settings in WebGPU. Keep source SHA,
worker SHA-256, GPU/driver/runtime identity, parameters, mismatch counts and full
timing reports together. Large 1024 × 1024 / 32 × 64 jobs are throughput and
resource-stress exercises; original CPU full-raster comparison is unavailable
at those extended settings.

With NVIDIA Compute Sanitizer installed, also run:

```powershell
compute-sanitizer --tool memcheck --error-exitcode 1 .\build\cuda\Release\pnggpu_cuda_worker.exe --self-test
```

Compilation and host-side tests can run without an NVIDIA GPU. Actual CUDA
execution, Windows desktop behavior, ANSI parity and comparative performance
require the hardware run above. See `native/cuda/README.md` in the repository
for the native protocol, arithmetic, detailed limits and developer tests.

## Primary references

- [NVIDIA compute capability table](https://developer.nvidia.com/cuda/gpus)
- [Turing binary/PTX compatibility](https://docs.nvidia.com/cuda/turing-compatibility-guide/)
- [NVCC compiler options](https://docs.nvidia.com/cuda/cuda-compiler-driver-nvcc/)
- [CUDA 12.8 Windows prerequisites](https://docs.nvidia.com/cuda/archive/12.8.1/cuda-installation-guide-microsoft-windows/index.html)
- [NVIDIA CUDA 12.8.1 redistribution manifest](https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.8.1.json)
