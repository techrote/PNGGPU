/**
 * GPU-004: keep the parity-oracle photographic fit off the UI thread.
 * The worker imports the UNMODIFIED referencePhotoFit algorithm. This module
 * adds transport/progress only; no fitting arithmetic or search is changed.
 * Messages are throttled to avoid tens of thousands of postMessage calls.
 */
import { referencePhotoFit } from './reference_photo.js?gpu005';

const clock = () => performance.now();
self.onmessage = ({data}) => {
  if (data?.type !== 'fit') return;
  const started = clock();
  const count = data.config.canvas.columns * data.config.canvas.rows;
  let lastSent = started;
  self.postMessage({type:'progress', completedCells:0, totalCells:count, elapsedMs:0});
  try {
    const cells = referencePhotoFit({
      pixels:data.pixels,
      masks:data.masks,
      config:data.config,
      palette:data.palette,
      progress:fraction => {
        const t = clock();
        if (t-lastSent >= 125) {
          // ReferencePhotoFit reports the current cell, not completed count.
          const completedCells = Math.min(count, Math.max(0, Math.floor(fraction*count)));
          self.postMessage({type:'progress',completedCells,totalCells:count,elapsedMs:t-started});
          lastSent = t;
        }
      }
    });
    self.postMessage({type:'done',cells,computeMs:clock()-started,completedCells:count,totalCells:count},
      [cells.chosen.buffer,cells.fg.buffer,cells.bg.buffer]);
  } catch (error) {
    self.postMessage({type:'error',message:error?.message||String(error),stack:error?.stack||''});
  }
};
