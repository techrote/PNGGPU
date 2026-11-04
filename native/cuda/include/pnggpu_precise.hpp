#pragma once
#include "pnggpu_common.hpp"

#ifdef __CUDACC__
#define PNGGPU_EXACT __host__ __device__
#else
#define PNGGPU_EXACT
#endif

namespace pnggpu::precise {
struct Projection { double x, y, z, score; };
PNGGPU_EXACT inline double clamp(double x) { return x < 0 ? 0 : (x > 255 ? 255 : x); }
// This is the original JS CPU expression tree, not the WGSL dot grouping.
PNGGPU_EXACT inline Projection project(const std::uint32_t* pixels, const float* mask,
                                       Float4 stats, std::uint32_t n, std::uint32_t mask_stride=1) {
  double sums[3]{}, dots[3]{};
  for (std::uint32_t i=0; i<n; ++i) {
    const auto p=pixels[i];
    const double channels[3]={double(p&255u), double((p>>8)&255u), double((p>>16)&255u)};
    for (unsigned k=0; k<3; ++k) { sums[k]+=channels[k]; dots[k]+=channels[k]*double(mask[std::size_t(i)*mask_stride]); }
  }
  double explained=0;
  for (unsigned k=0; k<3; ++k) { const double cov=dots[k]-sums[k]*double(stats.x); explained+=cov*cov/double(stats.z); }
  return {dots[0],dots[1],dots[2],-explained};
}

PNGGPU_EXACT inline Result select(const std::uint32_t* pixels, const Float4* stats,
                                  const Float4* palette, const Projection* projections,
                                  std::uint32_t n, std::uint32_t gc,
                                  std::uint32_t nf, std::uint32_t nb) {
  double sums[3]{}, sum_p2=0;
  for (std::uint32_t i=0; i<n; ++i) {
    const auto p=pixels[i];
    const double channels[3]={double(p&255u),double((p>>8)&255u),double((p>>16)&255u)};
    for (unsigned k=0; k<3; ++k) { sums[k]+=channels[k]; sum_p2+=channels[k]*channels[k]; }
  }
  const unsigned keep=gc<32?gc:32;
  std::uint32_t ids[32]; double scores[32]; unsigned size=0;
  for (std::uint32_t g=0; g<gc; ++g) {
    const double score=projections[g].score;
    if(size==keep && !(score<scores[size-1]))continue;
    unsigned pos=size<keep?size:keep-1;
    while(pos && score<scores[pos-1]) { ids[pos]=ids[pos-1]; scores[pos]=scores[pos-1]; --pos; }
    ids[pos]=g; scores[pos]=score; if(size<keep)++size;
  }
  const auto seed=ids[0];
  const double dots[3]={projections[seed].x,projections[seed].y,projections[seed].z};
  double fg[3],bg[3];
  for(unsigned k=0;k<3;++k) {
    const double beta=(dots[k]-sums[k]*double(stats[seed].x))/double(stats[seed].z);
    bg[k]=clamp(sums[k]/double(n)-beta*double(stats[seed].x)); fg[k]=clamp(bg[k]+beta);
  }
  std::uint32_t colors[2][16]; double distances[2][16];
  for(unsigned side=0;side<2;++side) {
    const unsigned count=side?8:16;
    for(unsigned color=0;color<count;++color) {
      const auto p=palette[color]; const double c[3]={double(p.x),double(p.y),double(p.z)};
      const auto* target=side?bg:fg;
      const double a=target[0]-c[0],b=target[1]-c[1],d=target[2]-c[2];
      const double distance=(a*a+b*b)+d*d;
      unsigned pos=color;
      while(pos && distance<distances[side][pos-1]) {
        colors[side][pos]=colors[side][pos-1]; distances[side][pos]=distances[side][pos-1]; --pos;
      }
      colors[side][pos]=color; distances[side][pos]=distance;
    }
  }
  double best=1.7976931348623157e308; Result result{};
  for(unsigned fi=0;fi<nf;++fi)for(unsigned bi=0;bi<nb;++bi) {
    const auto f=palette[colors[0][fi]],b=palette[colors[1][bi]];
    const double fc[3]={double(f.x),double(f.y),double(f.z)},bc[3]={double(b.x),double(b.y),double(b.z)};
    for(unsigned at=0;at<size;++at) {
      const auto g=ids[at]; const auto s=stats[g]; const auto p=projections[g];
      const double dp[3]={p.x,p.y,p.z}; double error=sum_p2;
      for(unsigned k=0;k<3;++k) {
        const double d=fc[k]-bc[k];
        error+=double(n)*bc[k]*bc[k]+2.0*bc[k]*d*double(s.x)*double(n)
          +d*d*double(s.y)-2.0*bc[k]*sums[k]-2.0*d*dp[k];
      }
      if(error<best) { best=error; result={g,colors[0][fi],colors[1][bi],0}; }
    }
  }
  return result;
}
} // namespace pnggpu::precise
#undef PNGGPU_EXACT
