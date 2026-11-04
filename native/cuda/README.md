# Optional CUDA worker

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
- The build disables FMA contraction and fast-math transformations. The source
  preserves the WGSL expression grouping using scalar float32 operations.
- There is no Tensor Core, half-precision or reduced-search approximation.
- **Exact parity with the binary64 JavaScript CPU oracle is not established.**
  The WGSL implementation already differs from that oracle in accumulation
  precision and expression grouping. WGSL implementation/compiler behavior can
  also differ from this CUDA port. Use the workbench's shared-input CPU comparison
  and compare both cell records and ANSI bytes on the actual GPU.

The native CPU arithmetic helper is intentionally shared with the CUDA kernels.
It isolates CUDA execution and indexing failures; it is not an independent proof
of the reconstruction algorithm. Host tests also check explicit black/white
results, stable ties, protocol rejection and tile-partition invariance.

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
float32 oracle, repeats each request on reused buffers, and exercises multiple
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
