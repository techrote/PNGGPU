#include "pnggpu_activity_trace.hpp"
#include <cupti.h>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif

namespace pnggpu {
namespace {
void check(CUptiResult r,const char* where) {
  if(r!=CUPTI_SUCCESS){const char* text=nullptr;cuptiGetResultString(r,&text);throw std::runtime_error(std::string(where)+": "+(text?text:"CUPTI error"));}
}
std::ofstream output;
std::mutex output_mutex;
std::mutex flush_mutex;
std::atomic<bool> enabled{false};
std::atomic<unsigned> failures{0};
std::atomic<unsigned> buffers{0};
constexpr unsigned max_buffers=4; // at most 4 MiB of outstanding client record buffers
void status_row(const char* kind,unsigned value) {
  output << kind << ",0,0,0,0,0,0,0," << value << '\n';output.flush();
  if(!output){++failures;std::fprintf(stderr,"CUPTI activity output write failed\n");}
}
void CUPTIAPI requested(std::uint8_t** p,std::size_t* size,std::size_t* maximum) {
  *size=0;*p=nullptr;*maximum=0;
  auto count=buffers.load();
  do {if(count>=max_buffers){++failures;std::lock_guard<std::mutex> lock(output_mutex);status_row("traceError",unsigned(CUPTI_ERROR_OUT_OF_MEMORY));return;}}
  while(!buffers.compare_exchange_weak(count,count+1));
  *size=1024*1024;*p=static_cast<std::uint8_t*>(std::malloc(*size));
  if(!*p){*size=0;--buffers;++failures;std::lock_guard<std::mutex> lock(output_mutex);status_row("traceError",unsigned(CUPTI_ERROR_OUT_OF_MEMORY));}
}
void CUPTIAPI completed(CUcontext context,std::uint32_t stream,std::uint8_t* buffer,std::size_t,std::size_t valid) {
  std::lock_guard<std::mutex> lock(output_mutex);
  CUpti_Activity* record=nullptr;
  for(;;){
    const auto result=cuptiActivityGetNextRecord(buffer,valid,&record);
    if(result==CUPTI_ERROR_MAX_LIMIT_REACHED)break;
    if(result!=CUPTI_SUCCESS){++failures;status_row("traceError",unsigned(result));break;}
    if(record->kind==CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL){
      const auto* k=reinterpret_cast<const CUpti_ActivityKernel9*>(record);
      output << "kernel," << k->correlationId << ',' << k->start << ',' << k->end << ','
        << k->gridX << ',' << k->blockX << ',' << k->registersPerThread << ',' << k->localMemoryPerThread
        << ",\"" << k->name << "\"\n";
    }else if(record->kind==CUPTI_ACTIVITY_KIND_RUNTIME){
      const auto* a=reinterpret_cast<const CUpti_ActivityAPI*>(record);const char* name=nullptr;
      if(cuptiGetCallbackName(CUPTI_CB_DOMAIN_RUNTIME_API,a->cbid,&name)!=CUPTI_SUCCESS)name="unknown";
      output << "runtime," << a->correlationId << ',' << a->start << ',' << a->end << ",0,0,0,0,\"" << name << "\"\n";
    }
  }
  std::size_t dropped=0;
  const auto drop_status=cuptiActivityGetNumDroppedRecords(context,stream,&dropped);
  if(drop_status!=CUPTI_SUCCESS){++failures;status_row("traceError",unsigned(drop_status));}
  if(dropped)output << "dropped,0,0,0,0,0,0,0," << dropped << '\n';
  output.flush();if(!output){++failures;std::fprintf(stderr,"CUPTI activity output write failed\n");}
  std::free(buffer);--buffers;
}
}

void flush_activity_trace() {
  if(!enabled.load())return;
  std::lock_guard<std::mutex> flush_lock(flush_mutex);
  const auto status=cuptiActivityFlushAll(0);
  if(status!=CUPTI_SUCCESS){++failures;std::lock_guard<std::mutex> lock(output_mutex);status_row("traceError",unsigned(status));}
  check(status,"CUPTI request-boundary flush");
}

struct ActivityTrace::Impl {
  std::atomic<bool> stop{false};std::thread flusher;
  explicit Impl(const char* directory) {
    const auto path=std::filesystem::path(directory);std::filesystem::create_directories(path);
    const auto pid=
#ifdef _WIN32
      _getpid();
#else
      getpid();
#endif
    output.open(path/("activity-"+std::to_string(pid)+".csv"));
    if(!output)throw std::runtime_error("Cannot open CUPTI activity output");
    output << "kind,correlation,startNs,endNs,gridX,blockX,registers,localBytes,name\n";
    std::size_t size=1024*1024,limit=2,preallocate=1,value_size=sizeof(std::size_t);
    check(cuptiActivitySetAttribute(CUPTI_ACTIVITY_ATTR_DEVICE_BUFFER_SIZE,&value_size,&size),"CUPTI bounded buffer");
    value_size=sizeof(limit);check(cuptiActivitySetAttribute(CUPTI_ACTIVITY_ATTR_DEVICE_BUFFER_POOL_LIMIT,&value_size,&limit),"CUPTI bounded pool");
    value_size=sizeof(preallocate);check(cuptiActivitySetAttribute(CUPTI_ACTIVITY_ATTR_DEVICE_BUFFER_PRE_ALLOCATE_VALUE,&value_size,&preallocate),"CUPTI preallocation");
    std::uint8_t pinned=1;value_size=sizeof(pinned);
    check(cuptiActivitySetAttribute(CUPTI_ACTIVITY_ATTR_MEM_ALLOCATION_TYPE_HOST_PINNED,&value_size,&pinned),"CUPTI host-pinned buffers");
    check(cuptiActivityRegisterCallbacks(requested,completed),"CUPTI activity callbacks");
    check(cuptiActivityEnable(CUPTI_ACTIVITY_KIND_RUNTIME),"CUPTI runtime activity");
    check(cuptiActivityEnable(CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL),"CUPTI kernel activity");
    enabled=true;
    flusher=std::thread([this]{while(!stop.load()){
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      std::lock_guard<std::mutex> flush_lock(flush_mutex);
      const auto status=cuptiActivityFlushAll(0);
      if(status!=CUPTI_SUCCESS){++failures;std::lock_guard<std::mutex> lock(output_mutex);output << "traceError,0,0,0,0,0,0,0," << unsigned(status) << '\n';output.flush();}
    }});
  }
  ~Impl() {
    stop=true;if(flusher.joinable())flusher.join();
    enabled=false;
    for(const auto status:{cuptiActivityFlushAll(0),cuptiActivityDisable(CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL),cuptiActivityDisable(CUPTI_ACTIVITY_KIND_RUNTIME)})
      if(status!=CUPTI_SUCCESS){++failures;std::lock_guard<std::mutex> lock(output_mutex);status_row("traceError",unsigned(status));}
    std::lock_guard<std::mutex> lock(output_mutex);status_row("traceErrors",failures.load());output.close();
  }
};
ActivityTrace::ActivityTrace(bool stdio) {
  const char* directory=std::getenv("PNGGPU_CUDA_ACTIVITY_DIRECTORY");
  if(stdio&&directory&&*directory)impl_=std::make_unique<Impl>(directory);
}
ActivityTrace::~ActivityTrace()=default;
}
