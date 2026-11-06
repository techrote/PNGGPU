# Intermediate sampling, 25x80 orientation and A/B wipe — 6 November 2026

The updated local viewer is `build/exports/ansi-sampling80-viewer/index.html`.
The portable ZIP is `build/exports/ansi-sampling80-viewer.zip`, **4,394,613 bytes**,
SHA-256 `98ae59097bdf8f6cfd8fdda4296590bc5ef88d12c72b66f7f9193d952f6e99ed`.
It automatically loads **50 configurations / 150 exact ANSI stills** at source
frames 1, 360 and 719. The preceding video and quality ZIPs remain unchanged.

## Comparison controls

The default **A/B side by side** fits both complete images at one common display
scale. **In-frame A/B divider** reveals the same source-image coordinates on the
left and right: it clips full aligned rasters, never stretches each half. Drag
the handle, use the percentage slider, or focus the handle and use arrows,
Shift+arrows, Home and End. Swap left/right or save the composite PNG. The
existing A/B/C side-by-side and instant 1/2/3 switching remain available.

Choose **1x exact pixels** for one rendered pixel per CSS pixel; fit mode changes
only presentation size. PNG downloads preserve the full displayed raster and
ANSI downloads preserve native bytes. Native/rotated grids are explicitly labelled.
Pixel comparisons work across registered orientations; cell counts/overlays are
disabled across incompatible native grids. The user can still inspect native
cell coordinates through the inverse display transform.

For a sampling-only comparison choose the browser-prepared `photo-samples4x8`,
`samples6x12` and `photo-samples8x16` presets, keeping all other settings fixed.
The two **Original export** entries deliberately retain their different FFmpeg
preparation. The old full-video folder can still be imported for all 719 frames.

## Candidate lineup

The thirteen normal 80x25 sample grids are:

`4x8, 4x10, 4x12, 4x16, 5x10, 6x8, 6x10, 6x12, 6x16, 7x14, 8x8, 8x12, 8x16`.

Nine are new; four reuse the byte-verified previous neutral browser-prepared
presets. Both proportional intermediates and non-1:2 ratios are included. Equal
sample counts can distribute detail differently: 4x12 versus 6x8 each uses 48;
4x16 versus 8x8 each uses 64; 6x16 versus 8x12 each uses 96. Original mask
averaging is preserved: non-divisor grids use overlapping, unweighted integer
pixel bins rather than an invented ideal fractional-area resampler. Quality is
therefore not assumed to improve monotonically with sample count.

The earlier three-frame analysis already found 8x8 versus 4x16 differing in
1,497 / 1,124 / 1,241 of 2,000 tuples at frames 1 / 360 / 719 despite equal
sample count. That identifies a useful comparison; it does not rank either.
The user's observation that 8x16 looks smoother and loses detail remains a
perceptual assessment, not a result inferred from compressed file size alone.

## What the 90-degree candidates mean

All source crops remain 768x480 at (43,0). Swapping 80x25 to 25x80 also swaps
rendered cell geometry from 8x16 to **16x8**, so the native portrait raster is
**400x640**, the actual quarter-turn of 640x400. Each portrait is displayed
270 degrees clockwise back at **640x400** for pixel registration in the wipe.
Native portrait and aligned PNG previews accompany the six portrait presets.

For both anchor samplings (4x8 and 8x16, transposed to 8x4 and 16x8) there are:

1. **Literal rotation**: permute the saved cell grid and glyph pixels clockwise,
   preserving chosen glyphs/colors. No fitting runs. The inverse-aligned result
   is pixel-identical to the saved baseline on all six tested frames.
2. **Rotated-atlas refit**: rerun FP32 with source samples and saved low/high
   atlases permuted exactly, preserving code/dedup order. This is mathematically
   equivalent, but FP32 accumulation order changes; byte identity is not promised.
3. **Fresh upright refit**: rerasterize upright DejaVu glyphs at **7px in 16x8
   cells**, then fit the rotated samples. The smaller font is explicit to avoid
   clipping a 14px font into 8px height. This changes glyph shape/coverage and
   sometimes vocabulary, so it is not an orientation-only arithmetic control.

Standard CP437 terminal glyphs cannot themselves express these custom rotated
bitmap atlases. The saved atlas and exact viewer are authoritative; ANSI bytes
alone with a different terminal font will not reproduce the native preview.

Changed aligned RGB pixels versus the corresponding saved normal baseline:

| Portrait case | Frame 1 | Frame 360 | Frame 719 |
|---|---:|---:|---:|
| Literal, 8x4 | 0 | 0 | 0 |
| Rotated-atlas refit, 8x4 | 4,600 | 0 | 0 |
| Upright 7px refit, 8x4 | 171,401 | 105,794 | 141,312 |
| Literal, 16x8 | 0 | 0 | 0 |
| Rotated-atlas refit, 16x8 | 99 | 99 | 0 |
| Upright 7px refit, 16x8 | 159,197 | 94,756 | 126,881 |

Each aligned frame has 256,000 pixels. These differences measure changed output,
not which typography retains useful detail. The rotated-atlas maximum is 1.8%
of pixels on one frame; it is distinct from the deliberately changed upright
font policy. No new full-video rendering or temporal-quality claim is made.

## Scope, evidence and reproduction

Matching/preparation source: `c7aee42a5a429c4abebd91f402df12a9ef655e87`.
Its [three CI jobs pass](https://github.com/techrote/PNGGPU/actions/runs/42246958652).
Native matcher code, normal worker, strict arithmetic flags, stable ties, 32-glyph
shortlist and 6/5 candidate counts are unchanged. WebGPU and guarded CUDA remain
defaults, PR #2 remains draft, and the native **2 GiB reserve** is preserved.

The additions perform **52 bounded FP32 frame fits / 104,000 GPU cells** across
13 contexts (three selected frames plus one packet-format comparison each).
Literal rotations use no matching. All 39 child processes exit, device identity
is checked before/after, monitor/final driver logs remain clear, and no fault,
pressure, stress, watchdog or machine-setting experiment occurs. Minimum free
pre-context snapshot is 3,441,950,720 bytes; maximum declared GPU buffers are
15,290,784 bytes. This does not establish sanitizer or sustained stability.

The [independent audit](gtx1650super-sampling-wipe/independent-audit.json) verifies
all 45 new ANSI encodings against original-core tuples, 105 preserved baseline
files, all 63 PNG previews, 18 rotated input rasters, four saved atlas
permutations, source/worker/seed bindings, GPU scope and every ZIP CRC/payload.
[Browser QA](gtx1650super-sampling-wipe/browser-qa.json) checks fit, exact wipe
pixels at 0/50/100%, swap, dragging to 75%, keyboard extremes, registered literal
rotation, different-grid handling, frame navigation, PNG download and desktop/
narrow layouts with no page errors. Five wipe/registration and three sampling
tests supplement the existing parser/renderer tests.

Source-bound scripts, from the repository root after normal setup:

```powershell
node scripts/prepare_cuda_sampling.mjs build/qualification-tools/node_modules/playwright/index.mjs build/qualification/quality80-prepared build/exports/ansi-quality80 build/qualification/sampling80-prepared
node scripts/run_cuda_sampling.mjs build/direct-native/pnggpu_cuda_worker.exe build/qualification/sampling80-prepared build/exports/ansi-quality80 build/exports/ansi-sampling80
python scripts/render_sampling_previews.py build/exports/ansi-sampling80 build/exports/ansi-quality80
python scripts/package_ansi_comparison.py build/exports/ansi-sampling80 build/exports/ansi-sampling80-viewer
```

Preserve the earlier raw preparation/quality receipts and normal worker
source/hash/licenses. Use new output paths after changing a plan, and never
bypass admission or stopped-run evidence. The portable viewer needs no toolchain.
