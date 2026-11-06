# Exact ANSI frame comparison

Open `index.html` in Chrome or Edge. No server or installation is needed. Extract
the earlier delivery ZIP, then choose its root folder (containing `settings.json`)
with **Open extracted export folder**. You can also drag a folder onto the import
area. MP4 files and raw tuple buffers are never loaded by the viewer.

The small generated quality-study ZIP loads its 35 presets automatically.
Its `demo.js` embeds only local settings/ANSI/checksum data; the repository's
placeholder is empty. The default single-pane view keeps A/B/C at the same
pixel origin. Choose Side by side when inspecting several panes together.

The initial grid is **80x25** when available. A selects 4x8 samples and B selects
8x16; C selects a third variant when present. Each selector is independent. Add
another export folder to compare new experiment packs alongside the delivery.

Choose one exact frame number for all three panes. Arrow keys step frames; Shift
steps ten available frames. Sparse packs work: controls use only the intersection
of actual frame numbers available in A/B/C. The time shown is the source frame's
timestamp, not a video seek approximation. Keys **1**, **2**, **3** switch between
A/B/C in the same screen position; choose **Side by side** to see all three.
Pixel zoom uses nearest-neighbor scaling. Scroll positions can be linked.

The original `.ans` files are **CP437 bytes**, with ASCII ANSI SGR sequences. They
are not UTF-8 text. The viewer safely decodes only supported 16-color SGR and
glyph bytes; it rejects cursor/OSC/other terminal commands. It paints the exact
`highAtlas` bitmap and palette from `settings.json`, including the original
float32 coverage rounding. No terminal font substitutions or MP4 compression
affect this view. A glyph/foreground/background change is counted as a changed
cell; rendered RGB pixel differences are counted separately. Neither is a
quality score. Hover over a glyph to inspect all three cell values.

Where `variant/report.json` contains `frames: [{index: frameNumber-1,
ansiSha256: "..."}]`, each loaded ANSI file is checked with SHA-256. Missing
receipts or browser checksum support are labeled. **Save exact PNG** saves the
bitmap rendering without the difference overlay; **Save original ANSI** copies
the original byte stream unchanged.

Keep each pack's `settings.json` and `<variant-key>/ansi/frame_####.ans` paths
intact. Import keys must be unique in a pack, limited to ASCII letters, numbers,
dot, underscore and hyphen. Extra experiment fields and descriptive `label`
values are allowed. Frame count may describe the full source even when only a
few selected frames are included. Up to 96 variants and 50,000 file entries can
be indexed; individual ANSI frames are capped at 2 MiB and rendering at 320x160
characters / 8,388,608 pixels. Nothing is uploaded and no CUDA work is submitted.
