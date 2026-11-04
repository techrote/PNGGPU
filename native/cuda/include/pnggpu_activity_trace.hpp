#pragma once
#include <memory>
namespace pnggpu {
// Optional process-local activity tracing. No hardware counters or machine settings.
class ActivityTrace {
 public:
#ifdef PNGGPU_CUPTI_ACTIVITY
  explicit ActivityTrace(bool stdio);
  ~ActivityTrace();
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
#else
  explicit ActivityTrace(bool) {}
#endif
};
}
