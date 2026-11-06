# Photographic parameters and a bounded 80x25 quality lab

Source inspection only, 6 November 2026. No new matching, GPU/browser work or
quality ranking was performed. The reconstructed original CPU application is
pinned to `67ae97295ab9a9ab32fdee5410c2371e4b21ce87` by
`scripts/setup.ps1:6`. `PNG2ANSI/` is ignored and reconstructed by setup.

## Which path actually consumes a setting?

| Setting | Original application | Current photographic CUDA workbench | Completed 24-video export |
|---|---|---|---|
| Samples/cell | Changes source raster and averaged glyph masks | Passed to masks and fitter | 4x8 or 8x16, explicitly applied |
| Foreground/background candidates | `photoFit` searches those nearest palette candidates | Explicitly forwarded to CUDA | Fixed 6/5 |
| Image brightness, contrast, saturation, sharpness, gamma | Applied by `preprocess` before either style | Forced to neutral; preprocessing is bypassed | Not applied |
| NL filter: trimmed mean, optimal estimation, edge enhancement | Applied before tonal adjustments, for either style | Disabled and bypassed | Not applied |
| Derez | Optional intermediate resize before adjustments, then final resize | Disabled and bypassed | Not applied |
| Resampler | Canvas2D smoothing hint, not explicit named convolution kernels | Always smoothing enabled / quality high | Actual FFmpeg `flags=lanczos` |
| Industrial structure/texture blur, edge/texture/highlight/accent controls | Used only by `industrialFit` | Not implemented by the photographic CUDA objective | Not applied |
| Font size, cell dimensions, vocabulary | Rebuild glyph masks/codes; cell dimensions also change rendering | Fixed original defaults in current workbench config | Original 8x16 cell, 14px font, full CP437 vocabulary, duplicate masks removed |
| Tile budget, transport, depth | Not quality controls | Scheduling/storage controls | Depth one, bounded tiles |

Exact source references:

* Original defaults and validated ranges: `PNG2ANSI/src/core.js:10-39`.
  Original image defaults are brightness 1, contrast .85, saturation 1.8,
  gamma 1, sharpness 1.2; NL edge enhancement is enabled, radius 1, alpha .9.
  These are **not** the neutral workbench/export preparation settings.
* Original `glyphMasks`, `core.js:139-158`, rasterizes the high glyph atlas and
  averages its coverage into the requested sample lattice. Sample count changes
  matching detail, not the 8x16 rendered character dimensions.
* `smoothing`, `core.js:160`: nearest disables smoothing; bilinear requests low;
  bicubic requests medium; lanczos requests high. The names do not guarantee
  that the browser performs those mathematical kernels. Browser version matters.
* `nlFilterPixels`, `core.js:161-179`, is a seven-point neighborhood operation.
  Radius .33-1 controls a continuous mix toward neighbor values, not a generic
  Gaussian radius. Edge enhancement is separate from the industrial edge map.
* `preprocess`, `core.js:181-193`, executes: initial resize (or Derez resize),
  optional NL filter, brightness then contrast then saturation, sharpness,
  gamma, and an optional final resize. Gamma is the power `1/gamma`.
  Both styles receive this source; `convert` dispatches afterward at line 237.
* `photoFit`, `core.js:199-218`, keeps a 32-glyph shortlist and uses requested
  foreground/background quantities at lines 214-215. Foregrounds draw from 16
  colors; backgrounds from eight. Increasing quantities changes fitting work
  and can change output; it does not enlarge the ANSI palette. Supported counts
  are foreground 1-12, background 1-8 (`core.js:30`).
* `industrialFit`, `core.js:221-233`, constructs luminance/saturation maps,
  Gaussian structure/texture blurs, and edge/texture/highlight/accent-driven ink.
  It then searches foreground colors 1-15 on black background at line 231.
  Photographic candidate-count controls are not used in this industrial search.
  Moving industrial sliders while retaining photographic style does nothing.
* The UI exposes these controls in `PNG2ANSI/src/app.js:8-41`; UI presence does
  not imply that every style consumes every field. `industrial.sparsity_threshold`
  is even present in the basic controls at line 22, but remains industrial-only.
* Workbench `makeConfig`, `overlay/experiments/webgpu/photographic.html:310-320`,
  neutralizes image adjustments and disables NL/Derez. Its ordinary preparation
  at lines 362-364 directly stretches the bitmap to the sample raster with
  Canvas2D high-quality smoothing; it does not call original `preprocess`.
  Lines 392-395 pass prepared RGBA, masks, geometry and candidate counts to the
  selected fitter. The industrial configuration is never sent to CUDA.
* Export `scripts/cuda_export_plan.mjs:8-18` supplies crop/pad plus FFmpeg
  Lanczos scaling. `scripts/export_cuda_sequence.mjs:23` decodes that raw RGBA;
  line 37 fixes 6/5 candidates. `prepare_cuda_export.mjs:31` uses workbench
  `makeConfig` for the atlas/config. Merely changing `config.image` or
  `config.canvas.resampler` in that receipt would not apply a new export filter.

## Implementable selected-frame path

Keep the existing completed export immutable. A new lab should prepare its own
80x25 input fixtures and record the complete effective configuration and actual
preparation route, then call the unchanged photographic fitter. Use the same
768x480 source crop at (43,0) for every case, the original palette/font/codes,
8x16 rendering, FP32 mode and the same compiled candidate traversal.

There are two honest preparation routes:

1. For exact export controls, retain the FFmpeg route and expose its explicit
   nearest/bilinear/bicubic/lanczos filter choice. Its neutral Lanczos cases can
   be checked against the saved export input-RGBA hashes and existing tuples.
2. For original PNG2ANSI image/NL/Derez semantics, use a small source-bound CPU
   preparation page. The selected lab adds `qualityPreprocess:preprocess` and
   `qualityIndustrialFit:industrialFit` only to the in-memory export list at
   `core.js:239`; it preserves every original function body/helper. The pinned
   source hash and unique export boundary must be checked. Validate the effective
   configuration through the original schema. Avoid `PNG2ANSI.convert` for
   photographic preparation, which would also run its CPU matcher. `preprocess`
   is not originally public; the ordinary export list exposes `nlFilterPixels`
   but not `preprocess`.

Hash the exact extracted sources and bitmap/crop, retain the prepared RGBA
hash, and pass that same RGBA to every compared matcher. The existing minimal
`imagePreparationHtml` in `scripts/cuda_image_fixture.mjs:40-56` is the model for
source-bound extraction, but currently exposes only masks/config. Bound every
browser evaluation and retain independent cleanup/error receipts. Do not modify
the ignored pinned CPU source or imply that browser “lanczos” equals FFmpeg
Lanczos. Label those as separate preparation routes.

Candidate changes require a new immutable fitter/frame-session configuration
and INIT packet. Image adjustments require new RGBA preparation. Sample changes
require new masks and RGBA. None requires a new native matcher or objective.
Industrial mode would require a separate implementation/qualification; its
floating stylized pixels cannot simply be called a photographic CUDA equivalent.

## Selected small experiment plan

The selected implementation uses source frames **1, 360 and 719** (one-based),
80x25 characters and the **same browser preparation route** for all new cases.
This section describes the plan, not completed quality evidence. Neutral input
means brightness/contrast/saturation/sharpness/gamma 1, NL/Derez off, Canvas high
smoothing and 6/5 colors. Font, vocabulary, output cell size and source crop stay
fixed.

| Group | Changes from its reference | Configurations |
|---|---|---:|
| Sampling axes | 4x8, 8x8, 4x16, 8x16; independently distinguish added horizontal/vertical samples | 4 |
| Resampling | nearest, bilinear/low, bicubic/medium, each at 4x8 and 8x16 | 6 |
| Candidate counts | foreground/background 3/3 and 12/8, each at 4x8 and 8x16 | 4 |
| Image controls | contrast 1.2, sharpness 1.5, gamma 1.2, saturation 1.25; one change per 4x8 case | 4 |
| NL filter | edge-enhancement, optimal-estimation, alpha-trimmed-mean; each radius 1, alpha .5 at 4x8 | 3 |
| Original photographic preset | Original image defaults plus default NL filter; a deliberately bundled profile | 1 |
| Industrial reference | Original CPU industrial fitter and industrial defaults, with neutral image/NL preparation at 4x8 | 1 |
| Industrial factors | One parameter per case against that industrial reference: structure blur 0, texture blur 3, edge threshold 5, edge range 100, texture threshold 8, texture range 100, highlight threshold 90, highlight range 180, highlight exponent 3, accent luminance scale 80 | 10 |

There are **33 new configurations: 22 photographic CUDA and 11 industrial CPU**.
The two existing FFmpeg-Lanczos export configurations supply six copied baseline
ANSI stills; they are separate preparation routes, not extra CUDA fits. Total
delivery scope is **35 configurations / 105 ANSI stills**. Photographic cases
make three selected-frame conversions and one packet-format comparison each:
**88 GPU frame fits / 176,000 GPU cells**. Industrial cases make 33 CPU fits.
This is a one-factor screen, not the Cartesian product of these controls and not
another full-video run. Do not conflate the preparation-engine difference with
one slider, or label the industrial neutral-input reference as the full original
web application's industrial preset.

Preserve the 2 GiB reserve, depth one, 10-second per-frame deadline, bounded
sublaunches and an explicit four-frame-fit maximum per photographic context
(including the packet comparison). Validate the exact configurations, frame
identities, prepared sample lengths/hashes and source list before discovery;
retain monitor/cleanup and final driver evidence. No repeat/stress loop or fault
injection is needed for this visual screen. Render pixel-faithful PNGs
and original ANSI, and show prepared input samples/crop beside output so halos,
lost geometry and color clipping are visible. Compare within each frame and
sample setting; record tuple/ANSI changes, foreground/background histograms,
preparation time and matching time separately. A larger color search may improve
the configured numerical objective without improving perceived legibility.
These stills establish neither motion stability/flicker nor CPU parity of FP32.

If a profile looks useful across all three frames, a subsequent small paired
motion segment can test temporal behavior. Choose that follow-up explicitly;
do not automatically expand every profile into the 719-frame export.
