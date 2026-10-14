import test from 'node:test';
import assert from 'node:assert/strict';
import { startDataPlane } from '../index.js';

test('production entrypoint starts app lifecycle before listening', async () => {
  const calls=[];
  const server={listen(port,host,cb){calls.push(['listen',port,host]);cb?.();},close(cb){cb?.();}};
  const app={server,async start(){calls.push(['start']);},async stop(){calls.push(['stop']);}};
  const result=await startDataPlane({env:{PORT:'12345'},createAppImpl:()=>app});
  assert.deepEqual(calls.slice(0,2),[['start'],['listen',12345,'0.0.0.0']]);
  assert.equal(result.app,app);
  await result.stop();
  assert.equal(calls.at(-1)[0],'stop');
});
