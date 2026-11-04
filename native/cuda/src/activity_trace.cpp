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
std::atomic<unsigned> failures{0};
void CUPTIAPI requested(std::uint8_t** p,std::size_t* size,std::size_t* maximum) {
  *size=1024*1024;*p=static_cast<std::uint8_t*>(std::malloc(*size));*maximum=0;
  if(!*p){*size=0;++failures;}
}
void CUPTIAPI completed(CUcontext context,std::uint32_t stream,std::uint8_t* buffer,std::size_t,std::size_t valid) {
  std::lock_guard<std::mutex> lock(output_mutex);
  CUpti_Activity* record=nullptr;
  for(;;){
    const auto result=cuptiActivityGetNextRecord(buffer,valid,&record);
    if(result==CUPTI_ERROR_MAX_LIMIT_REACHED)break;
    if(result!=CUPTI_SUCCESS){++failures;break;}
    if(record->kind==CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL){
      const auto* k=reinterpret_cast<const CUpti_ActivityKernel9*>(record);
      output << "kernel," << k->correlationId << ',' << k->start << ',' << k->end << ','
        << k->gridX << ',' << k->blockX << ',' << k->registersPerThread << ',' << k->localMemoryPerThread
        << ',' << k->name << '\n';
    }else if(record->kind==CUPTI_ACTIVITY_KIND_RUNTIME){
      const auto* a=reinterpret_cast<const CUpti_ActivityAPI*>(record);const char* name=nullptr;
      if(cuptiGetCallbackName(CUPTI_CB_DOMAIN_RUNTIME_API,a->cbid,&name)!=CUPTI_SUCCESS)name="unknown";
      output << "runtime," << a->correlationId << ',' << a->start << ',' << a->end << ",0,0,0,0," << name << '\n';
    }
  }
  std::size_t dropped=0;
  if(cuptiActivityGetNumDroppedRecords(context,stream,&dropped)!=CUPTI_SUCCESS)++failures;
  if(dropped)output << "dropped,0,0,0,0,0,0,0," << dropped << '\n';
  output.flush();std::free(buffer);
}
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
    std::size_t size=1024*1024,limit=2;
    check(cuptiActivitySetAttribute(CUPTI_ACTIVITY_ATTR_DEVICE_BUFFER_SIZE,sizeof(size),&size),"CUPTI bounded device buffer");
    check(cuptiActivitySetAttribute(CUPTI_ACTIVITY_ATTR_DEVICE_BUFFER_POOL_LIMIT,sizeof(limit),&limit),"CUPTI bounded device pool");
    check(cuptiActivityRegisterCallbacks(requested,completed),"CUPTI activity callbacks");
    check(cuptiActivityEnable(CUPTI_ACTIVITY_KIND_RUNTIME),"CUPTI runtime activity");
    check(cuptiActivityEnable(CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL),"CUPTI kernel activity");
    flusher=std::thread([this]{while(!stop.load()){
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      if(cuptiActivityFlushAll(0)!=CUPTI_SUCCESS)++failures;
    }});
  }
  ~Impl() {
    stop=true;if(flusher.joinable())flusher.join();
    cuptiActivityFlushAll(0);cuptiActivityDisable(CUPTI_ACTIVITY_KIND_CONCURRENT_KERNEL);cuptiActivityDisable(CUPTI_ACTIVITY_KIND_RUNTIME);
    std::lock_guard<std::mutex> lock(output_mutex);output << "traceErrors,0,0,0,0,0,0,0," << failures.load() << '\n';output.flush();output.close();
  }
};
ActivityTrace::ActivityTrace(bool stdio) {
  const char* directory=std::getenv("PNGGPU_CUDA_ACTIVITY_DIRECTORY");
  if(stdio&&directory&&*directory)impl_=std::make_unique<Impl>(directory);
}
ActivityTrace::~ActivityTrace()=default;
}
