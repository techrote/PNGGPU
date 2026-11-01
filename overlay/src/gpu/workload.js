/** GPU research budget and UI validation: deliberately separate from CPU core. */
// GPU work is constrained by VRAM admission and device capabilities, not by a
// CPU-era estimated-operation gate. Safe integer range still protects reports.
export const GPU_MAX_WORK_UNITS = Number.MAX_SAFE_INTEGER;
export const GPU_SLOW_WORK_WARNING_UNITS = 125_000_000_000;
export const CPU_REFERENCE_WORK_UNITS = 125_000_000;
export const WORKBENCH_LIMITS = Object.freeze({
  columns: [16, 1024, "Columns"],
  rows: [8, 1024, "Rows"],
  sampleW: [1, 32, "Sample width"],
  sampleH: [1, 64, "Sample height"],
  foreground: [1, 12, "Foreground colours"],
  background: [1, 8, "Background colours"]
});

/** An exact copy of PNG2ANSI's cost estimate for photographic mode. */
export function photographicWorkUnits({columns, rows, sampleW, sampleH, foreground, background}, glyphCount) {
  if (!Number.isSafeInteger(glyphCount) || glyphCount < 1) throw new RangeError("Glyph count must be a positive integer");
  const cells = columns * rows;
  const samples = sampleW * sampleH;
  const projection = glyphCount * (samples * 3 + 12);
  const fitting = Math.min(32, glyphCount) * foreground * background * 3;
  const total = cells * (projection + fitting);
  if (!Number.isSafeInteger(total)) throw new RangeError("Estimated work units overflow JavaScript's exact integer range");
  return total;
}

export function validateWorkbenchInputs(input) {
  const settings = {};
  for (const [key, [min, max, label]] of Object.entries(WORKBENCH_LIMITS)) {
    const raw = input[key];
    const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
    if (raw === "" || raw == null || !Number.isSafeInteger(n)) {
      throw new RangeError(`${label}: enter a whole number from ${min} to ${max} (received ${JSON.stringify(raw)})`);
    }
    if (n < min || n > max) {
      throw new RangeError(`${label}: ${n} is outside the supported ${min}–${max} range (PNG2ANSI reference schema). ` +
        `The original CPU reference supports smaller maximum settings.`);
    }
    settings[key] = n;
  }
  return settings;
}

export function validateGpuBudget(settings, glyphCount, ceiling = GPU_MAX_WORK_UNITS) {
  if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new RangeError("GPU work-unit ceiling must be a positive safe integer");
  const workUnits = photographicWorkUnits(settings, glyphCount);
  if (workUnits > ceiling) {
    throw new RangeError(`GPU workload ${workUnits.toLocaleString("en-US")} exceeds the ${ceiling.toLocaleString("en-US")} work-unit research ceiling. ` +
      `Reduce output geometry, sampling or candidates; GPU tiling handles dispatch/buffer limits but not unlimited memory or processing time.`);
  }
  return workUnits;
}
