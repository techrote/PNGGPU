#include "pnggpu_common.hpp"
#include "pnggpu_algorithm.hpp"
#include "pnggpu_guard.hpp"
#include "pnggpu_precise.hpp"

#include <cuda_runtime.h>
#include <cuda_fp16.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <locale>
#include <memory>
#include <sstream>
#include <string>
#include <cassert>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {
using namespace pnggpu;
using Clock = std::chrono::steady_clock;
constexpr unsigned block_size = 64;
bool direct_binary64 = false;
bool direct_float32 = false, half_mixed = false;
const char* precision_name() {
  return direct_binary64 ? "binary64-direct" : half_mixed ? "float16-mixed" : direct_float32 ? "float32-direct" : "float32-guarded-binary64";
}
#ifdef PNGGPU_FAULT_INJECTION
std::string test_fault;
__global__ void poison_context() { asm("trap;"); }
#endif

void cuda_check(cudaError_t status, const char* operation) {
  if (status != cudaSuccess)
    throw std::runtime_error(std::string(operation)+": "+cudaGetErrorString(status));
}

double milliseconds(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now()-start).count();
}

struct DeviceBuffer {
  void* data = nullptr;
  DeviceBuffer() = default;
  DeviceBuffer(const DeviceBuffer&) = delete;
  DeviceBuffer& operator=(const DeviceBuffer&) = delete;
  ~DeviceBuffer() { if (data) cudaFree(data); }
  void allocate(std::size_t bytes) { cuda_check(cudaMalloc(&data, bytes), "cudaMalloc"); }
  template<class T> T* as() const { return static_cast<T*>(data); }
};

struct Stream {
  cudaStream_t value = nullptr;
  Stream() { cuda_check(cudaStreamCreateWithFlags(&value, cudaStreamNonBlocking), "cudaStreamCreate"); }
  ~Stream() { if (value) { cudaStreamSynchronize(value); cudaStreamDestroy(value); } }
  Stream(const Stream&) = delete;
  Stream& operator=(const Stream&) = delete;
};

struct Event {
  cudaEvent_t value = nullptr;
  Event() { cuda_check(cudaEventCreate(&value), "cudaEventCreate"); }
  ~Event() { if (value) cudaEventDestroy(value); }
  Event(const Event&) = delete;
  Event& operator=(const Event&) = delete;
};

struct DeviceInfo {
  int index = -1;
  cudaDeviceProp properties{};
  std::size_t free_bytes = 0;
  std::size_t total_bytes = 0;
  int runtime_version = 0;
  int driver_version = 0;
};

DeviceInfo select_device(int requested) {
  int count = 0;
  cuda_check(cudaGetDeviceCount(&count), "CUDA device discovery");
  if (count == 0) throw std::runtime_error("No CUDA GPU found; install an NVIDIA driver and use a Turing or newer GPU");
  if (requested >= count) throw std::runtime_error("Requested CUDA device index does not exist");
  DeviceInfo info;
  for (int index = 0; index < count; ++index) {
    if (requested >= 0 && index != requested) continue;
    cudaDeviceProp prop{};
    cuda_check(cudaGetDeviceProperties(&prop, index), "cudaGetDeviceProperties");
    const int capability = prop.major*10+prop.minor;
    if (capability >= 75 && prop.computeMode != cudaComputeModeProhibited) {
      info.index = index;
      info.properties = prop;
      break;
    }
  }
  if (info.index < 0)
    throw std::runtime_error("CUDA backend requires compute capability 7.5 or later (TITAN RTX/RTX 20 series target); selected or detected GPU is unsupported");
  cuda_check(cudaSetDevice(info.index), "cudaSetDevice");
  // Context creation is intentionally excluded from per-tile kernel timing.
  cuda_check(cudaFree(nullptr), "CUDA context initialization");
  cuda_check(cudaMemGetInfo(&info.free_bytes, &info.total_bytes), "cudaMemGetInfo");
  cuda_check(cudaRuntimeGetVersion(&info.runtime_version), "cudaRuntimeGetVersion");
  cuda_check(cudaDriverGetVersion(&info.driver_version), "cudaDriverGetVersion");
  return info;
}

std::string device_json(const DeviceInfo& info) {
  std::ostringstream out;
  out.imbue(std::locale::classic());
  out << "{\"name\":" << json_string(info.properties.name)
      << ",\"computeCapability\":" << json_string(std::to_string(info.properties.major)+"."+std::to_string(info.properties.minor))
      << ",\"totalMemoryBytes\":" << info.total_bytes
      << ",\"freeMemoryBytes\":" << info.free_bytes << ",\"index\":" << info.index
      << ",\"kernelExecTimeoutEnabled\":" << (info.properties.kernelExecTimeoutEnabled ? "true" : "false") << "}";
  return out.str();
}

std::string kernel_resources_json(const DeviceInfo& info);

std::string info_json(const DeviceInfo& info) {
  std::ostringstream out;
  out.imbue(std::locale::classic());
  out << "{\"schema\":\"pnggpu-cuda-info-v1\",\"available\":true,\"backend\":\"cuda\","
         "\"protocolVersion\":1,\"precision\":" << json_string(precision_name()) << ",\"device\":" << device_json(info)
      << ",\"runtimeVersion\":" << info.runtime_version << ",\"driverVersion\":" << info.driver_version
      << ",\"limits\":{\"maxMessageBytes\":" << max_message_bytes
      << ",\"maxTileCells\":" << max_tile_cells << ",\"maxSamplesPerCell\":2048,\"maxGlyphCount\":" << max_glyph_count
      << ",\"maxProjectionBytes\":" << max_projection_bytes << ",\"maxPixelBytes\":" << max_pixel_bytes
      << ",\"maxProjectionWork\":" << max_projection_work << ",\"memoryReserveBytes\":" << memory_reserve_bytes
      << ",\"maxRecoveryProjectionBytes\":" << max_recovery_projection_bytes << ",\"maxRecoveryCells\":" << max_recovery_cells
      << "},\"kernelWorkLimitScope\":\"internal sublaunches; HTTP tile size is independently bounded by buffers\","
         "\"timingSources\":{\"gpuProjectionMs\":\"CUDA events, sum of sublaunches\","
         "\"gpuSelectionMs\":\"CUDA events, sum of sublaunches\","
         "\"uploadMs\":\"host steady clock, transfer plus stream synchronization\","
         "\"readbackMs\":\"host steady clock, transfer plus stream synchronization\"},\"kernelResources\":"
      << kernel_resources_json(info) << "}";
  return out.str();
}

__global__ void project_kernel(const std::uint32_t* pixels, const float* masks,
                               const Float4* statistics, Float4* projections,
                               std::uint32_t samples, std::uint32_t glyph_count,
                               std::uint32_t start, std::uint32_t end,bool half_products) {
  const std::uint32_t linear = start+blockIdx.x*blockDim.x+threadIdx.x;
  if(linear>=end)return;
  if(!half_products) { projections[linear]=arithmetic::project(pixels,masks,statistics,samples,glyph_count,linear);return; }
  // Experimental mixed precision: actual FP16 products, FP32 accumulation,
  // statistics and scoring. No Tensor Core or all-FP16 throughput claim.
  const auto cell=linear/glyph_count,glyph=linear%glyph_count;
  arithmetic::Vec3 totals{},dots{};
  for(std::uint32_t i=0;i<samples;++i) {
    const auto p=arithmetic::rgb(pixels[std::size_t(cell)*samples+i]);
    const auto m=__float2half_rn(masks[std::size_t(glyph)*samples+i]);
    totals=arithmetic::add(totals,p);
    dots=arithmetic::add(dots,{__half2float(__hmul(__float2half_rn(p.x),m)),
      __half2float(__hmul(__float2half_rn(p.y),m)),__half2float(__hmul(__float2half_rn(p.z),m))});
  }
  const auto s=statistics[glyph];
  const auto cov=arithmetic::subtract(dots,arithmetic::multiply(totals,s.x));
  projections[linear]={dots.x,dots.y,dots.z,-arithmetic::dot(cov,cov)/arithmetic::variance(s.z)};
}

template<bool Guarded>
__global__ void select_kernel(const std::uint32_t* pixels, const Float4* statistics,
                              const Float4* palette, const Float4* projections,
                              Result* results, std::uint32_t samples,
                              std::uint32_t glyph_count, std::uint32_t foreground_count,
                              std::uint32_t background_count,
                              std::uint32_t start, std::uint32_t end) {
  const std::uint32_t cell = start+blockIdx.x*blockDim.x+threadIdx.x;
  if (cell < end) {
    if constexpr(Guarded)results[cell] = guard::select(pixels+std::size_t(cell)*samples, statistics, palette,
      projections+std::size_t(cell)*glyph_count, samples,glyph_count,foreground_count,background_count);
    else results[cell]=arithmetic::select(pixels,statistics,palette,projections,samples,glyph_count,foreground_count,background_count,cell);
  }
}

__global__ void recover_project_kernel(const std::uint32_t* pixels,const float* masks,const Float4* stats,
    const Result* results,precise::Projection* projections,std::uint32_t n,std::uint32_t gc,
    std::uint32_t cell_offset,std::uint32_t start,std::uint32_t end,bool verify) {
  const auto linear=start+blockIdx.x*blockDim.x+threadIdx.x;
  if(linear>=end)return;
  const auto cell=cell_offset+linear/gc,g=linear%gc;
  if(!verify && results[cell].reserved==0)return;
  projections[linear]=precise::project(pixels+std::size_t(cell)*n,masks+std::size_t(g)*n,stats[g],n);
}
__global__ void recover_select_kernel(const std::uint32_t* pixels,const Float4* stats,const Float4* palette,
    const precise::Projection* projections,Result* results,std::uint32_t n,std::uint32_t gc,
    std::uint32_t nf,std::uint32_t nb,std::uint32_t cell_offset,std::uint32_t count,bool verify) {
  const auto local=blockIdx.x*blockDim.x+threadIdx.x;
  if(local>=count)return;
  const auto cell=cell_offset+local;
  if(!verify && results[cell].reserved==0)return;
  results[cell]=precise::select(pixels+std::size_t(cell)*n,stats,palette,projections+std::size_t(local)*gc,n,gc,nf,nb);
}

template<class Kernel>
std::string kernel_resource_json(Kernel kernel,const DeviceInfo& info) {
  cudaFuncAttributes attrs{};int blocks=0;
  cuda_check(cudaFuncGetAttributes(&attrs,kernel),"Kernel resource attributes");
  cuda_check(cudaOccupancyMaxActiveBlocksPerMultiprocessor(&blocks,kernel,block_size,0),"Theoretical kernel occupancy");
  std::ostringstream out;out.imbue(std::locale::classic());
  out << "{\"registersPerThread\":" << attrs.numRegs << ",\"localBytesPerThread\":" << attrs.localSizeBytes
      << ",\"staticSharedBytesPerBlock\":" << attrs.sharedSizeBytes << ",\"blockThreads\":" << block_size
      << ",\"theoreticalActiveBlocksPerSM\":" << blocks << ",\"theoreticalActiveThreadsPerSM\":" << blocks*block_size
      << ",\"deviceMaxThreadsPerSM\":" << info.properties.maxThreadsPerMultiProcessor
      << ",\"binaryVersion\":" << attrs.binaryVersion << ",\"ptxVersion\":" << attrs.ptxVersion << "}";
  return out.str();
}

std::string kernel_resources_json(const DeviceInfo& info) {
  return "{\"source\":\"CUDA function attributes and theoretical occupancy API; not achieved hardware counters\","
    "\"selectionGuarded\":"+kernel_resource_json(select_kernel<true>,info)+
    ",\"selectionFP32\":"+kernel_resource_json(select_kernel<false>,info)+
    ",\"selectionFP64\":"+kernel_resource_json(recover_select_kernel,info)+
    ",\"projectionShared\":"+kernel_resource_json(project_kernel,info)+"}";
}

struct TileOutput {
  std::vector<Result> results;
  double upload_ms = 0.0;
  double projection_ms = 0.0;
  double selection_ms = 0.0;
  double readback_ms = 0.0;
  double total_ms = 0.0;
  std::uint32_t projection_launches = 0;
  std::uint32_t selection_launches = 0;
  double guard_ms=0,recovery_projection_ms=0,recovery_selection_ms=0;
  double direct_projection_ms=0,direct_selection_ms=0;
  std::uint32_t direct_cells=0;
  double max_projection_launch_ms=0,max_selection_launch_ms=0;
  std::uint32_t recovered_cells=0,shortlist_cells=0,palette_cells=0,selection_cells=0,certified_verified=0;
  std::size_t readback_bytes=0;
};

class Worker {
 public:
  explicit Worker(Atlas atlas) : atlas_(std::move(atlas)) {
    std::size_t free_bytes = 0, total = 0;
    cuda_check(cudaMemGetInfo(&free_bytes, &total), "Memory admission snapshot");
    validate_memory_budget(atlas_.layout.allocated_bytes, free_bytes);
    masks_.allocate(atlas_.layout.mask_bytes);
    statistics_.allocate(atlas_.layout.stats_bytes);
    palette_.allocate(16*sizeof(Float4));
#ifdef PNGGPU_FAULT_INJECTION
    if(test_fault=="oom") {
      void* impossible=nullptr;
      cuda_check(cudaMalloc(&impossible,std::numeric_limits<std::size_t>::max()),"Injected impossible allocation after partial construction");
      if(impossible)cudaFree(impossible);
      throw std::runtime_error("Oversized CUDA allocation unexpectedly succeeded");
    }
#endif
    pixels_.allocate(atlas_.layout.pixel_bytes);
    projections_.allocate(atlas_.layout.projection_bytes);
    recovery_.allocate(atlas_.layout.recovery_bytes);
    results_.allocate(atlas_.layout.result_bytes);
    const auto start = Clock::now();
    cuda_check(cudaMemcpyAsync(masks_.data, atlas_.masks.data(), atlas_.layout.mask_bytes, cudaMemcpyHostToDevice, stream_.value), "Upload glyph masks");
    cuda_check(cudaMemcpyAsync(statistics_.data, atlas_.statistics.data(), atlas_.layout.stats_bytes, cudaMemcpyHostToDevice, stream_.value), "Upload glyph statistics");
    cuda_check(cudaMemcpyAsync(palette_.data, atlas_.palette.data(), 16*sizeof(Float4), cudaMemcpyHostToDevice, stream_.value), "Upload ANSI palette");
    cuda_check(cudaStreamSynchronize(stream_.value), "Atlas upload completion");
    atlas_upload_ms_ = milliseconds(start);
  }

  ~Worker() {
    // The destructor body runs before device buffers are released, including
    // after a failed launch or request. CUDA calls in destructors cannot throw.
    cudaStreamSynchronize(stream_.value);
  }

  const Atlas& atlas() const { return atlas_; }
  double atlas_upload_ms() const { return atlas_upload_ms_; }

  TileOutput fit(const std::vector<std::uint32_t>& pixels, std::uint32_t count,bool verify_guard=false) {
    const auto& p = atlas_.parameters;
    if (count < 1 || count > p.tile_capacity || pixels.size() != std::size_t(count)*atlas_.layout.samples)
      throw std::runtime_error("CUDA tile geometry mismatch");
    TileOutput result;
    result.results.resize(count);
    const auto begin = Clock::now();
    auto stage = Clock::now();
    cuda_check(cudaMemcpyAsync(pixels_.data, pixels.data(), pixels.size()*sizeof(std::uint32_t), cudaMemcpyHostToDevice, stream_.value), "Upload tile pixels");
    cuda_check(cudaStreamSynchronize(stream_.value), "Pixel upload completion");
    result.upload_ms = milliseconds(stage);

    // Bound each launch, including a single cell with a large atlas. Synchronize
    // after each timed launch so WDDM cannot collect this entire tile's kernels
    // into an unbounded batch. This is a work bound, not a timing guarantee.
    const std::uint32_t pairs = count*p.glyph_count; // <= max_projection_bytes/16
    const std::uint32_t samples = std::uint32_t(atlas_.layout.samples);
    const auto pairs_per_launch = std::uint32_t(max_projection_work/samples);
    if(!direct_binary64)for (std::uint32_t start = 0; start < pairs;) {
      const std::uint32_t end = start+std::min(pairs-start, pairs_per_launch);
      cuda_check(cudaEventRecord(start_.value, stream_.value), "Record projection start");
      project_kernel<<<(end-start+block_size-1)/block_size, block_size, 0, stream_.value>>>(
        pixels_.as<std::uint32_t>(), masks_.as<float>(), statistics_.as<Float4>(), projections_.as<Float4>(),
        samples, p.glyph_count, start, end,half_mixed);
      cuda_check(cudaGetLastError(), "Projection kernel launch");
      const double elapsed=finish_timed_launch("Projection kernel completion");
      result.projection_ms+=elapsed;result.max_projection_launch_ms=std::max(result.max_projection_launch_ms,elapsed);
      ++result.projection_launches;
      start = end;
    }
    const auto candidate_work = std::uint64_t(std::min(32u, p.glyph_count))*p.foreground_count*p.background_count;
    const auto keep = std::min(32u, p.glyph_count);
    const auto work_per_cell = std::uint64_t(samples)+std::uint64_t(p.glyph_count)*(keep+1u)
      +16u*p.foreground_count+8u*p.background_count+candidate_work;
    const auto cells_per_launch = std::uint32_t(std::min<std::uint64_t>(1024,
      std::max<std::uint64_t>(1, max_projection_work/work_per_cell)));
    if(!direct_binary64)for (std::uint32_t start = 0; start < count;) {
      const std::uint32_t end = start+std::min(count-start, cells_per_launch);
      cuda_check(cudaEventRecord(start_.value, stream_.value), "Record selection start");
      if(direct_float32||half_mixed)select_kernel<false><<<(end-start+block_size-1)/block_size, block_size, 0, stream_.value>>>(
        pixels_.as<std::uint32_t>(), statistics_.as<Float4>(), palette_.as<Float4>(),
        projections_.as<Float4>(), results_.as<Result>(), samples, p.glyph_count,
        p.foreground_count, p.background_count, start, end);
      else select_kernel<true><<<(end-start+block_size-1)/block_size, block_size, 0, stream_.value>>>(
        pixels_.as<std::uint32_t>(), statistics_.as<Float4>(), palette_.as<Float4>(),
        projections_.as<Float4>(), results_.as<Result>(), samples, p.glyph_count,
        p.foreground_count, p.background_count, start, end);
      cuda_check(cudaGetLastError(), "Selection kernel launch");
      const double elapsed=finish_timed_launch("Selection kernel completion");
      result.selection_ms+=elapsed;result.max_selection_launch_ms=std::max(result.max_selection_launch_ms,elapsed);
      ++result.selection_launches;
      start = end;
    }
    result.guard_ms=(direct_float32||half_mixed)?0:result.selection_ms;
    if(!direct_binary64) {
      stage = Clock::now();
      cuda_check(cudaMemcpyAsync(result.results.data(), results_.data, count*sizeof(Result), cudaMemcpyDeviceToHost, stream_.value), "Read back selected cells");
      cuda_check(cudaStreamSynchronize(stream_.value), "Result readback completion");
      result.readback_ms = milliseconds(stage);
      result.readback_bytes=count*sizeof(Result);
    }
    // Direct mode's host vector is value-initialized; its device result buffer
    // is never inspected before the unconditional precise kernels overwrite it.
    const auto guarded=result.results;
    for(const auto record:guarded) {
      if(record.reserved)++result.recovered_cells;
      if(record.reserved==1)++result.shortlist_cells;
      if(record.reserved==2)++result.palette_cells;
      if(record.reserved==3)++result.selection_cells;
    }
    if(direct_binary64 || result.recovered_cells || verify_guard) {
      for(std::uint32_t offset=0;offset<count;offset+=atlas_.layout.recovery_capacity) {
        const auto chunk=std::min(count-offset,atlas_.layout.recovery_capacity);
        bool needed=direct_binary64||verify_guard;
        for(std::uint32_t i=0;i<chunk;++i)needed=needed||guarded[offset+i].reserved!=0;
        if(!needed)continue;
        const auto pairs=chunk*p.glyph_count;
        for(std::uint32_t start=0;start<pairs;) {
          const auto end=start+std::min(pairs-start,pairs_per_launch);
          cuda_check(cudaEventRecord(start_.value,stream_.value),"Record recovery projection start");
          recover_project_kernel<<<(end-start+block_size-1)/block_size,block_size,0,stream_.value>>>(
            pixels_.as<std::uint32_t>(),masks_.as<float>(),statistics_.as<Float4>(),results_.as<Result>(),
            recovery_.as<precise::Projection>(),samples,p.glyph_count,offset,start,end,direct_binary64||verify_guard);
          cuda_check(cudaGetLastError(),"Recovery projection launch");
          const double elapsed=finish_timed_launch("Recovery projection completion");
          result.recovery_projection_ms+=elapsed;result.projection_ms+=elapsed;++result.projection_launches;start=end;
          result.max_projection_launch_ms=std::max(result.max_projection_launch_ms,elapsed);
        }
        // Reuse the same conservative selection work limit, including gc*32.
        for(std::uint32_t local=0;local<chunk;) {
          const auto cells=std::min(chunk-local,cells_per_launch);
          cuda_check(cudaEventRecord(start_.value,stream_.value),"Record recovery selection start");
          recover_select_kernel<<<(cells+block_size-1)/block_size,block_size,0,stream_.value>>>(
            pixels_.as<std::uint32_t>(),statistics_.as<Float4>(),palette_.as<Float4>(),
            recovery_.as<precise::Projection>()+std::size_t(local)*p.glyph_count,results_.as<Result>(),
            samples,p.glyph_count,p.foreground_count,p.background_count,offset+local,cells,direct_binary64||verify_guard);
          cuda_check(cudaGetLastError(),"Recovery selection launch");
          const double elapsed=finish_timed_launch("Recovery selection completion");
          result.recovery_selection_ms+=elapsed;result.selection_ms+=elapsed;++result.selection_launches;local+=cells;
          result.max_selection_launch_ms=std::max(result.max_selection_launch_ms,elapsed);
        }
      }
      stage=Clock::now();
      cuda_check(cudaMemcpyAsync(result.results.data(),results_.data,count*sizeof(Result),cudaMemcpyDeviceToHost,stream_.value),"Read back recovered cells");
      cuda_check(cudaStreamSynchronize(stream_.value),"Recovery readback completion");
      result.readback_ms+=milliseconds(stage);
      result.readback_bytes+=count*sizeof(Result);
      if(verify_guard&&!direct_binary64)for(std::size_t i=0;i<count;++i)if(guarded[i].reserved==0) {
        const auto a=guarded[i],b=result.results[i];
        if(a.glyph!=b.glyph || a.foreground!=b.foreground || a.background!=b.background)
          throw std::runtime_error("Guard certified a tuple that differs from unconditional binary64 GPU recovery");
        ++result.certified_verified;
      }
    }
    if(direct_binary64) {
      result.direct_cells=count;
      result.direct_projection_ms=result.recovery_projection_ms;result.recovery_projection_ms=0;
      result.direct_selection_ms=result.recovery_selection_ms;result.recovery_selection_ms=0;
    } else if(direct_float32||half_mixed) {
      result.direct_cells=count;
      result.direct_projection_ms=result.projection_ms;result.direct_selection_ms=result.selection_ms;
    }
    result.total_ms = milliseconds(begin);
    return result;
  }

 private:
  double finish_timed_launch(const char* operation) {
    cuda_check(cudaEventRecord(stop_.value, stream_.value), "Record kernel stop");
    cuda_check(cudaEventSynchronize(stop_.value), operation);
    float elapsed = 0.0f;
    cuda_check(cudaEventElapsedTime(&elapsed, start_.value, stop_.value), "CUDA event timing");
    return elapsed;
  }
  Atlas atlas_;
  Stream stream_;
  Event start_, stop_;
  DeviceBuffer masks_, statistics_, palette_, pixels_, projections_, recovery_, results_;
  double atlas_upload_ms_ = 0.0;
};

std::string tile_json(const TileOutput& result, std::size_t allocated_bytes) {
  std::ostringstream out;
  out.imbue(std::locale::classic());
  out << std::setprecision(10) << "{\"ok\":true,\"cellCount\":" << result.results.size()
      << ",\"timing\":{\"gpuProjectionMs\":" << result.projection_ms
      << ",\"gpuSelectionMs\":" << result.selection_ms
      << ",\"uploadMs\":" << result.upload_ms << ",\"readbackMs\":" << result.readback_ms
      << ",\"nativeTotalMs\":" << result.total_ms
      << ",\"gpuGuardMs\":" << result.guard_ms << ",\"gpuRecoveryProjectionMs\":" << result.recovery_projection_ms
      << ",\"gpuRecoverySelectionMs\":" << result.recovery_selection_ms
      << ",\"gpuDirectProjectionMs\":" << result.direct_projection_ms << ",\"gpuDirectSelectionMs\":" << result.direct_selection_ms
      << ",\"maxProjectionLaunchMs\":" << result.max_projection_launch_ms << ",\"maxSelectionLaunchMs\":" << result.max_selection_launch_ms
      << "},\"allocatedBytes\":" << allocated_bytes << ",\"projectionSublaunches\":" << result.projection_launches
      << ",\"selectionSublaunches\":" << result.selection_launches
      << ",\"deviceReadbackBytes\":" << result.readback_bytes
      << ",\"directCells\":" << result.direct_cells
      << ",\"recoveredCells\":" << result.recovered_cells << ",\"certifiedCells\":" << result.results.size()-result.recovered_cells-result.direct_cells
      << ",\"recoveryReasons\":{\"shortlist\":" << result.shortlist_cells << ",\"palette\":" << result.palette_cells
      << ",\"selection\":" << result.selection_cells << "}}";
  return out.str();
}

int serve(const DeviceInfo& device) {
#ifdef PNGGPU_FAULT_INJECTION
  DeviceBuffer pressure;
  if(test_fault=="pressure") {
    std::size_t free=0,total=0;cuda_check(cudaMemGetInfo(&free,&total),"Pressure snapshot");
    constexpr std::size_t retain=memory_reserve_bytes+8u*1024u*1024u;
    if(free<=retain)throw std::runtime_error("Not enough free memory for bounded pressure test");
    const auto bytes=free-retain;pressure.allocate(bytes);
    for(std::size_t offset=0;offset<bytes;offset+=16u*1024u*1024u) {
      cuda_check(cudaMemset(static_cast<char*>(pressure.data)+offset,0,std::min(bytes-offset,std::size_t(16u*1024u*1024u))),"Commit pressure pages");
      cuda_check(cudaDeviceSynchronize(),"Pressure chunk completion");
    }
    cuda_check(cudaMemGetInfo(&free,&total),"Pressure admission snapshot");
    std::cerr << "pressureAllocatedBytes=" << bytes << " freeAfterPressureBytes=" << free << '\n';
  }
#endif
  std::unique_ptr<Worker> worker;
  std::vector<std::uint8_t> payload;
  while (read_frame(stdin, payload)) {
    const auto command = read_u32(payload, 0);
    if (command == 1) {
      if (worker) throw std::runtime_error("Only one INIT is allowed per worker process");
      worker = std::make_unique<Worker>(parse_init(payload));
      std::ostringstream json;
      json.imbue(std::locale::classic());
      json << std::setprecision(10) << "{\"ok\":true,\"device\":" << device_json(device)
           << ",\"protocolVersion\":1,\"precision\":" << json_string(precision_name()) << ",\"allocatedBytes\":" << worker->atlas().layout.allocated_bytes
           << ",\"recoveryBufferBytes\":" << worker->atlas().layout.recovery_bytes
           << ",\"atlasUploadMs\":" << worker->atlas_upload_ms() << "}";
      write_frame(stdout, make_response(0, json.str()));
    } else if (command == 2) {
      if (!worker) throw std::runtime_error("INIT must precede TILE");
#ifdef PNGGPU_FAULT_INJECTION
      if(test_fault=="context") {
        poison_context<<<1,1>>>();
        cuda_check(cudaDeviceSynchronize(),"Injected CUDA context fault");
        throw std::runtime_error("Context fault unexpectedly succeeded");
      }
#endif
      std::uint32_t count = 0;
      const auto pixels = parse_tile(payload, worker->atlas(), count);
      const auto result = worker->fit(pixels, count);
      write_frame(stdout, make_response(0, tile_json(result, worker->atlas().layout.allocated_bytes), result.results));
    } else throw std::runtime_error("Unknown worker command");
  }
  return 0;
}

int self_test(const DeviceInfo& device) {
  std::size_t cases = 0, compared_cells = 0,certified_verified=0,recovered=0;
  const Parameters fixtures[] = {
    {2,2,1,1,1,3}, {4,4,8,12,8,67}, {8,8,40,12,8,67},
    {1,1,40,1,1,65}, {32,64,219,12,8,65}, {4,4,219,12,8,129},
    {1,1,40,12,8,1025}, {4,8,37,6,5,129}
  };
  for (const auto p : fixtures) {
    // Round-trip the same protocol path used by the loopback service.
    auto source = make_fixture(p.glyph_count, p.sample_width, p.sample_height,
                                     p.tile_capacity, p.foreground_count, p.background_count);
    if(p.glyph_count==37) {
      std::uint32_t state=0x719efad3u;
      for(auto& value:source.masks) {state=1664525u*state+1013904223u;value=float(state>>24)/255.0f;}
      for(std::uint32_t g=0;g<p.glyph_count;++g)source.statistics[g]=compute_statistics(source.masks.data()+std::size_t(g)*source.layout.samples,source.layout.samples);
    }
    Worker worker(parse_init(encode_init(source)));
    for (const std::uint32_t requested : {1u, 3u, 63u, 64u, 65u, p.tile_capacity}) {
      if (requested > p.tile_capacity) continue;
      auto generated = fixture_pixels(worker.atlas(), requested, 0x12345678u+std::uint32_t(cases));
      if(p.glyph_count==37) {
        std::uint32_t state=0xf17eac31u+std::uint32_t(cases);
        for(auto& value:generated){state=1664525u*state+1013904223u;value=state&0xffffffu;}
      }
      std::uint32_t count = 0;
      const auto pixels = parse_tile(encode_tile(generated, requested), worker.atlas(), count);
      const auto expected = precise_reference_fit(worker.atlas(), pixels, count);
      const auto actual = worker.fit(pixels, count,true);
      certified_verified+=actual.certified_verified;recovered+=actual.recovered_cells;
      for (std::size_t i = 0; i < expected.size(); ++i) {
        const auto a = actual.results[i], e = expected[i];
        if (a.glyph != e.glyph || a.foreground != e.foreground || a.background != e.background || a.reserved != 0)
          throw std::runtime_error("CUDA CPU-objective self-test mismatch in case "+std::to_string(cases)+", cell "+std::to_string(i));
      }
      // A second identical call checks reusable-buffer repeatability.
      const auto repeated = worker.fit(pixels, count,true);
      for (std::size_t i = 0; i < expected.size(); ++i) {
        const auto a = repeated.results[i], e = expected[i];
        if (a.glyph != e.glyph || a.foreground != e.foreground || a.background != e.background || a.reserved != 0)
          throw std::runtime_error("CUDA repeated-call self-test mismatch");
      }
      ++cases;
      compared_cells += count;
    }
  }
  if(certified_verified<=5)throw std::runtime_error("Self-test did not exercise nontrivial certified decisions");
  std::cout << "{\"schema\":\"pnggpu-cuda-self-test-v1\",\"ok\":true,\"device\":" << device_json(device)
            << ",\"cases\":" << cases << ",\"comparedCells\":" << compared_cells
            << ",\"oracle\":\"CPU-grouped binary64 plus unconditional binary64 GPU verification of every certified tuple\""
            << ",\"certifiedVerified\":" << certified_verified << ",\"recoveredCells\":" << recovered
            << ",\"originalCpuParityProven\":false}\n";
  return 0;
}

} // namespace

int main(int argc, char** argv) {
  std::string mode;
  int device_index = -1;
  bool binary_mode = false;
  bool arithmetic_option_seen = false;
  try {
    for (int i = 1; i < argc; ++i) {
      const std::string arg = argv[i];
      if (arg == "--info" || arg == "--stdio" || arg == "--self-test") {
        if (!mode.empty()) throw std::runtime_error("Choose one of --info, --stdio, --self-test");
        mode = arg;
      } else if (arg == "--arithmetic-mode") {
        if(arithmetic_option_seen || ++i>=argc)throw std::runtime_error("Specify --arithmetic-mode once");
        arithmetic_option_seen=true;
        const std::string arithmetic=argv[i];
        if(arithmetic!="float32-guarded-binary64" && arithmetic!="binary64-direct" && arithmetic!="float32-direct" && arithmetic!="float16-mixed")throw std::runtime_error("Unsupported CUDA arithmetic mode");
        direct_binary64=arithmetic=="binary64-direct";
        direct_float32=arithmetic=="float32-direct";half_mixed=arithmetic=="float16-mixed";
      } else if (arg == "--device") {
        if (++i >= argc) throw std::runtime_error("--device requires a non-negative ordinal");
        const std::string index = argv[i];
        if (index.empty() || index.find_first_not_of("0123456789") != std::string::npos)
          throw std::runtime_error("--device requires a non-negative ordinal");
        const auto number = std::stoull(index);
        if (number > std::uint64_t(std::numeric_limits<int>::max())) throw std::runtime_error("Device index is too large");
        device_index = int(number);
      }
#ifdef PNGGPU_FAULT_INJECTION
      else if(arg=="--test-fault") {
        if(++i>=argc)throw std::runtime_error("--test-fault requires context, oom or pressure");
        test_fault=argv[i];
        if(test_fault!="context" && test_fault!="oom" && test_fault!="pressure")throw std::runtime_error("Invalid test fault");
      }
#endif
      else if (arg == "--help") {
        std::cout << "PNGGPU optional CUDA worker (Turing sm_75 + compute_75 PTX)\n"
                     "Usage: pnggpu_cuda_worker (--info | --stdio | --self-test) [--device N] [--arithmetic-mode float32-guarded-binary64|binary64-direct|float32-direct|float16-mixed]\n"
                     "Default device: first permitted GPU of compute capability 7.5 or later.\n";
        return 0;
      } else throw std::runtime_error("Unknown argument: "+arg);
    }
    if (mode.empty()) throw std::runtime_error("Use --info, --stdio, --self-test or --help");
    if((direct_binary64||direct_float32||half_mixed) && mode=="--self-test")throw std::runtime_error("Guard certification self-test requires guarded mode; qualify direct mode with bounded independent CPU fixtures");
    binary_mode = mode == "--stdio";
#ifdef _WIN32
    if (binary_mode) {
      if (_setmode(_fileno(stdin), _O_BINARY) == -1 || _setmode(_fileno(stdout), _O_BINARY) == -1)
        throw std::runtime_error("Could not select binary stdin/stdout mode");
    }
#endif
    const auto device = select_device(device_index);
#ifdef PNGGPU_FAULT_INJECTION
    if((test_fault=="context" || test_fault=="pressure") && device.properties.kernelExecTimeoutEnabled)
      throw std::runtime_error("Disruptive diagnostics are disabled on watchdog/display GPUs after observed desktop stalls; use an isolated non-display GPU");
#endif
    if (mode == "--info") { std::cout << info_json(device) << '\n'; return 0; }
    if (mode == "--self-test") return self_test(device);
    return serve(device);
  } catch (const std::exception& error) {
    const std::string detail = json_string(error.what());
    if (binary_mode) {
      try { write_frame(stdout, make_response(1, "{\"ok\":false,\"error\":"+detail+"}")); }
      catch (...) { /* Broken output: terminate; destructors still release resources. */ }
    } else {
      std::cout << "{\"schema\":\"pnggpu-cuda-info-v1\",\"available\":false,\"ok\":false,\"backend\":\"cuda\","
                   "\"protocolVersion\":1,\"error\":" << detail << "}\n";
    }
    return 1;
  }
}
