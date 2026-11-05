import test from 'node:test';import assert from 'node:assert/strict';
import {EXPORT_SIZES,exportGeometry,exportCrop,exportFilter} from '../scripts/cuda_export_plan.mjs';
test('offline delivery has 24 bounded FP32 geometry/sample variants',()=>{
  assert.equal(EXPORT_SIZES.length,12);for(const [c,r] of EXPORT_SIZES)for(const [w,h] of [[4,8],[8,16]])assert(exportGeometry(c,r,w,h,719).frameBytes<=26214400);
  for(const args of [[640,360,4,8,719],[320,160,16,32,719],[320,160,8,16,721],[8,4,4,8,0]])assert.throws(()=>exportGeometry(...args));
});
test('legacy square layouts retain the scene and cropped layouts have exact rendered aspect',()=>{
  assert.deepEqual(exportCrop(854,480,160,80),{mode:'contain-black',crop:null});
  assert.deepEqual(exportCrop(854,480,160,45).crop,{x:3,y:1,width:848,height:477});
  for(const [c,r] of EXPORT_SIZES){const v=exportCrop(854,480,c,r);if(v.crop){assert.equal(v.crop.width*r*2,v.crop.height*c);assert(v.crop.x+v.crop.width<=854);assert(v.crop.y+v.crop.height<=480);}}
});
test('doubling samples doubles each sample-raster dimension without changing character rendering',()=>{
  assert.match(exportFilter(exportGeometry(160,45,4,8,719),exportCrop(854,480,160,45)),/scale=640:360/);
  assert.match(exportFilter(exportGeometry(160,45,8,16,719),exportCrop(854,480,160,45)),/scale=1280:720/);
});
