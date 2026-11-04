#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

namespace pnggpu {

constexpr std::uint32_t protocol_version = 1;
constexpr std::uint64_t max_message_bytes = 128ull * 1024 * 1024;
constexpr std::uint64_t max_pixel_bytes = 64ull * 1024 * 1024;
constexpr std::uint64_t max_projection_bytes = 128ull * 1024 * 1024;
constexpr std::uint64_t max_projection_work = 16ull * 1024 * 1024;
constexpr std::uint32_t max_tile_cells = 65536;
constexpr std::uint32_t max_glyph_count = 65535;
constexpr std::uint64_t memory_reserve_bytes = 2ull * 1024 * 1024 * 1024;
constexpr std::uint64_t max_recovery_projection_bytes = 32ull * 1024 * 1024;
constexpr std::uint32_t max_recovery_cells = 1024;

struct Float4 { float x, y, z, w; };
struct Result { std::uint32_t glyph, foreground, background, reserved; };
static_assert(sizeof(float) == 4, "Protocol requires IEEE-754 binary32");
static_assert(sizeof(Float4) == 16 && sizeof(Result) == 16, "Protocol layout mismatch");

struct Parameters {
  std::uint32_t sample_width = 0;
  std::uint32_t sample_height = 0;
  std::uint32_t glyph_count = 0;
  std::uint32_t foreground_count = 0;
  std::uint32_t background_count = 0;
  std::uint32_t tile_capacity = 0;
};

struct Layout {
  std::size_t samples = 0;
  std::size_t mask_values = 0;
  std::size_t mask_bytes = 0;
  std::size_t stats_bytes = 0;
  std::size_t pixel_bytes = 0;
  std::size_t projection_bytes = 0;
  std::uint32_t recovery_capacity = 0;
  std::size_t recovery_bytes = 0;
  std::size_t result_bytes = 0;
  std::size_t init_bytes = 0;
  std::size_t allocated_bytes = 0;
};

struct Atlas {
  Parameters parameters;
  Layout layout;
  std::vector<float> masks;
  std::vector<Float4> statistics;
  std::vector<Float4> palette;
};

std::size_t checked_product(std::size_t a, std::size_t b, const char* label);
std::size_t checked_sum(std::size_t a, std::size_t b, const char* label);
Layout validate_parameters(const Parameters& parameters);
void validate_memory_budget(std::size_t allocation, std::uint64_t free_bytes);
Float4 compute_statistics(const float* mask, std::size_t samples);
std::vector<float> sample_major_masks(const Atlas& atlas);
Atlas parse_init(const std::vector<std::uint8_t>& payload);
std::vector<std::uint32_t> parse_tile(const std::vector<std::uint8_t>& payload,
                                    const Atlas& atlas, std::uint32_t& count);
std::uint32_t read_u32(const std::vector<std::uint8_t>& bytes, std::size_t offset);
void append_u32(std::vector<std::uint8_t>& bytes, std::uint32_t value);
void append_float(std::vector<std::uint8_t>& bytes, float value);
std::vector<std::uint8_t> encode_init(const Atlas& atlas);
std::vector<std::uint8_t> encode_tile(const std::vector<std::uint32_t>& pixels,
                                     std::uint32_t count);

// EOF before a new length is clean. Partial lengths/bodies are errors.
bool read_frame(std::FILE* input, std::vector<std::uint8_t>& payload);
void write_frame(std::FILE* output, const std::vector<std::uint8_t>& payload);
std::vector<std::uint8_t> make_response(std::uint32_t status, const std::string& json,
                                      const std::vector<Result>& results = {});
std::string json_string(const std::string& value);
std::vector<Result> reference_fit(const Atlas& atlas,
                                  const std::vector<std::uint32_t>& pixels,
                                  std::uint32_t count);
std::vector<Result> precise_reference_fit(const Atlas& atlas,
                                          const std::vector<std::uint32_t>& pixels,
                                          std::uint32_t count);

// Synthetic fixtures exercise the production arithmetic without images/fonts.
Atlas make_fixture(std::uint32_t glyph_count, std::uint32_t sample_width,
                   std::uint32_t sample_height, std::uint32_t capacity,
                   std::uint32_t foreground_count = 12,
                   std::uint32_t background_count = 8);
std::vector<std::uint32_t> fixture_pixels(const Atlas& atlas, std::uint32_t count,
                                         std::uint32_t seed);

} // namespace pnggpu
