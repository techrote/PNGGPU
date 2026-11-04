# Optional CUDA worker

The [projection/continuous-queue report](../../qualification/GTX1650SUPER_PROJECTION_QUEUE.md)
adds FP32/FP64 results at 160x45, 320x90 and letterboxed 160x80 characters.
Fresh normal builds now default `PNGGPU_SAMPLE_MAJOR_MASKS=ON` and
`PNGGPU_INTEGER_PROJECTION_SUMS=ON`. The former repacks the static atlas on the
host once, keeping GPU mask storage unchanged; its cold repack/upload span is
included in `atlasUploadMs`. The latter sums RGB8 channels exactly as uint32 in
binary64 projection, retaining binary64 products, accumulation and objective.
Validated samples/cell <=2048 imply totals <=522240, so the old double sums and
new integer sums/conversions are exact. Original CPU helpers remain the oracle.
Existing CMake caches require explicit ON settings when upgrading. `--info`
reports `deviceMaskLayout` and `binary64ProjectionSums`; both controls apply only
to the normal worker. The 2 GiB reserve and GPU allocation sizes are unchanged.

`scripts/benchmark_cuda_video.mjs ... --continuous` measures a finite always-ready
producer with depth one: 2–30 prepared frames, <=128 MiB preloaded input, a
30-second burst bound and 10-second per-frame timeout. It refills immediately
after completion and retains results for post-burst tuple/ANSI serialization.
Reports distinguish preload, fit/warm-span throughput, refill gaps and output
drain costs. A serialized asynchronous driver-log monitor polls between queries
(250 ms delay, 10-second query timeout, 12-second maximum observation age), aborts
on errors/staleness and is stopped with its active query cancelled on cleanup.
A final fresh log query follows cleanup. Detection latency includes query time;
polling cannot guarantee detecting an event before the next immediate refill.
This is prepared-frame conversion throughput, not live capture/display latency.

The [direct-path experiment](../../qualification/GTX1650SUPER_DIRECT_PATH.md)
compares identical prepacked TILE inputs through HTTP and a private Node child-
pipe transport. `--continuous --prepacked` prepares/retains packets before the
timed burst; add `--direct` to remove the HTTP hop. For matched live allocation
controls, use `--continuous --live-pack` with or without `--direct`. All prototype
arms allocate and retain per-frame packets and cap declared parent raw/packet/
session-payload storage at 256 MiB (not whole-process RSS). The browser path
continues to use HTTP and its reusable tile buffer.

`--continuous --direct --native-pack` copies compact RGBA row bands in bulk on
the JS side and gathers canonical cell-major RGB words in native C++. The
normal worker advertises `nativeRasterPacking: "rgba-row-bands-v1"`; the runner
requires that capability explicitly. Native gathering uses small cell blocks
for output locality after validating the complete source extent. It changes
neither kernels, arithmetic nor GPU buffer admission. This is still a copying
pipe protocol, with one worker/context and one outstanding request.

The [GTX selection profile](../../qualification/GTX1650SUPER_SELECTION_PROFILE.md)
records bounded FP32/FP64 warm-frame measurements. `PNGGPU_COLOR_MAJOR_FP32=ON`
(default) retains the original direct FP32 candidate traversal. Configure it
`OFF` to experiment with glyph-major traversal and explicit stable tie ranks.
This reduced 160x45 latency but regressed the measured 320x90 medians; it is not
an automatic universal optimization. The guarded/default arithmetic and binary64
selector are unchanged. The same traversal is used by FP16-mixed selection.

`PNGGPU_CUDA_PROFILE=ON` adds `--resource-usage` and `-lineinfo` while retaining
Release optimizations and strict arithmetic flags. `--info.kernelResources`
reports compiler/runtime attributes and theoretical occupancy, not achieved
hardware counters. Do not interpret local stack bytes as spill traffic.

Optional `PNGGPU_CUPTI_ACTIVITY=ON` requires a matching CUPTI SDK via `CUPTI_ROOT`
and its runtime DLL/library and license. It is off by default. Only a `--stdio`
process with `PNGGPU_CUDA_ACTIVITY_DIRECTORY` set records CSV runtime/kernel
activities; info probes are untraced. Client record buffers are capped at four
1 MiB allocations; the separate host-pinned profiling pool is limited to two
buffers. Background flushes occur every 100 ms; instrumented tile responses also
flush completed activities before returning, avoiding tail loss on short bursts.
These flushes add traced wall overhead. Check expected kernel counts,
`dropped`/`traceError` rows, and the orderly-exit `traceErrors` footer. A killed
bridge worker can lack the footer, so completeness must be checked explicitly.
Tracing adds overhead. These options apply to the normal worker only. No
privileged counters, registry changes or watchdog changes are required.

This native worker implements PNGGPU's photographic projection and ANSI candidate
selection on NVIDIA CUDA. Its primary targets are **TITAN RTX and RTX 2060 / 2070 /
2080 / 2080 Ti, including Turing variants**. NVIDIA assigns these GPUs compute
capability **7.5**. The executable contains native `sm_75` code and `compute_75`
PTX. Other compatible devices of capability 7.5 or later may run it, but that does
not constitute qualification on those devices.

The browser continues to prepare the image samples, font masks, statistics and
ANSI palette. CUDA replaces only the two matching passes. The existing WebGPU
backend and independent original CPU reference remain available without a CUDA
installation.

## Fidelity contract

- Input samples retain their exact cell-major RGB8 bytes. Masks and statistics
  retain the same float32 values sent to the WebGPU shader.
- Projection visits samples in their original order. Selection retains the
  32-glyph shortlist, strict comparisons, stable glyph/color tie order and
  original foreground/background candidate counts.
- The build disables FMA contraction and fast-math transformations. Float32
  projection is retained; decision intervals model the principal CPU objective.
  Ambiguous cells run binary64 projection and selection on the GPU, matching the
  CPU expression grouping, stored float32 statistics and strict stable ties.
- There is no Tensor Core, half-precision or reduced-search approximation.
- WebGPU retains its existing float32 arithmetic. It can differ from the
  principal CPU reference and the recovered CUDA result. Qualification compares
  both tuples and ANSI bytes; WebGPU agreement cannot override a CPU mismatch.

The native binary64 helper is shared with recovery kernels, so it is not an
independent proof of the algorithm. Native regressions also consume frames
generated by the independent JS reference from historical physical failures.
The device self-test unconditionally runs binary64 GPU matching and checks every
certified tuple against it, including nontrivial random masks. Physical browser
qualification separately compares against the original JS reference.

## Precise recovery and certification

The reported arithmetic mode is `float32-guarded-binary64`. An older float32-only
worker is rejected by the current browser adapter; upgrade both together.

For controlled qualification, the normal worker also accepts
`--arithmetic-mode binary64-direct`. The default remains guarded. Direct mode
skips float32 projection, certification and the intermediate result readback,
then runs the same precise projection/selection kernels unconditionally with
the existing chunk/sublaunch limits. It preserves float32 input masks/statistics,
CPU expression grouping, strict ties, shortlist and candidate counts.
`directCells` and `gpuDirectProjectionMs`/`gpuDirectSelectionMs` identify this
work; recovered/certified counts and guard/recovery times are zero. There is one
final device readback. Buffer allocation/admission deliberately remain identical
to guarded mode for the first A/B experiment, including the unused float32
projection buffer. Neither the 2 GiB reserve nor display protections change.
The certification self-test remains guarded-only; direct-mode qualification uses
bounded independent CPU fixtures, not a claim of certified-fast-path coverage.

Visual/performance experiments may explicitly choose `float32-direct` (the
original unguarded float32 projection/selection helper) or `float16-mixed`.
The latter rounds masks and RGB products to FP16, then accumulates and scores
in FP32 with the original float32 statistics. It is not all-FP16 arithmetic or
a Tensor Core implementation; conversion overhead may outweigh arithmetic gains.
Keeping accumulation/scoring in FP32 avoids overflowing FP16 image-error sums.
Both experimental modes retain candidate counts, strict comparisons and stable
ties, perform no certification/recovery, and report direct cells and timings.
Their visual differences are measurements, not exact CPU-parity acceptance.

For `n <= 2048` RGB8 samples and binary32 masks in `[0,1]`, the bound
`delta = 2*n*(n+1)*255*2^-24` encloses the difference between each float32 dot and
the CPU binary64 dot. With `gamma(k,u)=k*u/(1-k*u)`, this exceeds
`(gamma(2n,2^-24)+gamma(n,2^-53))*255*n` over the supported range. Products are
exact in binary64. Subnormal integer-times-mask products and sums stay on the
binary32 subnormal grid until normal range; FTZ remains disabled. Delta and
interval endpoints round outward. CUDA uses directed-round float intrinsics;
the host interval implementation uses binary64 endpoint operations followed by
directed binary32 conversion.

Intervals follow the original CPU expression tree: projection sums three
independently divided squared covariances; candidate SSE updates once per
channel. The variance is promoted from stored float32 without a new clamp.
The guard proves full retained shortlist order/membership, selected palette
order/membership and the final tuple against every candidate. A strict interval
separation certifies a decision; overlap, including exact ties, requests recovery.
No mismatch tolerance is involved.

Uncertain cells rerun the original search on the GPU in binary64, including all
glyphs before building the original 32-entry shortlist and all requested palette
candidates. There is no CPU fallback. Recovery uses a persistent buffer of at
most 32 MiB / 1,024 cells, further bounded by the initialized tile and glyph
count. Allocation admission and browser estimates include it. Recovery project
and selection launches are independently bounded and synchronized like the
float32 kernels; result order remains unchanged.

`recoveredCells`, `certifiedCells`, and `recoveryReasons` expose the decision
path. Projection/selection event totals include recovery; `gpuGuardMs`,
`gpuRecoveryProjectionMs`, `gpuRecoverySelectionMs` separate the components.
`maxProjectionLaunchMs` / `maxSelectionLaunchMs` record observed maxima, not a
TDR guarantee. `deviceReadbackBytes` includes both flag inspection and final
results when recovery runs. The guard can be conservative and recovery-heavy;
performance must be measured rather than inferred from precision alone.

## Building on Windows

Install an NVIDIA driver compatible with the selected CUDA Toolkit, the **x64
Visual Studio 2022 C++ build tools**, CMake 3.21 or later, and **CUDA Toolkit
12.8.x**. This is the documented baseline for the build. The GPU is not required
to compile the executable. The GPU and driver are required to run it.

From the repository root in a developer PowerShell:

```powershell
cmake -S native/cuda -B build/cuda -G "Visual Studio 17 2022" -A x64 -DPNGGPU_ENABLE_CUDA=ON -DBUILD_TESTING=ON
cmake --build build/cuda --config Release --parallel
ctest --test-dir build/cuda -C Release --output-on-failure
.\build\cuda\Release\pnggpu_cuda_worker.exe --info
.\build\cuda\Release\pnggpu_cuda_worker.exe --self-test
```

CUDA 12.8 Update 1's corresponding Windows toolkit driver is 572.61. An installed
newer compatible production driver is also usable. NVIDIA's older CUDA 12 family
minor-compatibility floor has additional limitations and must not be treated as
a guarantee that newer-toolkit PTX will load. CUDA 13.x still lists `sm_75`, but
other toolkit/compiler combinations need their own build and device evidence.

The build links the CUDA runtime statically. A current compatible NVIDIA driver
is still required on the machine that runs the worker; static runtime linkage
does not provide the GPU driver.

## Building on Linux

With a compatible CUDA Toolkit, supported C++ compiler and CMake installed:

```sh
cmake -S native/cuda -B build/cuda -DCMAKE_BUILD_TYPE=Release -DPNGGPU_ENABLE_CUDA=ON -DBUILD_TESTING=ON
cmake --build build/cuda --parallel
ctest --test-dir build/cuda --output-on-failure
./build/cuda/pnggpu_cuda_worker --info
./build/cuda/pnggpu_cuda_worker --self-test
```

`PNGGPU_ENABLE_CUDA` defaults to `OFF`; configuring this subdirectory never
requires CUDA unless explicitly enabled. Host validation can run on a machine
without NVIDIA software:

```sh
cmake -S native/cuda -B build/cuda-host -DPNGGPU_ENABLE_CUDA=OFF -DBUILD_TESTING=ON
cmake --build build/cuda-host --parallel
ctest --test-dir build/cuda-host --output-on-failure
```

For a direct host-only compiler invocation:

```sh
g++ -std=c++17 -O2 -Wall -Wextra -Wpedantic -ffp-contract=off -I native/cuda/include native/cuda/src/common.cpp native/cuda/tests/host_tests.cpp -o pnggpu_cuda_host_tests
./pnggpu_cuda_host_tests
```

## Device selection and modes

```text
pnggpu_cuda_worker --info [--device N]
pnggpu_cuda_worker --stdio [--device N]
pnggpu_cuda_worker --self-test [--device N]
```

By default, the worker chooses the **first usable device with compute capability
7.5 or later**. It skips older cards such as a V100 rather than assuming CUDA
ordinal zero is the TITAN RTX. `--device N` explicitly selects an ordinal; an
unsupported ordinal/capability fails with an explanatory error. Options may be
specified in either order.

`--info` writes one JSON object, with actual GPU name/index/capability, reported
free/total memory, CUDA driver/runtime versions, precision and protocol limits.
An unavailable driver/device gives JSON `available:false` and exit status 1.

`--self-test` uses synthetic constant, random, alternating, duplicate and
near-degenerate-mask fixtures, including more than 32 glyphs and partial final
blocks. It compares all glyph/foreground/background records with the native
CPU-grouped binary64 oracle, repeats each request on reused buffers, and exercises multiple
internal projection and selection launches. Success is JSON with `ok:true` and
exit status 0; any mismatch or CUDA failure is a nonzero exit. It obeys the same
2 GiB free-memory reserve as real work. These tests need a real compatible GPU.

## Bounded execution and memory

The worker uses one reusable tile-buffer set and one explicit CUDA stream. All
tiles execute sequentially. Each initialized session owns its atlas, palette,
tile pixels, projections and result buffers; no other session can overwrite
them. End of input or any error releases the native resources.

The limits are:

| Limit | Value |
|---|---:|
| Protocol payload | 128 MiB |
| Tile cells | 65,536 |
| Samples per cell | 1–32 wide, 1–64 high |
| Glyph count | 1–65,535, subject to atlas/message limits |
| Foreground / background candidates | 1–12 / 1–8 |
| Tile pixel buffer | 64 MiB |
| Tile projection buffer | 128 MiB |
| Projection iterations per kernel sublaunch | 16,777,216 |
| Selection cells per kernel sublaunch | At most 1,024, further reduced for larger searches |
| Required reserve against reported free memory | 2 GiB |

The projection work limit is **internal**, not an HTTP tile-size restriction.
A large transfer tile is split into linear `(cell,glyph)` ranges; samples stay in
their original order. Each kernel launch is timed and completed before the next
is issued. Selection similarly splits the cell range. This bounds individual
work submissions without sending thousands of tiny transfer requests. It is a
conservative work bound, not a demonstrated Windows timeout guarantee; normal
use must not require disabling Windows TDR.

All sizes and byte counts are validated before allocating device memory. The
worker checks its declared device-buffer sum against a fresh `cudaMemGetInfo`
snapshot minus 2 GiB. The runtime, context, compiler and other applications have
additional costs; free-memory telemetry is not a guarantee that allocation will
succeed. Allocation and kernel errors are propagated, never labeled successful
CUDA output.

## Persistent binary protocol, version 1

The bridge launches `--stdio`; stdin and stdout become binary pipes (including
on Windows). A frame is a four-byte little-endian unsigned payload length,
followed by exactly that many bytes. Payloads must be 8 bytes through 128 MiB.
EOF before a fresh length is clean; partial lengths/bodies are errors. There
are no log lines on the binary stdout stream.

Exactly one INIT is accepted, then zero or more sequential TILE requests:

| Request | Little-endian payload |
|---|---|
| INIT | Eight `uint32`: `1, 1, sampleWidth, sampleHeight, glyphCount, foregroundCandidates, backgroundCandidates, maxTileCells`; then float32 glyph-major masks; float32 glyph statistics, four values per glyph; float32 palette, four values for each of 16 colors |
| TILE | Two `uint32`: `2, cellCount`; then `cellCount * sampleWidth * sampleHeight` packed RGB8 words (`R \| G<<8 \| B<<16`, zero high byte), in cell-major sample order |
| RASTER_TILE (private direct prototype) | Five `uint32`: `3, cellCount, columns, rows, startCell`; then compact RGBA8 row bands described below |

RASTER_TILE requires columns/rows in 1..1024 and a contiguous logical cell range
within that grid and the INIT tile capacity. For each cell row intersecting the
range, append its selected contiguous cells in raster order: sample Y, cell X,
sample X, RGBA byte. Partial first/last rows contain only selected cells. The
pixel byte count remains `cellCount * samples * 4`; its header adds 12 bytes
relative to TILE. Native conversion ignores alpha and preserves RGB8 exactly.
Full geometry/length validation precedes allocation and gathering. HTTP rejects
command 3; only the private direct transport admits it. Responses use the
existing TILE schema and canonical output ordering.

Mask values must be finite in `[0,1]`. Statistics must equal the browser-host
algorithm's binary64 sum/sum-of-squares followed by float32 storage, and contain
zero padding. The palette contains finite RGB values in `[0,255]` and zero
padding. Mismatched, non-finite, truncated and oversized inputs are rejected.

Every response has two `uint32` values, `status` (0 success, 1 error) and
`jsonByteLength`, followed by that much UTF-8 JSON. A successful TILE appends
`cellCount` records of four little-endian `uint32` values: glyph index,
foreground index, background index, zero. INIT and errors contain no records.

Successful INIT metadata includes `ok`, `device`, `protocolVersion`, `precision`,
`allocatedBytes`, and `atlasUploadMs`. TILE metadata includes `ok`, `cellCount`,
`allocatedBytes`, `projectionSublaunches`, `selectionSublaunches`, and `timing`:

| Timing | Meaning |
|---|---|
| `gpuProjectionMs` | Sum of CUDA-event projection-kernel intervals |
| `gpuSelectionMs` | Sum of CUDA-event selection-kernel intervals |
| `uploadMs` | Host elapsed time for tile transfer through its stream completion |
| `readbackMs` | Host elapsed time for result transfer through its stream completion |
| `nativeTotalMs` | Native tile call elapsed time, including waits/launch overhead |
| `nativePackingMs` | RASTER_TILE validation, allocation and host gather before the native fit interval; zero for ordinary TILE, not zero legacy parsing cost |

`nativePackingMs` is outside `nativeTotalMs` and already inside the client bridge
interval. Subtract it from the bridge remainder before presenting disjoint
timing buckets. Optional absent native timing fields remain unavailable/null in
the adapter. `scripts/cuda_timing_breakdown.mjs` supplies warm-frame accounting.

The browser's request/packing time and native initialization are separate costs.
Kernel intervals must not be presented as end-to-end conversion throughput.
An error response is `{"ok":false,"error":"..."}` and terminates the process;
the bridge must discard that session.

## Qualification on a Turing machine

First run the native self-test; then run a modest workbench conversion with CPU
comparison. Preserve per-cell mismatches and ANSI-byte mismatches rather than
accepting a visually similar preview. Test the same shared inputs with multiple
tile sizes, all five hardmode images, repeated runs and partial tail tiles. The
existing large-image streaming resampling path retains its separate qualification
limitation.

For native memory validation on NVIDIA-equipped developer machines:

```sh
compute-sanitizer --tool memcheck --error-exitcode 1 ./build/cuda/pnggpu_cuda_worker --self-test
```

The kernels do not exchange shared-memory data or use warp intrinsics. If such
optimizations are introduced, also qualify them with `racecheck`/`synccheck` and
Turing's independent-thread scheduling rules. Instrumentation can slow kernels;
use smaller fixtures if a desktop watchdog is encountered during diagnostics.

Record source commit, GPU model/index, driver/runtime/toolkit, build flags,
parameters, source images, cell and ANSI mismatches, tile/sublaunch counts and
both cold and warm timing. A compile-only CI pass or native float32 self-test
does not establish original CPU parity or a speedup over WebGPU.

## Primary references

- [NVIDIA compute capability table](https://developer.nvidia.com/cuda/gpus)
- [Turing binary and PTX compatibility](https://docs.nvidia.com/cuda/turing-compatibility-guide/)
- [NVCC floating-point and architecture options](https://docs.nvidia.com/cuda/cuda-compiler-driver-nvcc/)
- [CUDA 12.8 Windows compiler/OS support](https://docs.nvidia.com/cuda/archive/12.8.1/cuda-installation-guide-microsoft-windows/index.html)
- [CUDA 12.8 Update 1 driver versions](https://docs.nvidia.com/cuda/archive/12.8.1/cuda-toolkit-release-notes/index.html)
- [CUDA minor version compatibility and PTX caveats](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)
- [CUDA memory information and allocation limits](https://docs.nvidia.com/cuda/cuda-runtime-api/cuda_runtime_api/group__CUDART__MEMORY.html)
- [Windows WDDM timeout behavior](https://learn.microsoft.com/windows-hardware/drivers/display/timeout-detection-and-recovery)
