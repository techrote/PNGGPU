#pragma once
#include "pnggpu_common.hpp"
#include <cmath>
#include <limits>
#ifdef __CUDACC__
#include <cuda_runtime.h>
#define PNGGPU_BOUND __host__ __device__
#else
#define PNGGPU_BOUND
#endif

namespace pnggpu::guard {
struct Interval { float lo,hi; };
PNGGPU_BOUND inline float down(double x) {
#ifdef __CUDA_ARCH__
  return __double2float_rd(x);
#else
  const float v=float(x); return double(v)>x?std::nextafter(v,-std::numeric_limits<float>::infinity()):v;
#endif
}
PNGGPU_BOUND inline float up(double x) {
#ifdef __CUDA_ARCH__
  return __double2float_ru(x);
#else
  const float v=float(x); return double(v)<x?std::nextafter(v,std::numeric_limits<float>::infinity()):v;
#endif
}
PNGGPU_BOUND inline Interval point(double x) { return {down(x),up(x)}; }
// Endpoints are binary32; their sums/products are exact in binary64. Directed
// conversion encloses the CPU binary64 operation, including its rounding.
PNGGPU_BOUND inline Interval operator+(Interval a,Interval b) {
#ifdef __CUDA_ARCH__
  return {__fadd_rd(a.lo,b.lo),__fadd_ru(a.hi,b.hi)};
#else
  return {down(double(a.lo)+b.lo),up(double(a.hi)+b.hi)};
#endif
}
PNGGPU_BOUND inline Interval operator-(Interval a,Interval b) {
#ifdef __CUDA_ARCH__
  return {__fsub_rd(a.lo,b.hi),__fsub_ru(a.hi,b.lo)};
#else
  return {down(double(a.lo)-b.hi),up(double(a.hi)-b.lo)};
#endif
}
PNGGPU_BOUND inline Interval operator*(Interval a,Interval b) {
#ifdef __CUDA_ARCH__
  return {fminf(fminf(__fmul_rd(a.lo,b.lo),__fmul_rd(a.lo,b.hi)),fminf(__fmul_rd(a.hi,b.lo),__fmul_rd(a.hi,b.hi))),
          fmaxf(fmaxf(__fmul_ru(a.lo,b.lo),__fmul_ru(a.lo,b.hi)),fmaxf(__fmul_ru(a.hi,b.lo),__fmul_ru(a.hi,b.hi)))};
#else
  const double p[4]={double(a.lo)*b.lo,double(a.lo)*b.hi,double(a.hi)*b.lo,double(a.hi)*b.hi};
  double lo=p[0],hi=p[0];for(unsigned i=1;i<4;++i){if(p[i]<lo)lo=p[i];if(p[i]>hi)hi=p[i];}
  return {down(lo),up(hi)};
#endif
}
// All divisors here are exact, strictly positive sample counts/variances.
PNGGPU_BOUND inline Interval divide(Interval a,float b) {
#ifdef __CUDA_ARCH__
  return {__fdiv_rd(a.lo,b),__fdiv_ru(a.hi,b)};
#else
  return {down(double(a.lo)/double(b)),up(double(a.hi)/double(b))};
#endif
}
PNGGPU_BOUND inline Interval square(Interval a) {
#ifdef __CUDA_ARCH__
  return {a.lo<=0 && a.hi>=0?0:fminf(__fmul_rd(a.lo,a.lo),__fmul_rd(a.hi,a.hi)),
    fmaxf(__fmul_ru(a.lo,a.lo),__fmul_ru(a.hi,a.hi))};
#else
  const double x=double(a.lo)*a.lo,y=double(a.hi)*a.hi;
  return {a.lo<=0 && a.hi>=0?0:down(x<y?x:y),up(x>y?x:y)};
#endif
}
PNGGPU_BOUND inline Interval clamp(Interval a) {
  return {a.lo<0?0:(a.lo>255?255:a.lo),a.hi<0?0:(a.hi>255?255:a.hi)};
}
PNGGPU_BOUND inline Interval dots(float value,std::uint32_t n,float total) {
  // gamma_(2n)(u32)*255n + gamma_n(u64)*255n < this bound, n<=2048.
  const float delta=up(2.0*double(n)*double(n+1u)*255.0/16777216.0);
  const auto expanded=point(value)+Interval{-delta,delta};
  const float lo=expanded.lo,hi=expanded.hi;
  return {lo<0?0:lo,hi>total?total:hi};
}
// -1 before, +1 after, 0 unproven. Never resolve an overlap by tolerance.
PNGGPU_BOUND inline int compare(Interval a,Interval b) {
  if(a.hi<b.lo)return -1;
  if(a.lo>b.hi)return 1;
  return 0;
}

PNGGPU_BOUND inline Result select(const std::uint32_t* pixels,const Float4* stats,
                                  const Float4* palette,const Float4* projections,
                                  std::uint32_t n,std::uint32_t gc,std::uint32_t nf,std::uint32_t nb) {
  std::uint32_t totals[3]{},sum_p2=0;
  for(std::uint32_t i=0;i<n;++i) {
    const auto p=pixels[i];const unsigned c[3]={p&255u,(p>>8)&255u,(p>>16)&255u};
    for(unsigned k=0;k<3;++k){totals[k]+=c[k];sum_p2+=c[k]*c[k];}
  }
  const unsigned keep=gc<32?gc:32;
  std::uint32_t ids[32];Interval scores[32];unsigned size=0;float outside_lower=3.402823466e+38f;
  for(std::uint32_t g=0;g<gc;++g) {
    const auto p=projections[g];const float dp[3]={p.x,p.y,p.z};const auto s=stats[g];
    Interval explained=point(0);
    for(unsigned k=0;k<3;++k) {
      const auto cov=dots(dp[k],n,float(totals[k]))-point(totals[k])*point(s.x);
      explained=explained+divide(square(cov),s.z);
    }
    const Interval score={-explained.hi,-explained.lo};
    if(size==keep) {
      if(!(score.lo<scores[size-1].lo)) { if(score.lo<outside_lower)outside_lower=score.lo;continue; }
      if(scores[size-1].lo<outside_lower)outside_lower=scores[size-1].lo;
    }
    unsigned pos=size<keep?size:keep-1;
    while(pos) {
      if(!(score.lo<scores[pos-1].lo))break;
      ids[pos]=ids[pos-1];scores[pos]=scores[pos-1];--pos;
    }
    ids[pos]=g;scores[pos]=score;if(size<keep)++size;
  }
  for(unsigned i=1;i<size;++i)if(compare(scores[i-1],scores[i])!=-1)return {0,0,0,1};
  if(gc>keep && !(scores[size-1].hi<outside_lower))return {0,0,0,1};
  const auto seed=ids[0];const auto s=stats[seed],p=projections[seed];
  const float dp[3]={p.x,p.y,p.z};Interval foreground[3],background[3];
  for(unsigned k=0;k<3;++k) {
    const auto beta=divide(dots(dp[k],n,float(totals[k]))-point(totals[k])*point(s.x),s.z);
    background[k]=clamp(divide(point(totals[k]),float(n))-beta*point(s.x));
    foreground[k]=clamp(background[k]+beta);
  }
  std::uint32_t colors[2][16];Interval distances[2][16];
  for(unsigned side=0;side<2;++side)for(unsigned c=0;c<(side?8u:16u);++c) {
    const auto pcolor=palette[c];const float channels[3]={pcolor.x,pcolor.y,pcolor.z};
    const auto* target=side?background:foreground;
    auto distance=square(target[0]-point(channels[0]))+square(target[1]-point(channels[1]));
    distance=distance+square(target[2]-point(channels[2]));
    unsigned pos=c;
    while(pos) {
      if(!(distance.lo<distances[side][pos-1].lo))break;
      colors[side][pos]=colors[side][pos-1];distances[side][pos]=distances[side][pos-1];--pos;
    }
    colors[side][pos]=c;distances[side][pos]=distance;
  }
  for(unsigned side=0;side<2;++side) {
    const unsigned count=side?8:16,selected=side?nb:nf;
    for(unsigned i=1;i<selected;++i)if(compare(distances[side][i-1],distances[side][i])!=-1)return {0,0,0,2};
    if(selected<count && compare(distances[side][selected-1],distances[side][selected])!=-1)return {0,0,0,2};
  }
  bool have_best=false;Interval best{};Result result{};outside_lower=3.402823466e+38f;
  for(unsigned fi=0;fi<nf;++fi)for(unsigned bi=0;bi<nb;++bi) {
    const auto f=palette[colors[0][fi]],b=palette[colors[1][bi]];
    const float fc[3]={f.x,f.y,f.z},bc[3]={b.x,b.y,b.z};
    for(unsigned at=0;at<size;++at) {
      const auto g=ids[at];const auto gs=stats[g],gp=projections[g];const float projected[3]={gp.x,gp.y,gp.z};
      auto error=point(sum_p2);
      for(unsigned k=0;k<3;++k) {
        const auto bg=point(bc[k]),d=point(fc[k])-bg,two=point(2),samples=point(n);
        error=error+(samples*bg*bg+two*bg*d*point(gs.x)*samples+d*d*point(gs.y)
          -two*bg*point(totals[k])-two*d*dots(projected[k],n,float(totals[k])));
      }
      if(!have_best || error.lo<best.lo) {
        if(have_best && best.lo<outside_lower)outside_lower=best.lo;
        have_best=true;best=error;result={g,colors[0][fi],colors[1][bi],0};
      } else if(error.lo<outside_lower)outside_lower=error.lo;
    }
  }
  if(!(best.hi<outside_lower))return {0,0,0,3};
  return result;
}
} // namespace pnggpu::guard
#undef PNGGPU_BOUND
