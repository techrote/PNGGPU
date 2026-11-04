"""Check arithmetic CLI validation on CPU-only build hosts; never launch CUDA work."""
import json
import os
from pathlib import Path
import subprocess
import sys

worker = Path(sys.argv[1]) / ("pnggpu_cuda_worker.exe" if os.name == "nt" else "pnggpu_cuda_worker")
help_result = subprocess.run([str(worker), "--help"], capture_output=True, text=True, timeout=5)
assert help_result.returncode == 0 and "binary64-direct" in help_result.stdout
assert "float32-direct" in help_result.stdout and "float16-mixed" in help_result.stdout
for args, expected in [
    (["--info", "--arithmetic-mode", "unknown"], "Unsupported CUDA arithmetic mode"),
    (["--info", "--arithmetic-mode"], "Specify --arithmetic-mode once"),
    (["--info", "--arithmetic-mode", "binary64-direct", "--arithmetic-mode", "binary64-direct"], "Specify --arithmetic-mode once"),
    (["--self-test", "--arithmetic-mode", "binary64-direct"], "Guard certification self-test requires guarded mode"),
    (["--self-test", "--arithmetic-mode", "float32-direct"], "Guard certification self-test requires guarded mode"),
    (["--self-test", "--arithmetic-mode", "float16-mixed"], "Guard certification self-test requires guarded mode"),
]:
    result = subprocess.run([str(worker), *args], capture_output=True, text=True, timeout=5)
    assert result.returncode == 1 and expected in json.loads(result.stdout)["error"], (args, result.stdout)
print("CUDA arithmetic CLI: 7 host-only checks passed (no device discovery or GPU work)")
