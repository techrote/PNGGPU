# Complete parkour FP32 video exports — 5 November 2026

Delivered **24 MP4 videos and 17,256 individual ANSI frames** in one verified ZIP.
Each clip contains all **719 frames at 30 FPS** (23.967 seconds), with the original
audio retained as AAC. There are twelve character grids, each at **4x8 and 8x16
samples/cell**. This export is FP32 only at the user's explicit request.

PR #2 remains draft. WebGPU and guarded CUDA defaults, native arithmetic/search,
the 2 GiB reserve, bounded launches and depth one are unchanged. No machine
settings, fault/pressure tests or sustained-stability qualification were used.
This is an offline artifact export, not a realtime pipeline benchmark.

## Delivery

Local ZIP: `C:\pnggpu-CUDA\build\exports\agenticparkour-fp32-delivery.zip`

- Archive bytes: **1,389,965,898**.
- SHA-256: `ef18065cbb2592532ab906df784fd34eb45c42e8bf889fbdcb35acc6973628cf`.
- ZIP CRC verification passed for every entry; 24 MP4 and 17,256 ANSI files.
- Open `index.html` after extracting for paired 4x8/8x16 comparisons.
- `README.txt`, `settings.json`, `manifest.json`, per-video receipts and first/last
  PNG previews are included. Raw tuple buffers remain beside the local exports.
- Git carries the compact [delivery receipt](gtx1650super-video-export/delivery.json)
  and [source/device/export summary](gtx1650super-video-export/summary.json), not
  the large ZIP, video inputs, local toolchain or worker binaries/licenses.

## Sizes and aspect handling

Glyphs render at the original 8x16 pixels per character. Doubling sample width
and height quadruples sample count, changing matching detail while retaining
video dimensions. Legacy square canvases retain their earlier letterboxing;
other grids use exact centered integer aspect crops. Resampling uses the locally
installed FFmpeg Lanczos filter; this is distinct from earlier browser-prepared
benchmark input. Source PNGs are 854x480 and are hashed before conversion.

| Characters | Video pixels | Source treatment |
|---|---|---|
| 8x4 | 64x64 | Letterboxed, full source |
| 16x8 | 128x128 | Letterboxed, full source |
| 32x16 | 256x256 | Letterboxed, full source |
| 40x12 | 320x192 | Crop 800x480 at (27,0) |
| 80x24 | 640x384 | Crop 800x480 at (27,0) |
| 80x25 | 640x400 | Crop 768x480 at (43,0) |
| 80x40 | 640x640 | Letterboxed, full source |
| 120x34 | 960x544 | Crop 840x476 at (7,2) |
| 160x45 | 1280x720 | Crop 848x477 at (3,1) |
| 160x80 | 1280x1280 | Letterboxed, full source |
| 320x90 | 2560x1440 | Crop 848x477 at (3,1) |
| 320x160 | 2560x2560 | Letterboxed, full source |

Both videos and ANSI frames use the original CP437 vocabulary, 16-color palette,
32-glyph shortlist, 6 foreground and 5 background candidates. H.264 uses CRF 12,
yuv420p and faststart; exact ANSI files remain available separately. Each MP4's
frame count, 30 FPS, dimensions, audio presence and duration were checked.

## Bounded conversion and verification

Runner source: `b7d2d7e46244fd8b6fd136e656fe818ecef495ed`. Exact worker/source/build identities are
recorded per output. The original runtime licenses remain with the local normal
worker. No worker was substituted or its capacity declaration weakened.

Final delivery converts **17,280 frame fits / 161,786,880 cells**, including one
extra canonical command-2 comparison per variant. Its 17,256 delivered frames
are the command-3 native-packing outputs. The first frame of every variant has
identical native/canonical tuples. Before this final set, a separate tiny 8x4
719-frame export verified the renderer and complete input length; it remains a
separate local preliminary receipt, not part of delivery counts.

Each context performs at most 30 frame conversions (29 delivered frames plus
one comparison in the first context; 30 in subsequent contexts). Each frame can
span multiple native TILE/Worker::fit requests; the 30-frame bound is not a
30-TILE bound. There are 10-second frame and 30-second chunk deadlines. The
worker/context is released between chunks; software video
encoding follows each completed variant with no CUDA context retained. Input is
streamed with backpressure; complete uncompressed sample sequences are not kept
in RAM. All **576** contexts close, and driver monitoring/final log queries
record no new errors. Minimum pre-context free snapshot: **3,441,950,720 bytes**;
maximum declared GPU buffers: **84,522,608 bytes**. These are admission
snapshots/declarations, not measured peak residency or a stability qualification.

Per-frame tuple/ANSI SHA-256 checks, independent ANSI re-encoding and original-
renderer pixel comparisons validate packaging. The optimized CPU renderer also
matches a PNG produced by the original browser renderer. Render/resume receipts
bind the plan, tuple buffer, configuration, dimensions and video checksum. The
orchestrator stops on failed checks/timeouts and cleans up descendant processes.

## Reproduction

Run setup and build/verify a source-matched normal CUDA worker as described in
[the direct-path report](GTX1650SUPER_DIRECT_PATH.md). Install local Playwright,
Chrome, FFmpeg/FFprobe, Python NumPy/Pillow. Preserve worker source/hash receipts
and NVIDIA licenses; these dependencies are not carried by Git.

```powershell
node scripts/prepare_cuda_export.mjs build/qualification-tools/node_modules/playwright/index.mjs benchmarking-material/agenticparkour build/exports/agenticparkour-delivery-plan.json
python scripts/run_cuda_export.py build/direct-native/pnggpu_cuda_worker.exe build/exports/agenticparkour-delivery-plan.json build/exports/agenticparkour-fp32-delivery
```

Use a new output directory for a different plan. Resume only accepts fully
verified completed outputs matching the exact original plan and source hashes.
Do not change worker/native sources midway or bypass a failed receipt. The source
video is SHA-256 `e444f447d50891af0a1049ed08aef326733bc5dce612258c1a0a4a934d943ada`. All input PNG
hashes and local FFmpeg/browser versions are inside the delivered settings.

Export engineering source `b7d2d7e46244fd8b6fd136e656fe818ecef495ed` passed all three [CI jobs](https://github.com/techrote/PNGGPU/actions/runs/42106439662): Windows host/application checks and Windows/Linux CUDA compile/native checks. This includes the three new export-scope tests; the native golden-inclusive host suite remains 37,092 checks.
