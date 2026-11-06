# WDDM qualification interruption — 4 November 2026

**Desktop stability failed / sustained qualification incomplete. PR #2 stays draft.**

The user reported two PC lockups during fault/pressure testing. The runner and
all its native workers were stopped immediately. No subsequent GPU stress or
sanitizer tests were run. No TDR delay or watchdog settings were changed.

## Completed sanitizer validation

NVIDIA's supplied debugger prerequisite was enabled through an elevated process:
`HKLM\SOFTWARE\NVIDIA Corporation\GPUDebugger\EnableInterface` DWORD is now 1.
This machine setting remains enabled. The original value was absent.

Compute Sanitizer12.8.93 memcheck then instrumented the exact CI worker from
`0e8993d4fb71bbe740b786385b1f2ddc2b5feb86`, SHA-256
`4eb8267c0986aa5d2f5cce2096b83481b52014bc25212a43c4fd8c0994290ebc`.
Its45case/2926cell self-test passed with **ERROR SUMMARY:0errors**.
See [sanitizer log](memcheck-0e8993d.txt). This is a real instrumentation pass for
that source/binary, not a claim about later diagnostic-source revisions.

## Interrupted development experiment

The separate fault worker is opt-in at CMake configure time and not installed
as the production worker. A development run based on0e8993d with dirty source
tested an illegal-instruction CUDA context fault, an impossible allocation
after partial construction, and large committed VRAM pressure. Reports retain
the exact worker hashes and dirty-source status; they are not presented as
exact-head qualification of the subsequent safety changes.

The bridge reported each native failure, disposed of its session, then completed
a new512×512/4×8 conversion with zero CPU tuple/ANSI mismatches. Free-memory
snapshots returned to24458035200bytes after each completed fault/recovery pair.

**The pressure experiment was too aggressive for this interactive display GPU.**
It allocated22302162944bytes and observed only1958199296bytes free, below the
intended2GiB floor despite targeting2GiB+8MiB. WDDM/driver costs invalidate that
simple allocation-based reserve assumption. It rejected conversion admission,
but that functional rejection does not establish desktop-safe behavior.

The runner had completed18 stress conversions with exact CPU tuple/ANSI parity
before being stopped. Measured launch maxima were about1.13ms projection and
4.98ms selection. These short event intervals do **not** negate the observed
desktop stalls or prove TDR safety. No duration-based stability pass is claimed.

Windows recorded nvlddmkm event153 at02:28:27.440 and twice at02:28:36.375UTC,
with “Error occurred on GPUID:700”. No Display4101 reset event was found in the
examined window. These records do not establish the precise mechanism of both
user-observed stalls or confirm a full system watchdog reset.

## Restrictions and remaining work

The resilience runner now refuses execution without an explicit desktop-
disruption acknowledgement. The fault worker additionally refuses context/
pressure injection on watchdog-enabled devices. The normal executable has no
fault-injection CLI, and fault-worker compilation defaults OFF. No further
fault, pressure or sustained tests should run on this active display GPU.

Remaining gates: isolate the test GPU/machine; redesign pressure testing with
measured residency/driver overhead and a larger desktop reserve; independently
review the experiment; then test lost-context behavior, low-memory cleanup and
sustained watchdog behavior under controlled conditions. The previous ordinary
CUDA/CPU parity results remain distinct from this failed stability experiment.

- [Interrupted development report](wddm-resilience-interrupted.json)
- [Driver event evidence](wddm-driver-events.json)
- [Earlier successful parity qualification](RECOVERY.md)
