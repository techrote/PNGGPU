# GPU-007 — deep buffered research / large ANSI batch

Extract the complete Windows distribution and double-click **start.bat**.
A fresh installation downloads the pinned original PNG2ANSI source once; no earlier GPU release is needed. Existing installs will receive the overlay automatically.

New options: pipeline depth up to **24**, projection tile targets **4–1024 MiB**, GPU-only **1024×1024** cell output, **32×64** sample grid, automatic estimated VRAM preflight, and **Batch folder → ANSI ZIP** with optional performance receipts. The original CPU reference configuration remains unchanged.

The GPU interface is a research tool. 1024×1024 at 32×64 could require extraordinary compute time. Rendering such large sample lattices uses streamed Canvas2D strips, and the oversized cropping path has not yet demonstrated reference parity. 1024 MiB tile requests are routinely clamped by WebGPU binding limits. Per-device VRAM estimates include the selected number of in-flight tile buffers; they cannot see real free VRAM. Batch ZIPs cap ANSI payload at 512 MiB; archive errors and partial results are recorded.

After installation run `test.bat` for host tests, then repeat a small exact-parity test on real WebGPU hardware before deep buffering/huge sample experiments. For GPU scheduling comparisons, use the same image/profile/tile target and compare depth 1 / 2 / 3 / 8 / 24 with GPU timestamps enabled when available.
