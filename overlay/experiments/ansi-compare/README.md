# Exact ANSI frame comparison

Open `index.html` in Chrome or Edge. No server or installation is needed. Extract
the earlier delivery ZIP, then choose its root folder (containing `settings.json`)
with **Open extracted export folder**. You can also drag a folder onto the import
area. MP4 files and raw tuple buffers are never loaded by the viewer.

The generated quality-study ZIP loads its included presets automatically.
Its `demo.js` embeds only local settings/ANSI/checksum data; the repository's
placeholder is empty. No files are uploaded and the viewer performs no matching work.

The initial comparison group is **80x25** when available. A selects 4x8 samples and B selects
8x16; C selects a third variant when present. Each selector is independent. Add
another export folder to compare new experiment packs alongside the delivery.

The default **A/B side by side** view fits both complete images at one common
scale. **A/B/C side by side** retains all three panes. Fit mode changes display
size only; select integer pixel zoom for exact pixel inspection. Larger images
can scroll with linked positions.

**In-frame A/B divider** reveals identical image coordinates from A and B on one
canvas. Drag the divider/image or use the position range. Focus the divider
handle and use Left/Right (Shift steps ten percent), Home or End. At zero the
image is all B; at 100 percent it is all A. **Swap left/right** reverses the
sources. Saving the comparison PNG preserves the full-resolution split without
its draggable line. Different display dimensions disable the wipe instead of
stretching images to fake registration.

Choose one exact frame number for the active comparison. Arrow keys step frames; Shift
steps ten available frames. Sparse packs work: controls use only the intersection
of actual frame numbers in A/B for pair/divider views, or A/B/C in other views. The time shown is the source frame's
timestamp, not a video seek approximation. Keys **1**, **2**, **3** switch between
A/B/C in the same screen position; choose **A/B/C side by side** to see all three.
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

Optional display metadata supports rotated candidates without changing ANSI
bytes: `displayRotationDegrees` is 0/90/180/270 degrees clockwise, and
`comparisonGroup: "80x25"` includes a native 25x80 candidate in that aligned
comparison. Rendering applies an exact pixel permutation; PNG downloads use
the displayed orientation, while ANSI downloads retain native orientation.
For the swapped-cell case, 25x80 cells at 16x8 pixels render 400x640 natively;
a 270-degree alignment gives 640x400. Cell differences/overlays are disabled
when native grids, cell sizes or display rotations are incompatible. Aligned
pixel differences and wipe remain available. Hover inspection maps each shared
display pixel back to each candidate's own native cell coordinates.
