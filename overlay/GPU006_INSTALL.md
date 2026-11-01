# PNG2ANSI GPU-006 — full cumulative Windows distribution

This is a **complete cumulative installer**: it contains all GPU-001 through GPU-006 research-code changes and the five original benchmark PNGs, and does **not** need a previous installation. On first setup it downloads the original PNG2ANSI base from a pinned GitHub commit, merges the included source overlay and verifies the hardmode image hashes; subsequent launches are local. It can also update an older GPU-004 installation in the same extraction directory.

Run `start.bat` from the extracted archive root; it executes `setup.bat` when installation/updating is required, serves the app on localhost and launches a browser. `test.bat` executes Node host-side tests when Node.js/npm is installed. No previous research ZIP is needed.

Important: **standard WebGPU cannot report installed or free VRAM accurately**. Enter it manually on the workbench: `4` for GTX 1650 SUPER or `24` for RTX Titan. Click **Estimate VRAM** first. GPU work will not start without a declared capacity. GPU runs are blocked if estimated workbench memory exceeds installed VRAM minus 2 GiB and require explicit confirmation above VRAM minus 4 GiB. A 4 GiB card always triggers a confirmation because the warning threshold is zero.

The CPU comparison checkbox is off initially to avoid unnecessarily repeating long CPU oracle runs. Re-enable it when validating fidelity. GPU tile target now allows 262,144, but **device-limited physical tile** remains potentially much smaller; compare requested and actual values. GPU timestamps (if available) and per-tile profiling appear under the benchmark details; export JSON for raw per-tile timings.

The original classic ANSI/CP437 algorithms and PNG2ANSI-web release are unchanged. GPU-006 implementation is not yet hardware-qualified on the user GPU/browser, so verify exact ANSI parity again before adopting it as a production or research result.
