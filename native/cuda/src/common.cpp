#include "pnggpu_common.hpp"
#include "pnggpu_algorithm.hpp"
#include "pnggpu_precise.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <sstream>

namespace pnggpu {

std::size_t checked_product(std::size_t a, std::size_t b, const char* label) {
  if (b != 0 && a > std::numeric_limits<std::size_t>::max()/b)
    throw std::runtime_error(std::string(label)+" size overflow");
  return a*b;
}

std::size_t checked_sum(std::size_t a, std::size_t b, const char* label) {
  if (a > std::numeric_limits<std::size_t>::max()-b)
    throw std::runtime_error(std::string(label)+" size overflow");
  return a+b;
}

Layout validate_parameters(const Parameters& p) {
  if (p.sample_width < 1 || p.sample_width > 32 ||
      p.sample_height < 1 || p.sample_height > 64)
    throw std::runtime_error("Sample dimensions must be 1..32 by 1..64");
  if (p.glyph_count < 1 || p.glyph_count > max_glyph_count)
    throw std::runtime_error("Glyph count must be 1..65535");
  if (p.foreground_count < 1 || p.foreground_count > 12 ||
      p.background_count < 1 || p.background_count > 8)
    throw std::runtime_error("ANSI candidate counts must be foreground 1..12, background 1..8");
  if (p.tile_capacity < 1 || p.tile_capacity > max_tile_cells)
    throw std::runtime_error("Tile capacity must be 1..65536");
  Layout l;
  l.samples = checked_product(p.sample_width, p.sample_height, "Sample geometry");
  l.mask_values = checked_product(p.glyph_count, l.samples, "Atlas");
  l.mask_bytes = checked_product(l.mask_values, sizeof(float), "Atlas");
  l.stats_bytes = checked_product(p.glyph_count, sizeof(Float4), "Statistics");
  l.pixel_bytes = checked_product(checked_product(p.tile_capacity, l.samples, "Tile raster"), 4, "Tile raster");
  l.projection_bytes = checked_product(checked_product(p.tile_capacity, p.glyph_count, "Projections"),
                                       sizeof(Float4), "Projections");
  l.recovery_capacity=std::uint32_t(std::min<std::uint64_t>({p.tile_capacity,max_recovery_cells,
    max_recovery_projection_bytes/(std::uint64_t(p.glyph_count)*sizeof(precise::Projection))}));
  l.recovery_bytes=checked_product(checked_product(l.recovery_capacity,p.glyph_count,"Recovery"),sizeof(precise::Projection),"Recovery");
  l.result_bytes = checked_product(p.tile_capacity, sizeof(Result), "Selections");
  l.init_bytes = checked_sum(checked_sum(32, l.mask_bytes, "INIT"),
                             checked_sum(l.stats_bytes, 16*sizeof(Float4), "INIT"), "INIT");
  if (l.init_bytes > max_message_bytes)
    throw std::runtime_error("INIT exceeds 128 MiB protocol limit");
  if (l.pixel_bytes > max_pixel_bytes || l.projection_bytes > max_projection_bytes)
    throw std::runtime_error("Tile raster/projections exceed native buffer limits");
  l.allocated_bytes = checked_sum(l.mask_bytes, l.stats_bytes, "GPU allocation");
  for (const auto bytes : {16*sizeof(Float4), l.pixel_bytes, l.projection_bytes, l.result_bytes,l.recovery_bytes})
    l.allocated_bytes = checked_sum(l.allocated_bytes, bytes, "GPU allocation");
  return l;
}

void validate_memory_budget(std::size_t allocation, std::uint64_t free_bytes) {
  if (free_bytes < memory_reserve_bytes || allocation > free_bytes-memory_reserve_bytes)
    throw std::runtime_error("CUDA allocation exceeds currently reported free memory minus 2 GiB; close GPU workloads or reduce tile/sample size");
}

std::uint32_t read_u32(const std::vector<std::uint8_t>& bytes, std::size_t at) {
  if (at > bytes.size() || bytes.size()-at < 4)
    throw std::runtime_error("Truncated uint32 in protocol payload");
  return std::uint32_t(bytes[at]) | (std::uint32_t(bytes[at+1]) << 8) |
    (std::uint32_t(bytes[at+2]) << 16) | (std::uint32_t(bytes[at+3]) << 24);
}

void append_u32(std::vector<std::uint8_t>& bytes, std::uint32_t value) {
  for (unsigned i = 0; i < 4; ++i) bytes.push_back(std::uint8_t(value >> (i*8)));
}

void append_float(std::vector<std::uint8_t>& bytes, float value) {
  std::uint32_t bits;
  std::memcpy(&bits, &value, sizeof(bits));
  append_u32(bytes, bits);
}

static float read_float(const std::vector<std::uint8_t>& bytes, std::size_t& at) {
  const std::uint32_t bits = read_u32(bytes, at);
  at += 4;
  float value;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

Float4 compute_statistics(const float* mask, std::size_t samples) {
  // Exactly the browser host's binary64 accumulators followed by Float32Array
  // storage. Compilers must not fuse or reassociate this computation.
  double sum = 0.0, squares = 0.0;
  for (std::size_t i = 0; i < samples; ++i) {
    const double value = mask[i];
    sum += value;
    squares += value*value;
  }
  return {float(sum/double(samples)), float(squares),
          float(std::max(squares-sum*sum/double(samples), 1.0e-8)), 0.0f};
}

Atlas parse_init(const std::vector<std::uint8_t>& payload) {
  if (payload.size() < 32 || payload.size() > max_message_bytes)
    throw std::runtime_error("INIT payload has invalid size");
  if (read_u32(payload, 0) != 1 || read_u32(payload, 4) != protocol_version)
    throw std::runtime_error("Expected INIT command 1 with protocol version 1");
  Atlas atlas;
  atlas.parameters = {read_u32(payload, 8), read_u32(payload, 12), read_u32(payload, 16),
                      read_u32(payload, 20), read_u32(payload, 24), read_u32(payload, 28)};
  atlas.layout = validate_parameters(atlas.parameters);
  if (payload.size() != atlas.layout.init_bytes)
    throw std::runtime_error("INIT byte length does not match sample/glyph geometry");
  atlas.masks.resize(atlas.layout.mask_values);
  atlas.statistics.resize(atlas.parameters.glyph_count);
  atlas.palette.resize(16);
  std::size_t offset = 32;
  for (float& mask : atlas.masks) {
    mask = read_float(payload, offset);
    if (!std::isfinite(mask) || mask < 0.0f || mask > 1.0f)
      throw std::runtime_error("Glyph masks must contain finite values in [0,1]");
  }
  for (std::size_t glyph = 0; glyph < atlas.statistics.size(); ++glyph) {
    auto& stats = atlas.statistics[glyph];
    stats = {read_float(payload, offset), read_float(payload, offset),
             read_float(payload, offset), read_float(payload, offset)};
    const auto expected = compute_statistics(atlas.masks.data()+glyph*atlas.layout.samples,
                                              atlas.layout.samples);
    if (!std::isfinite(stats.x) || !std::isfinite(stats.y) || !std::isfinite(stats.z) ||
        !std::isfinite(stats.w) || stats.x != expected.x || stats.y != expected.y ||
        stats.z != expected.z || stats.w != 0.0f)
      throw std::runtime_error("Glyph statistics do not match browser-compatible float32 mask statistics");
  }
  for (auto& color : atlas.palette) {
    color = {read_float(payload, offset), read_float(payload, offset),
             read_float(payload, offset), read_float(payload, offset)};
    if (!std::isfinite(color.x) || !std::isfinite(color.y) || !std::isfinite(color.z) ||
        !std::isfinite(color.w) || color.x < 0.0f || color.x > 255.0f ||
        color.y < 0.0f || color.y > 255.0f || color.z < 0.0f || color.z > 255.0f ||
        color.w != 0.0f)
      throw std::runtime_error("ANSI palette requires finite RGB values in [0,255] and zero padding");
  }
  return atlas;
}

std::vector<std::uint32_t> parse_tile(const std::vector<std::uint8_t>& payload,
                                    const Atlas& atlas, std::uint32_t& count) {
  if (payload.size() < 8 || payload.size() > max_message_bytes || read_u32(payload, 0) != 2)
    throw std::runtime_error("Expected TILE command 2");
  count = read_u32(payload, 4);
  if (count < 1 || count > atlas.parameters.tile_capacity)
    throw std::runtime_error("TILE cell count exceeds initialized tile capacity");
  const auto values = checked_product(count, atlas.layout.samples, "TILE pixels");
  const auto bytes = checked_product(values, 4, "TILE pixels");
  if (payload.size() != checked_sum(8, bytes, "TILE") || bytes > max_pixel_bytes)
    throw std::runtime_error("TILE byte length does not match cell/sample geometry");
  std::vector<std::uint32_t> pixels(values);
  for (std::size_t i = 0; i < values; ++i) {
    pixels[i] = read_u32(payload, 8+i*4);
    if ((pixels[i] & 0xff000000u) != 0u)
      throw std::runtime_error("Packed RGB8 high byte must be zero");
  }
  return pixels;
}

std::vector<std::uint8_t> encode_init(const Atlas& atlas) {
  const auto& p = atlas.parameters;
  const auto l = validate_parameters(p);
  if (atlas.masks.size() != l.mask_values || atlas.statistics.size() != p.glyph_count || atlas.palette.size() != 16)
    throw std::runtime_error("Invalid atlas to serialize");
  std::vector<std::uint8_t> out;
  out.reserve(l.init_bytes);
  for (const auto value : {1u, protocol_version, p.sample_width, p.sample_height, p.glyph_count,
                          p.foreground_count, p.background_count, p.tile_capacity}) append_u32(out, value);
  for (const float value : atlas.masks) append_float(out, value);
  for (const auto& stats : atlas.statistics)
    for (const float value : {stats.x, stats.y, stats.z, stats.w}) append_float(out, value);
  for (const auto& color : atlas.palette)
    for (const float value : {color.x, color.y, color.z, color.w}) append_float(out, value);
  return out;
}

std::vector<std::uint8_t> encode_tile(const std::vector<std::uint32_t>& pixels, std::uint32_t count) {
  const auto size = checked_sum(8, checked_product(pixels.size(), 4, "TILE"), "TILE");
  if (size > max_message_bytes) throw std::runtime_error("TILE exceeds message limit");
  std::vector<std::uint8_t> out;
  out.reserve(size);
  append_u32(out, 2); append_u32(out, count);
  for (const auto pixel : pixels) append_u32(out, pixel);
  return out;
}

bool read_frame(std::FILE* input, std::vector<std::uint8_t>& payload) {
  std::uint8_t header[4];
  const auto got = std::fread(header, 1, 4, input);
  if (got == 0 && std::feof(input)) return false;
  if (got != 4) throw std::runtime_error("Truncated frame length or input read error");
  const auto size = std::uint32_t(header[0]) | (std::uint32_t(header[1]) << 8) |
    (std::uint32_t(header[2]) << 16) | (std::uint32_t(header[3]) << 24);
  if (size < 8 || size > max_message_bytes)
    throw std::runtime_error("Frame payload must be 8 bytes..128 MiB");
  payload.resize(size);
  if (std::fread(payload.data(), 1, size, input) != size)
    throw std::runtime_error("Truncated frame body or input read error");
  return true;
}

void write_frame(std::FILE* output, const std::vector<std::uint8_t>& payload) {
  if (payload.size() < 8 || payload.size() > max_message_bytes)
    throw std::runtime_error("Invalid output frame size");
  std::uint8_t length[4];
  for (unsigned i = 0; i < 4; ++i) length[i] = std::uint8_t(payload.size() >> (i*8));
  if (std::fwrite(length, 1, 4, output) != 4 ||
      std::fwrite(payload.data(), 1, payload.size(), output) != payload.size() || std::fflush(output) != 0)
    throw std::runtime_error("Output frame write failed");
}

std::vector<std::uint8_t> make_response(std::uint32_t status, const std::string& json,
                                      const std::vector<Result>& results) {
  if (status > 1 || (status != 0 && !results.empty())) throw std::runtime_error("Invalid response status");
  const auto size = checked_sum(checked_sum(8, json.size(), "Response"),
                               checked_product(results.size(), sizeof(Result), "Response"), "Response");
  if (size > max_message_bytes) throw std::runtime_error("Response exceeds message limit");
  std::vector<std::uint8_t> out;
  out.reserve(size);
  append_u32(out, status); append_u32(out, std::uint32_t(json.size()));
  out.insert(out.end(), json.begin(), json.end());
  for (const auto result : results)
    for (const auto value : {result.glyph, result.foreground, result.background, result.reserved}) append_u32(out, value);
  return out;
}

std::string json_string(const std::string& value) {
  std::string result = "\"";
  constexpr char hex[] = "0123456789abcdef";
  for (const unsigned char ch : value) {
    if (ch == '\\' || ch == '"') { result += '\\'; result += char(ch); }
    else if (ch < 0x20) { result += "\\u00"; result += hex[ch >> 4]; result += hex[ch & 15]; }
    else result += char(ch);
  }
  result += '"';
  return result;
}

std::vector<float> sample_major_masks(const Atlas& atlas) {
  const auto gc=atlas.parameters.glyph_count;const auto n=atlas.layout.samples;
  if(atlas.masks.size()!=checked_product(gc,n,"Mask transpose size"))throw std::runtime_error("Invalid mask transpose geometry");
  std::vector<float> out(atlas.masks.size());
  for(std::size_t g=0;g<gc;++g)for(std::size_t i=0;i<n;++i)out[i*gc+g]=atlas.masks[g*n+i];
  return out;
}

std::vector<Result> reference_fit(const Atlas& atlas,
                                const std::vector<std::uint32_t>& pixels, std::uint32_t count) {
  if (count < 1 || count > atlas.parameters.tile_capacity ||
      pixels.size() != checked_product(count, atlas.layout.samples, "Reference samples"))
    throw std::runtime_error("Float32 reference input geometry mismatch");
  const auto& p = atlas.parameters;
  std::vector<Float4> projections(checked_product(count, p.glyph_count, "Reference projections"));
  for (std::size_t i = 0; i < projections.size(); ++i)
    projections[i] = arithmetic::project(pixels.data(), atlas.masks.data(), atlas.statistics.data(),
      std::uint32_t(atlas.layout.samples), p.glyph_count, std::uint32_t(i));
  std::vector<Result> results(count);
  for (std::uint32_t i = 0; i < count; ++i)
    results[i] = arithmetic::select(pixels.data(), atlas.statistics.data(), atlas.palette.data(),
      projections.data(), std::uint32_t(atlas.layout.samples), p.glyph_count,
      p.foreground_count, p.background_count, i);
  return results;
}

std::vector<Result> precise_reference_fit(const Atlas& atlas,const std::vector<std::uint32_t>& pixels,std::uint32_t count) {
  const auto& p=atlas.parameters;
  if(count<1 || count>p.tile_capacity || pixels.size()!=checked_product(count,atlas.layout.samples,"Precise reference samples"))
    throw std::runtime_error("Precise reference geometry mismatch");
  const auto n=std::uint32_t(atlas.layout.samples);
  std::vector<precise::Projection> projections(p.glyph_count);std::vector<Result> result(count);
  for(std::uint32_t cell=0;cell<count;++cell) {
    const auto* input=pixels.data()+std::size_t(cell)*n;
    for(std::uint32_t g=0;g<p.glyph_count;++g)
      projections[g]=precise::project(input,atlas.masks.data()+std::size_t(g)*n,atlas.statistics[g],n);
    result[cell]=precise::select(input,atlas.statistics.data(),atlas.palette.data(),projections.data(),n,p.glyph_count,p.foreground_count,p.background_count);
  }
  return result;
}

Atlas make_fixture(std::uint32_t glyph_count, std::uint32_t sample_width,
                   std::uint32_t sample_height, std::uint32_t capacity,
                   std::uint32_t foreground_count, std::uint32_t background_count) {
  Atlas atlas;
  atlas.parameters = {sample_width, sample_height, glyph_count, foreground_count, background_count, capacity};
  atlas.layout = validate_parameters(atlas.parameters);
  atlas.masks.resize(atlas.layout.mask_values);
  atlas.statistics.resize(glyph_count);
  for (std::uint32_t g = 0; g < glyph_count; ++g) {
    for (std::size_t i = 0; i < atlas.layout.samples; ++i) {
      float value = float((g*73u+std::uint32_t(i)*29u) % 256u)/255.0f;
      if (g == 0) value = 0.0f;
      if (g == 1) value = 1.0f;
      if (g == 2) value = float(i%2);
      if (g == 3) value = 0.5f;
      if (g == 4) value = 0.0f; // Exact duplicate, stable source-order tie.
      if (g == 5) value = std::nextafter(0.5f, 1.0f); // Nearly degenerate variance.
      if (g == 6) value = i%2 ? std::nextafter(1.0f, 0.0f) : 0.0f;
      atlas.masks[std::size_t(g)*atlas.layout.samples+i] = value;
    }
    atlas.statistics[g] = compute_statistics(atlas.masks.data()+std::size_t(g)*atlas.layout.samples,
                                             atlas.layout.samples);
  }
  // Synthetic CGA palette for deterministic black/white/tie fixtures. Runtime
  // requests always supply the actual PNG2ANSI palette; this is not a fallback.
  const std::uint32_t colors[16][3] = {
    {0,0,0},{170,0,0},{0,170,0},{170,85,0},{0,0,170},{170,0,170},{0,170,170},{170,170,170},
    {85,85,85},{255,85,85},{85,255,85},{255,255,85},{85,85,255},{255,85,255},{85,255,255},{255,255,255}
  };
  for (const auto& color : colors)
    atlas.palette.push_back({float(color[0]),float(color[1]),float(color[2]),0.0f});
  return atlas;
}

std::vector<std::uint32_t> fixture_pixels(const Atlas& atlas, std::uint32_t count, std::uint32_t seed) {
  if (count > atlas.parameters.tile_capacity) throw std::runtime_error("Fixture count exceeds capacity");
  std::vector<std::uint32_t> pixels(checked_product(count, atlas.layout.samples, "Fixture"));
  for (std::uint32_t cell = 0; cell < count; ++cell) {
    for (std::size_t sample = 0; sample < atlas.layout.samples; ++sample) {
      seed = 1664525u*seed+1013904223u;
      auto pixel = seed & 0x00ffffffu;
      if (cell%7 == 0) pixel = 0;
      if (cell%7 == 1) pixel = 0x00ffffffu;
      if (cell%7 == 2) pixel = sample%2 ? 0x00ffffffu : 0;
      if (cell%7 == 3) pixel = 0x007f7f7fu;
      if (cell%7 == 4) pixel = sample%2 ? 0x00808080u : 0x007f7f7fu;
      pixels[std::size_t(cell)*atlas.layout.samples+sample] = pixel;
    }
  }
  return pixels;
}

} // namespace pnggpu
