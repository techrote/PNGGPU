# Exact 80x25 quality comparison — 6 November 2026

The [export latency analysis](GTX1650SUPER_SAMPLE_LATENCY.md) compares all twelve
grids without running another video benchmark. At 80x25, warm FP32 mean fit
latency is 3.135 ms / 319.0 reciprocal FPS at 4x8 samples versus 4.778 ms /
209.3 FPS at 8x16. These exclude source decoding, ANSI/files, monitoring and
encoding. Each arm has 695 warm frames; all 24 context-first frames are excluded.

## Open the comparison

Local app: `build/exports/ansi-quality80-viewer/index.html`.
Local portable ZIP: `build/exports/ansi-quality80-viewer.zip` (1,211,346 bytes),
SHA-256 `5ae2f285ad8cfcdcd9f026b5ddc59da3b26b2931477fbbf5806438309a7caf7b`.
Extract and open index.html in Chrome/Edge. The study loads automatically.

- 35 configurations, each at exact source frames **1, 360 and 719**: 105 ANSI files.
- A/B/C selectors share a frame ID. Keys **1/2/3** switch at the same image origin;
  arrows step available frames. Side-by-side, linked scrolling and pixel zoom
  are also available.
- Difference overlays count changed cells and pixels; they do not rank quality.
  Hover to inspect glyph/foreground/background. Save exact PNG or original ANSI.
- Load the earlier full-video ZIP's extracted folder to inspect all 719 frames
  of its original configurations. Selecting a sparse study preset restricts
  shared navigation to 1/360/719. No server, uploads or matching GPU work is used
  by this app.

Rendering uses the original saved bitmap atlas/palette, not terminal fonts or
lossy MP4 frames. The original ANSI glyph bytes are **CP437**, with ASCII SGR
color escapes; the earlier ZIP README's UTF-8 label was inaccurate. Existing
bytes require no conversion. The old 1.39 GB ZIP has not been modified, and the
export README generator now labels encoding correctly.

## What the first screen investigates

See the [parameter map](GTX1650SUPER_PARAMETER_MAP.md) for source paths, controls,
ranges and the complete configuration matrix. The pack contains:

- Original FFmpeg-Lanczos 4x8/8x16 export bytes as two preserved baselines.
- Photographic CUDA FP32 with 4x8, 8x8, 4x16 and 8x16 sampling, separating the
  horizontal and vertical changes.
- Browser resampling choices, 3/3 and 12/8 foreground/background candidates,
  contrast, sharpness, gamma, saturation, three NL filter modes and the original
  photographic application preset.
- Original **CPU industrial** reference plus one-factor structure/texture blur,
  edge/texture threshold/range, highlight threshold/range/exponent and accent
  luminance presets. These use neutral image/NL input, and are labelled separately.
  They do not implement an industrial CUDA backend.

All new presets use the unmodified pinned original preprocessing function,
exposed through an in-memory export-list addition. Crop is 768x480 at (43,0),
output is 80x25 / 640x400, font/vocabulary/palette are fixed. Original preprocess
order and byte quantization are retained. The workbench/export had bypassed
these image/NL controls previously. The original application itself consumes
industrial edge/texture/highlight/accent fields only in its industrial fitter;
changing them in a photographic config alone has no effect.

New browser-prepared presets are a separate preparation route from the two
FFmpeg export baselines. Browser “Lanczos” requests Canvas high-quality smoothing;
it is not a promise of the FFmpeg Lanczos kernel. In this Chrome run, **bicubic
(medium) and Lanczos (high) produced identical final tuples on all three 4x8
frames**. That is an observation for these frames/browser, not equivalence of all
resampling algorithms.

Illustrative changed-cell counts against the matching new neutral reference:

| 4x8 preset | Frame 1 | Frame 360 | Frame 719 |
|---|---:|---:|---:|
| Nearest | 514 | 439 | 456 |
| Bilinear / low | 485 | 379 | 388 |
| Bicubic / medium | 0 | 0 | 0 |
| Candidates 12/8 | 152 | 109 | 127 |
| Candidates 3/3 | 481 | 363 | 439 |

Every frame has 2,000 cells. More changed cells do not imply better or worse
legibility. This screen establishes no temporal flicker preference. Choose
promising presets by inspecting the three scenes before testing a short motion
segment; no further full-video parameter sweep ran automatically.

## Evidence and limits

Matching/preparation source: `4f6f6d841effcfcad5958e835707a7e4c1fb52e5`.
The normal source-matched worker remains source
`58cc6e24009cf2e522189bfbeb5c9c4ceaf939bc`, SHA-256
`9724dcdd33594ece5f41cdc8fb5695d86fe0c2b7d80913003a5d37c32e58bad7`.
Source hashes, configuration identities, original PNGs, prepared lengths/hashes
and copied baseline receipts/ANSI are checked before device discovery.

There are **88 bounded GPU frame fits / 176,000 GPU cells** including packet
comparisons, across 22 photographic contexts, and 33 industrial CPU fits. Each
photographic context performs three selected-frame fits and one command-2/3
equivalence check, at depth one, with 10-second frame / 30-second case deadlines.
The native 2 GiB reserve is unchanged. Maximum declared GPU buffers are
15,290,784 bytes; minimum pre-context free snapshot is 3,441,950,720 bytes.
Monitor snapshots, checked after-info identity, process exits and final log query
record no new driver errors. No stress/fault experiment or machine setting ran.
This is not sanitizer, sustained-stability or realtime qualification; PR #2 stays
draft and WebGPU/guarded CUDA defaults are unchanged.

Browser QA covers automatic loading, sparse exact frame navigation, keyboard
switching, original-preview pixel hash equality, byte-identical ANSI downloads,
full original-folder import and desktop/narrow layouts with no page errors.
Seven parser/renderer tests include original CP437/SGR encoding, invalid controls,
all 2,000 actual saved tuples and an independent historical preview pixel hash.
Three quality-plan tests cover finite scope, source exposure and malformed matrix
rejection. [Summary](gtx1650super-quality80/summary.json),
[browser QA](gtx1650super-quality80/browser-qa.json) and
[delivery receipt](gtx1650super-quality80/delivery.json) preserve results. Complete
raw preparation/matching receipts remain in ignored build/qualification and
build/exports directories; the portable pack includes exact ANSI checksums.

The [independent offline audit](gtx1650super-quality80/independent-audit.json)
re-encoded all 105 ANSI files from stored tuples, verified source/prepared/baseline
hashes, device/monitor/process evidence and all 149 ZIP entry CRC/payload hashes.
The [local host log](gtx1650super-quality80/host-tests.txt) records 92 passing
bridge/planning/parser/render/quality checks. The initial engineering CI caught
a CSS checkout-line-ending manifest mismatch; explicit LF checkout and CSS text
hash normalization fix that portability issue without changing any GPU code.
The corrected source `cf2d1f6d629a614bd237a99dc974dd3da581a1af` passes all three
[CI jobs](https://github.com/techrote/PNGGPU/actions/runs/42242373368), including
Windows application/host checks and Windows/Linux CUDA compilation/native tests.

## Reproduction

After setup and verification of the normal worker, from the repository root:

```powershell
node scripts/analyze_cuda_export_latency.mjs build/exports/agenticparkour-fp32-delivery qualification/gtx1650super-sample-latency
node scripts/prepare_cuda_quality.mjs build/qualification-tools/node_modules/playwright/index.mjs benchmarking-material/agenticparkour build/qualification/quality80-prepared
node scripts/run_cuda_quality.mjs build/direct-native/pnggpu_cuda_worker.exe build/qualification/quality80-prepared build/exports/agenticparkour-fp32-delivery build/exports/ansi-quality80
python scripts/package_ansi_comparison.py build/exports/ansi-quality80 build/exports/ansi-quality80-viewer
```

Use fresh output paths for changed source or configuration. Preserve the normal
worker's source/hash receipts and licenses. Do not bypass admission or a stopped
run. The viewer itself accepts the extracted earlier ZIP without any toolchain.
