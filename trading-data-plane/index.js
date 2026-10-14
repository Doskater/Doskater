import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';

export async function startDataPlane({ env = process.env, createAppImpl = createApp } = {}) {
  const app=createAppImpl({env});
  await app.start();
  const port=Number(env.PORT||10000);
  await new Promise((resolve,reject)=>{
    const onError=error=>{app.server.off?.('error',onError);reject(error);};
    app.server.once?.('error',onError);
    app.server.listen(port,'0.0.0.0',()=>{app.server.off?.('error',onError);resolve();});
  });
  return {
    app,
    async stop(){
      await app.stop();
      if(typeof app.server.close==='function') await new Promise(resolve=>app.server.close(()=>resolve()));
    }
  };
}

function direct(){try{return import.meta.url===pathToFileURL(process.argv[1]).href}catch{return false}}
if(direct()){
  startDataPlane().then(({app})=>{
    const address=app.server.address?.();
    console.log(`Trading Data Plane listening on :${address?.port??process.env.PORT??10000}`);
  }).catch(error=>{console.error(error);process.exitCode=1;});
}
