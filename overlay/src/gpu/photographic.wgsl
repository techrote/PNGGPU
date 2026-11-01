// PNG2ANSI GPU-005: 2-D tiled photographic 32-glyph shortlist / classic ANSI palette.
// Two passes: (cell,glyph) projection, then per-cell candidate selection.
// No approximation of the current shortlist or palette candidate counts.
struct Params {
  geometry: vec4<u32>, // projection workgroups-X, unused, sample_width, sample_height
  counts: vec4<u32>,   // glyph_count, foreground_count, background_count, tile_cell_count
};
@group(0) @binding(0) var<uniform> settings: Params;
@group(0) @binding(1) var<storage, read> pixels: array<u32>; // RGB8 encoded R | G<<8 | B<<16
@group(0) @binding(2) var<storage, read> masks: array<f32>; // glyph-major low-resolution masks
@group(0) @binding(3) var<storage, read> mask_stats: array<vec4<f32>>; // mean, sumSquares, centredSumSquares, 0
@group(0) @binding(4) var<storage, read> palette: array<vec4<f32>>; // classic 16 colours
@group(0) @binding(5) var<storage, read_write> projections: array<vec4<f32>>; // dot RGB, negative explained variance
@group(0) @binding(6) var<storage, read_write> results: array<vec4<u32>>; // glyph index, foreground, background, 0

fn rgb(p: u32) -> vec3<f32> {
  return vec3<f32>(f32(p & 255u), f32((p >> 8u) & 255u), f32((p >> 16u) & 255u));
}
fn source_offset(cell: u32, sample: u32) -> u32 {
  // Host repacks each bounded tile into cell-major RGB8. Unchanged per-cell
  // sample order preserves the untiled matching equations and candidate ties.
  return cell * (settings.geometry.z * settings.geometry.w) + sample;
}

@compute @workgroup_size(64)
fn project_glyphs(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell_count = settings.counts.w;
  let glyph_count = settings.counts.x;
  let n = settings.geometry.z * settings.geometry.w;
  let linear = id.x + id.y * (settings.geometry.x * 64u);
  if (linear >= cell_count * glyph_count) { return; }
  let cell = linear / glyph_count;
  let glyph = linear % glyph_count;
  var totals = vec3<f32>(0.0);
  var dots = vec3<f32>(0.0);
  for (var i = 0u; i < n; i = i + 1u) {
    let p = rgb(pixels[source_offset(cell, i)]);
    let coverage = masks[glyph * n + i];
    totals = totals + p;
    dots = dots + p * coverage;
  }
  let stats = mask_stats[glyph];
  let cov = dots - totals * stats.x;
  let explained = dot(cov, cov) / max(stats.z, 0.00000001);
  projections[linear] = vec4<f32>(dots, -explained);
}

// Stable insertion sort preserves source glyph order when scores are equal.
@compute @workgroup_size(64)
fn select_cells(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.x;
  let cell_count = settings.counts.w;
  if (cell >= cell_count) { return; }
  let n = settings.geometry.z * settings.geometry.w;
  let glyph_count = settings.counts.x;
  let keep_count = min(32u, glyph_count);
  var totals = vec3<f32>(0.0);
  var sum_p2 = 0.0;
  for (var i = 0u; i < n; i = i + 1u) {
    let p = rgb(pixels[source_offset(cell, i)]);
    totals = totals + p;
    sum_p2 = sum_p2 + dot(p, p);
  }

  var shortlist: array<u32, 32>;
  var shortlist_scores: array<f32, 32>;
  var shortlist_size = 0u;
  var best_seed_score = 3.402823466e+38;
  var seed_fg = vec3<f32>(0.0);
  var seed_bg = vec3<f32>(0.0);
  for (var glyph = 0u; glyph < glyph_count; glyph = glyph + 1u) {
    let projection = projections[cell * glyph_count + glyph];
    let score = projection.w;
    if (shortlist_size < keep_count || score < shortlist_scores[shortlist_size - 1u]) {
      var position = shortlist_size;
      if (position >= keep_count) { position = keep_count - 1u; }
      loop {
        if (position == 0u || !(score < shortlist_scores[position - 1u])) { break; }
        shortlist[position] = shortlist[position - 1u];
        shortlist_scores[position] = shortlist_scores[position - 1u];
        position = position - 1u;
      }
      shortlist[position] = glyph;
      shortlist_scores[position] = score;
      shortlist_size = min(keep_count, shortlist_size + 1u);
    }
    if (score < best_seed_score) {
      best_seed_score = score;
      let stats = mask_stats[glyph];
      let beta = (projection.xyz - totals * stats.x) / max(stats.z, 0.00000001);
      seed_bg = clamp(totals / f32(n) - beta * stats.x, vec3<f32>(0.0), vec3<f32>(255.0));
      seed_fg = clamp(seed_bg + beta, vec3<f32>(0.0), vec3<f32>(255.0));
    }
  }

  var fg_ids: array<u32, 16>;
  var fg_scores: array<f32, 16>;
  var fg_len = 0u;
  for (var color = 0u; color < 16u; color = color + 1u) {
    let diff = seed_fg - palette[color].xyz;
    let distance = dot(diff, diff);
    if (fg_len < settings.counts.y || distance < fg_scores[fg_len - 1u]) {
      var pos = min(fg_len, settings.counts.y - 1u);
      loop {
        if (pos == 0u || !(distance < fg_scores[pos - 1u])) { break; }
        fg_ids[pos] = fg_ids[pos - 1u];
        fg_scores[pos] = fg_scores[pos - 1u];
        pos = pos - 1u;
      }
      fg_ids[pos] = color;
      fg_scores[pos] = distance;
      fg_len = min(settings.counts.y, fg_len + 1u);
    }
  }
  var bg_ids: array<u32, 8>;
  var bg_scores: array<f32, 8>;
  var bg_len = 0u;
  for (var color = 0u; color < 8u; color = color + 1u) {
    let diff = seed_bg - palette[color].xyz;
    let distance = dot(diff, diff);
    if (bg_len < settings.counts.z || distance < bg_scores[bg_len - 1u]) {
      var pos = min(bg_len, settings.counts.z - 1u);
      loop {
        if (pos == 0u || !(distance < bg_scores[pos - 1u])) { break; }
        bg_ids[pos] = bg_ids[pos - 1u];
        bg_scores[pos] = bg_scores[pos - 1u];
        pos = pos - 1u;
      }
      bg_ids[pos] = color;
      bg_scores[pos] = distance;
      bg_len = min(settings.counts.z, bg_len + 1u);
    }
  }

  var best_error = 3.402823466e+38;
  var chosen = vec4<u32>(0u);
  for (var fi = 0u; fi < settings.counts.y; fi = fi + 1u) {
    let foreground_id = fg_ids[fi];
    let fg = palette[foreground_id].xyz;
    for (var bi = 0u; bi < settings.counts.z; bi = bi + 1u) {
      let background_id = bg_ids[bi];
      let bg = palette[background_id].xyz;
      let d = fg - bg;
      for (var gi = 0u; gi < shortlist_size; gi = gi + 1u) {
        let glyph = shortlist[gi];
        let stats = mask_stats[glyph];
        let dot_rgb = projections[cell * glyph_count + glyph].xyz;
        let error = sum_p2 + f32(n) * dot(bg, bg)
          + 2.0 * dot(bg, d) * stats.x * f32(n)
          + dot(d, d) * stats.y
          - 2.0 * dot(bg, totals) - 2.0 * dot(d, dot_rgb);
        if (error < best_error) {
          best_error = error;
          chosen = vec4<u32>(glyph, foreground_id, background_id, 0u);
        }
      }
    }
  }
  results[cell] = chosen;
}
