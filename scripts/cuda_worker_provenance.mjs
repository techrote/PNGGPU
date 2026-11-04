import {readFile} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
export async function verifyWorker(worker,root) {
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  const sourceCommit=(await readFile(resolve(dirname(worker),'SOURCE_COMMIT.txt'),'utf8')).trim();
  const receipt=JSON.parse(await readFile(resolve(dirname(worker),'worker-sha256.json'),'utf8'));
  const sha256=createHash('sha256').update(await readFile(worker)).digest('hex');
  if(!/^[a-f0-9]{40}$/.test(sourceCommit)||receipt.sourceCommit!==sourceCommit||receipt.sha256!==sha256||receipt.worker!==basename(worker))
    throw new Error('Worker source/hash receipt mismatch');
  if(git('diff',sourceCommit,'--','native/cuda')||git('ls-files','--others','--exclude-standard','native/cuda'))
    throw new Error('Native sources differ from worker source; build a matching normal worker');
  if(!/^pnggpu_cuda_worker(?:\.exe)?$/.test(basename(worker)))throw new Error('Only the normal CUDA worker is allowed');
  return {sourceCommit,sha256,receipt};
}
