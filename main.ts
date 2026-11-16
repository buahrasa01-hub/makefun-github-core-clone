import { createApp } from './lib/app.ts';
// SCENARIO_SEED's first generated user is the fixed viewer; the bearer token is auth only.
const base=(process.env.MAKEFUN_ENV_URL||'').replace(/\/+$/,'');
if(!base){process.stderr.write('MAKEFUN_ENV_URL is not set\n');process.exit(1);}
const sleep=(n:number)=>new Promise<void>(r=>setTimeout(r,n));
async function register(port:number){for(;;){try{const r=await fetch(base+'/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({port}),signal:AbortSignal.timeout(10000)});if(r.status===200||r.status===409)return;}catch{}await sleep(250);}}
async function done(){let delay=100;for(;;){try{const r=await fetch(base+'/done',{signal:AbortSignal.timeout(10000)});if(r.ok&&(await r.json() as any).done===true)return;}catch{}await sleep(delay);delay=Math.min(delay+100,1000);}}
// The shared ForgeStore applies VIEWER_LOGIN to repo, issue, pull, git, GraphQL and MCP objects.
const server=createApp();
try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,resolve);});const a=server.address();if(!a||typeof a==='string')throw new Error('ephemeral bind failed');await register(a.port);await done();server.close();process.exit(0);}catch(e){process.stderr.write('entry failed: '+String(e)+'\n');process.exit(1);}
