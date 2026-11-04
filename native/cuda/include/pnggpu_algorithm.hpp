#pragma once

#include "pnggpu_common.hpp"

#ifdef __CUDACC__
#define PNGGPU_HD __host__ __device__
#else
#define PNGGPU_HD
#endif

namespace pnggpu {
namespace arithmetic {

// The operation order deliberately follows photographic.wgsl. Do not replace
// with FMA, parallel reductions, half precision or an algebraically rearranged
// expression without a new parity qualification. The CPU implementation below
// is a float32 CUDA oracle, not the original binary64 JavaScript reference.
struct Vec3 { float x, y, z; };
PNGGPU_HD inline Vec3 rgb(std::uint32_t p) {
  return {float(p & 255u), float((p >> 8u) & 255u), float((p >> 16u) & 255u)};
}
PNGGPU_HD inline Vec3 xyz(Float4 p) { return {p.x, p.y, p.z}; }
PNGGPU_HD inline Vec3 add(Vec3 a, Vec3 b) { return {a.x+b.x, a.y+b.y, a.z+b.z}; }
PNGGPU_HD inline Vec3 subtract(Vec3 a, Vec3 b) { return {a.x-b.x, a.y-b.y, a.z-b.z}; }
PNGGPU_HD inline Vec3 multiply(Vec3 a, float b) { return {a.x*b, a.y*b, a.z*b}; }
PNGGPU_HD inline Vec3 divide(Vec3 a, float b) { return {a.x/b, a.y/b, a.z/b}; }
PNGGPU_HD inline float dot(Vec3 a, Vec3 b) { return (a.x*b.x+a.y*b.y)+a.z*b.z; }
PNGGPU_HD inline float clamp_channel(float a) {
  return a < 0.0f ? 0.0f : (a > 255.0f ? 255.0f : a);
}
PNGGPU_HD inline Vec3 clamp(Vec3 a) {
  return {clamp_channel(a.x), clamp_channel(a.y), clamp_channel(a.z)};
}
PNGGPU_HD inline float variance(float a) { return a > 1.0e-8f ? a : 1.0e-8f; }

PNGGPU_HD inline Float4 project(const std::uint32_t* pixels, const float* masks,
                               const Float4* statistics, std::uint32_t samples,
                               std::uint32_t glyph_count, std::uint32_t linear) {
  const std::uint32_t cell = linear / glyph_count;
  const std::uint32_t glyph = linear % glyph_count;
  Vec3 totals{0.0f, 0.0f, 0.0f}, dots{0.0f, 0.0f, 0.0f};
  for (std::uint32_t i = 0; i < samples; ++i) {
    const Vec3 p = rgb(pixels[std::size_t(cell)*samples+i]);
    const float coverage = masks[std::size_t(glyph)*samples+i];
    totals = add(totals, p);
    dots = add(dots, multiply(p, coverage));
  }
  const Float4 stats = statistics[glyph];
  const Vec3 cov = subtract(dots, multiply(totals, stats.x));
  const float explained = dot(cov, cov) / variance(stats.z);
  return {dots.x, dots.y, dots.z, -explained};
}

template<bool GlyphMajor = false>
PNGGPU_HD inline Result select(const std::uint32_t* pixels, const Float4* statistics,
                              const Float4* palette, const Float4* projections,
                              std::uint32_t samples, std::uint32_t glyph_count,
                              std::uint32_t foreground_count,
                              std::uint32_t background_count, std::uint32_t cell) {
  const std::uint32_t keep_count = glyph_count < 32u ? glyph_count : 32u;
  Vec3 totals{0.0f, 0.0f, 0.0f};
  float sum_p2 = 0.0f;
  for (std::uint32_t i = 0; i < samples; ++i) {
    const Vec3 p = rgb(pixels[std::size_t(cell)*samples+i]);
    totals = add(totals, p);
    sum_p2 = sum_p2 + dot(p, p);
  }
  std::uint32_t shortlist[32];
  float shortlist_scores[32];
  std::uint32_t shortlist_size = 0;
  float best_seed_score = 3.402823466e+38f;
  std::uint32_t seed_glyph = glyph_count;
  for (std::uint32_t glyph = 0; glyph < glyph_count; ++glyph) {
    const Float4 projection = projections[std::size_t(cell)*glyph_count+glyph];
    const float score = projection.w;
    if (shortlist_size < keep_count || score < shortlist_scores[shortlist_size-1u]) {
      std::uint32_t position = shortlist_size;
      if (position >= keep_count) position = keep_count-1u;
      while (position != 0u && score < shortlist_scores[position-1u]) {
        shortlist[position] = shortlist[position-1u];
        shortlist_scores[position] = shortlist_scores[position-1u];
        --position;
      }
      shortlist[position] = glyph;
      shortlist_scores[position] = score;
      if (shortlist_size < keep_count) ++shortlist_size;
    }
    if (score < best_seed_score) {
      best_seed_score = score;
      seed_glyph = glyph;
    }
  }
  // Intermediate record minima never affect the shortlist or color search.
  // Evaluate the final seed once, preserving its expression grouping, first
  // strict winner and the original zero seed if no score beats the sentinel.
  Vec3 seed_fg{0.0f, 0.0f, 0.0f}, seed_bg{0.0f, 0.0f, 0.0f};
  if (seed_glyph < glyph_count) {
    const Float4 stats = statistics[seed_glyph];
    const Float4 projection = projections[std::size_t(cell)*glyph_count+seed_glyph];
    const Vec3 beta = divide(subtract(xyz(projection), multiply(totals, stats.x)),
                             variance(stats.z));
    seed_bg = clamp(subtract(divide(totals, float(samples)), multiply(beta, stats.x)));
    seed_fg = clamp(add(seed_bg, beta));
  }
  std::uint32_t fg_ids[16];
  float fg_scores[16];
  std::uint32_t fg_len = 0;
  for (std::uint32_t color = 0; color < 16; ++color) {
    const Vec3 diff = subtract(seed_fg, xyz(palette[color]));
    const float distance = dot(diff, diff);
    if (fg_len < foreground_count || distance < fg_scores[fg_len-1u]) {
      std::uint32_t pos = fg_len < foreground_count ? fg_len : foreground_count-1u;
      while (pos != 0u && distance < fg_scores[pos-1u]) {
        fg_ids[pos] = fg_ids[pos-1u];
        fg_scores[pos] = fg_scores[pos-1u];
        --pos;
      }
      fg_ids[pos] = color;
      fg_scores[pos] = distance;
      if (fg_len < foreground_count) ++fg_len;
    }
  }
  std::uint32_t bg_ids[8];
  float bg_scores[8];
  std::uint32_t bg_len = 0;
  for (std::uint32_t color = 0; color < 8; ++color) {
    const Vec3 diff = subtract(seed_bg, xyz(palette[color]));
    const float distance = dot(diff, diff);
    if (bg_len < background_count || distance < bg_scores[bg_len-1u]) {
      std::uint32_t pos = bg_len < background_count ? bg_len : background_count-1u;
      while (pos != 0u && distance < bg_scores[pos-1u]) {
        bg_ids[pos] = bg_ids[pos-1u];
        bg_scores[pos] = bg_scores[pos-1u];
        --pos;
      }
      bg_ids[pos] = color;
      bg_scores[pos] = distance;
      if (bg_len < background_count) ++bg_len;
    }
  }
  float best_error = 3.402823466e+38f;
  Result chosen{0, 0, 0, 0};
  if constexpr(GlyphMajor) {
    // Keep the original fi/bi/gi order as an explicit tie rank while visiting
    // one glyph's projection once instead of reloading it for every color pair.
    std::uint32_t best_rank = 0;
    for (std::uint32_t gi = 0; gi < shortlist_size; ++gi) {
      const auto glyph = shortlist[gi];
      const Float4 stats = statistics[glyph];
      const Vec3 dot_rgb = xyz(projections[std::size_t(cell)*glyph_count+glyph]);
      for (std::uint32_t fi = 0; fi < foreground_count; ++fi) {
        const auto foreground_id = fg_ids[fi];
        const Vec3 fg = xyz(palette[foreground_id]);
        for (std::uint32_t bi = 0; bi < background_count; ++bi) {
          const auto background_id = bg_ids[bi];
          const Vec3 bg = xyz(palette[background_id]);
          const Vec3 d = subtract(fg, bg);
          const float error = sum_p2 + float(samples)*dot(bg, bg)
            + 2.0f*dot(bg, d)*stats.x*float(samples)
            + dot(d, d)*stats.y
            - 2.0f*dot(bg, totals) - 2.0f*dot(d, dot_rgb);
          const auto rank = (fi*background_count+bi)*shortlist_size+gi;
          if (error < best_error || (error == best_error && rank < best_rank)) {
            best_error = error; best_rank = rank;
            chosen = {glyph, foreground_id, background_id, 0};
          }
        }
      }
    }
  } else {
  for (std::uint32_t fi = 0; fi < foreground_count; ++fi) {
    const std::uint32_t foreground_id = fg_ids[fi];
    const Vec3 fg = xyz(palette[foreground_id]);
    for (std::uint32_t bi = 0; bi < background_count; ++bi) {
      const std::uint32_t background_id = bg_ids[bi];
      const Vec3 bg = xyz(palette[background_id]);
      const Vec3 d = subtract(fg, bg);
      for (std::uint32_t gi = 0; gi < shortlist_size; ++gi) {
        const std::uint32_t glyph = shortlist[gi];
        const Float4 stats = statistics[glyph];
        const Vec3 dot_rgb = xyz(projections[std::size_t(cell)*glyph_count+glyph]);
        const float error = sum_p2 + float(samples)*dot(bg, bg)
          + 2.0f*dot(bg, d)*stats.x*float(samples)
          + dot(d, d)*stats.y
          - 2.0f*dot(bg, totals) - 2.0f*dot(d, dot_rgb);
        if (error < best_error) {
          best_error = error;
          chosen = {glyph, foreground_id, background_id, 0};
        }
      }
    }
  }
  }
  return chosen;
}

} // namespace arithmetic
} // namespace pnggpu

#undef PNGGPU_HD
