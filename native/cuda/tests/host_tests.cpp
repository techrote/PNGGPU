#include "pnggpu_common.hpp"

#include <cmath>
#include <cstring>
#include <functional>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#endif

namespace {
using namespace pnggpu;
std::size_t checks = 0;

void require(bool condition, const char* message) {
  ++checks;
  if (!condition) throw std::runtime_error(message);
}

template<class Function> void rejects(Function action, const char* message) {
  ++checks;
  bool rejected = false;
  try { action(); } catch (const std::exception&) { rejected = true; }
  if (!rejected) throw std::runtime_error(message);
}

void replace_u32(std::vector<std::uint8_t>& bytes, std::size_t at, std::uint32_t value) {
  for (unsigned i = 0; i < 4; ++i) bytes.at(at+i) = std::uint8_t(value >> (i*8));
}

bool equal(Result a, Result b) {
  return a.glyph == b.glyph && a.foreground == b.foreground &&
         a.background == b.background && a.reserved == b.reserved;
}

using File = std::unique_ptr<std::FILE, int(*)(std::FILE*)>;
File file() {
#ifdef _WIN32
  // MSVC tmpfile()/tmpfile_s() use the drive root, which can require admin.
  // Use the current user's temp directory and let the OS delete on close.
  wchar_t directory[MAX_PATH+1], path[MAX_PATH+1];
  const DWORD length = GetTempPathW(MAX_PATH+1, directory);
  if (length == 0 || length > MAX_PATH || GetTempFileNameW(directory, L"pgc", 0, path) == 0)
    throw std::runtime_error("Cannot create file in the user temporary directory");
  HANDLE handle = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    DeleteFileW(path);
    throw std::runtime_error("Cannot open user temporary file");
  }
  const int descriptor = _open_osfhandle(reinterpret_cast<std::intptr_t>(handle), _O_RDWR | _O_BINARY);
  if (descriptor == -1) {
    CloseHandle(handle);
    throw std::runtime_error("Cannot attach temporary file descriptor");
  }
  std::FILE* stream = _fdopen(descriptor, "w+b");
  if (!stream) {
    _close(descriptor);
    throw std::runtime_error("Cannot create temporary file stream");
  }
  File f(stream, std::fclose);
#else
  File f(std::tmpfile(), std::fclose);
#endif
  if (!f) throw std::runtime_error("Cannot create test temporary file");
  return f;
}

void layout_tests() {
  const Parameters valid{8,8,40,12,8,67};
  const auto layout = validate_parameters(valid);
  require(layout.samples == 64, "Samples per cell");
  require(layout.init_bytes == 32+40*64*4+40*16+256, "INIT length");
  require(layout.allocated_bytes == 40*64*4+40*16+256+67*64*4+67*40*16+67*16, "GPU allocation estimate");
  for (const auto invalid : {
      Parameters{0,8,40,12,8,67}, Parameters{33,8,40,12,8,67}, Parameters{8,65,40,12,8,67},
      Parameters{8,8,0,12,8,67}, Parameters{8,8,65536,12,8,67}, Parameters{8,8,40,13,8,67},
      Parameters{8,8,40,12,0,67}, Parameters{8,8,40,12,9,67}, Parameters{8,8,40,12,8,0},
      Parameters{8,8,40,12,8,65537}, Parameters{32,64,1,12,8,65536},
      Parameters{1,1,65535,12,8,129}, Parameters{32,64,65535,12,8,1}})
    rejects([&]{ validate_parameters(invalid); }, "Reject out-of-range geometry/buffers");
  // Kernel work is segmented internally, never an extra HTTP tile limit.
  require(validate_parameters({32,64,219,12,8,1024}).pixel_bytes == 8*1024*1024,
          "Large valid HTTP tile must remain accepted");
  rejects([]{ checked_product(std::numeric_limits<std::size_t>::max(), 2, "test"); }, "Multiplication overflow");
  rejects([]{ checked_sum(std::numeric_limits<std::size_t>::max(), 1, "test"); }, "Addition overflow");
  require(checked_product(0, std::numeric_limits<std::size_t>::max(), "zero") == 0, "Zero multiplication");
  validate_memory_budget(100, memory_reserve_bytes+100);
  rejects([]{ validate_memory_budget(101, memory_reserve_bytes+100); }, "Memory admission exact boundary");
  rejects([]{ validate_memory_budget(1, memory_reserve_bytes-1); }, "Memory reserve underflow");
}

void protocol_tests() {
  const auto fixture = make_fixture(40, 8, 8, 67);
  const auto encoded = encode_init(fixture);
  const auto parsed = parse_init(encoded);
  require(parsed.masks == fixture.masks && parsed.palette.size() == 16, "INIT round trip");
  require(parsed.layout.allocated_bytes == fixture.layout.allocated_bytes, "INIT sizes round trip");
  for (const std::size_t position : {0u,4u,8u,16u,20u,24u,28u}) {
    auto corrupt = encoded;
    replace_u32(corrupt, position, 0);
    rejects([&]{ parse_init(corrupt); }, "INIT must validate command/version/dimensions");
  }
  auto corrupt = encoded;
  corrupt.pop_back();
  rejects([&]{ parse_init(corrupt); }, "INIT short payload");
  corrupt = encoded; corrupt.push_back(0);
  rejects([&]{ parse_init(corrupt); }, "INIT trailing bytes");
  for (const std::uint32_t bad_float : {0x7fc00000u,0x7f800000u,0xff800000u,0xbf000000u,0x40000000u}) {
    corrupt = encoded;
    replace_u32(corrupt, 32, bad_float);
    rejects([&]{ parse_init(corrupt); }, "Reject non-finite/out-of-range mask");
  }
  corrupt = encoded;
  replace_u32(corrupt, 32+parsed.layout.mask_bytes, 0x3f800000u);
  rejects([&]{ parse_init(corrupt); }, "Reject inconsistent statistics");
  corrupt = encoded;
  replace_u32(corrupt, 32+parsed.layout.mask_bytes+12, 0x3f800000u);
  rejects([&]{ parse_init(corrupt); }, "Reject statistics padding");
  corrupt = encoded;
  replace_u32(corrupt, 32+parsed.layout.mask_bytes+parsed.layout.stats_bytes, 0x43800000u);
  rejects([&]{ parse_init(corrupt); }, "Reject palette above 255");
  const auto pixels = fixture_pixels(parsed, 65, 123);
  auto tile = encode_tile(pixels, 65);
  std::uint32_t count = 0;
  require(parse_tile(tile, parsed, count) == pixels && count == 65, "TILE round trip with partial final block");
  for (const auto bad_count : {0u,68u,0xffffffffu}) {
    auto invalid = tile;
    replace_u32(invalid, 4, bad_count);
    rejects([&]{ parse_tile(invalid, parsed, count); }, "Reject tile count");
  }
  corrupt = tile; corrupt.pop_back();
  rejects([&]{ parse_tile(corrupt, parsed, count); }, "TILE truncated");
  corrupt = tile; corrupt.push_back(0);
  rejects([&]{ parse_tile(corrupt, parsed, count); }, "TILE trailing bytes");
  corrupt = tile; replace_u32(corrupt, 8, 0xff000000u);
  rejects([&]{ parse_tile(corrupt, parsed, count); }, "Reject non-RGB8 high byte");

  const std::string metadata = "{\"ok\":true}";
  const std::vector<Result> result{{219,15,7,0},{0,0,0,0}};
  const auto response = make_response(0, metadata, result);
  require(read_u32(response, 0) == 0 && read_u32(response, 4) == metadata.size(), "Response header");
  require(response.size() == 8+metadata.size()+32, "Response length");
  require(read_u32(response, 8+metadata.size()) == 219 && read_u32(response, 12+metadata.size()) == 15,
          "Response result encoding");
  rejects([&]{ make_response(1, "{}", result); }, "Error frame cannot contain result data");
  require(json_string(std::string("a\n\"\\\t")) == "\"a\\u000a\\\"\\\\\\u0009\"", "JSON string escaping");

  auto stream = file();
  write_frame(stream.get(), encoded); write_frame(stream.get(), tile);
  std::rewind(stream.get());
  std::vector<std::uint8_t> frame;
  require(read_frame(stream.get(), frame) && frame == encoded, "INIT frame round trip");
  require(read_frame(stream.get(), frame) && frame == tile, "TILE frame round trip");
  require(!read_frame(stream.get(), frame), "Clean EOF");
  for (const auto& malformed : {
      std::vector<std::uint8_t>{1,0}, std::vector<std::uint8_t>{8,0,0,0,1},
      std::vector<std::uint8_t>{0,0,0,0}, std::vector<std::uint8_t>{1,0,0,8},
      std::vector<std::uint8_t>{255,255,255,255}}) {
    auto input = file();
    require(std::fwrite(malformed.data(), 1, malformed.size(), input.get()) == malformed.size(), "Write malformed fixture");
    std::rewind(input.get());
    rejects([&]{ read_frame(input.get(), frame); }, "Reject malformed frame before allocation");
  }
}

void arithmetic_tests() {
  auto black = make_fixture(1, 2, 2, 3, 1, 1);
  const std::vector<std::uint32_t> zero(12, 0);
  const auto black_results = reference_fit(black, zero, 3);
  for (const auto result : black_results)
    require(equal(result, {0,0,0,0}), "Black fixture must select first glyph/color ties");

  auto white = make_fixture(1, 2, 2, 3);
  std::fill(white.masks.begin(), white.masks.end(), 1.0f);
  white.statistics[0] = compute_statistics(white.masks.data(), white.layout.samples);
  const auto white_results = reference_fit(white, std::vector<std::uint32_t>(12, 0xffffffu), 3);
  for (const auto result : white_results)
    require(result.glyph == 0 && result.foreground == 15 && result.background == 7 && result.reserved == 0,
            "Fully covered white mask must select bright white foreground");

  auto duplicate = make_fixture(40, 4, 4, 1);
  std::fill(duplicate.masks.begin(), duplicate.masks.end(), 0.0f);
  for (auto& stats : duplicate.statistics) stats = compute_statistics(duplicate.masks.data(), duplicate.layout.samples);
  const auto tied = reference_fit(duplicate, std::vector<std::uint32_t>(16, 0), 1);
  require(equal(tied[0], {0,0,0,0}), "Stable shortlist/color ties with >32 glyphs");

  const auto atlas = make_fixture(40, 8, 8, 67);
  const auto pixels = fixture_pixels(atlas, 67, 0x55667788u);
  const auto whole = reference_fit(atlas, pixels, 67);
  const auto repeat = reference_fit(atlas, pixels, 67);
  for (std::size_t i = 0; i < whole.size(); ++i) require(equal(whole[i], repeat[i]), "Repeatability");
  for (const std::uint32_t chunk_size : {1u,3u,31u,63u,64u,65u}) {
    for (std::uint32_t start = 0; start < 67;) {
      const std::uint32_t count = std::min(chunk_size, 67-start);
      const std::vector<std::uint32_t> chunk(pixels.begin()+std::size_t(start)*atlas.layout.samples,
        pixels.begin()+std::size_t(start+count)*atlas.layout.samples);
      const auto split = reference_fit(atlas, chunk, count);
      for (std::size_t i = 0; i < split.size(); ++i)
        require(equal(split[i], whole[start+i]), "Tile partition invariance");
      start += count;
    }
  }
  rejects([&]{ reference_fit(atlas, pixels, 68); }, "Reject oversized reference tile");
  const auto small = make_fixture(7, 1, 1, 2);
  const auto small_result = reference_fit(small, fixture_pixels(small, 2, 1), 2);
  require(small_result.size() == 2, "Fewer than 32 glyphs and degenerate variance");
  require(std::isfinite(atlas.statistics[5].z) && atlas.statistics[5].z > 0,
          "Near-constant mask keeps positive finite variance");
}
} // namespace

int main() {
  try {
    layout_tests(); protocol_tests(); arithmetic_tests();
    std::cout << "PNGGPU CUDA host tests: " << checks << " checks passed (no GPU required).\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "PNGGPU CUDA host tests failed: " << error.what() << '\n';
    return 1;
  }
}
