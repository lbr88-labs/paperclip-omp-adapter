import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runLocalRpc, steer, getSteeringState } from '../dist/server/rpc.js';

const childSource = `
const readline = require('node:readline');
process.on('SIGTERM', () => {});
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
emit({type:'ready'});
readline.createInterface({input:process.stdin}).on('line', line => {
 const command = JSON.parse(line);
 if (command.type === 'steer') return;
 emit({type:'response', id:command.id, command:command.type, success:true});
});
setInterval(() => {}, 1000);
`;

async function start(runId, overrides = {}) {
 const abort = new AbortController();
 let pid;
 const running = runLocalRpc({runId, command:process.execPath, args:['-e',childSource],
  prompt:'test', cwd:process.cwd(), env:process.env, timeoutSec:0, graceSec:0,
  signal:abort.signal, onSpawn:async meta => {pid=meta.pid;},
  onSession:async()=>{}, onLog:async()=>{}, ...overrides});
 for (let i=0;i<100 && getSteeringState(runId)!=='available';i++) await sleep(10);
 assert.equal(getSteeringState(runId),'available');
 return {running, abort, cleanup:async()=>{
  if(pid) {try {process.kill(-pid,'SIGKILL');} catch {}}
  await running.catch(()=>{});
 }};
}

test('steering acknowledgement has its own deadline and duplicate retries also settle', async t => {
 const runId='rpc-unanswered-steer';
 const run=await start(runId);
 try {
  t.mock.timers.enable({apis:['setTimeout']});
  for(let attempt=0;attempt<2;attempt++) {
   const result=steer({runId,message:'same message',correlationId:'same-id'})
    .then(()=>({resolved:true}),error=>({error}));
   t.mock.timers.tick(10_000);
   const observed=await Promise.race([result, new Promise(resolve=>setImmediate(()=>resolve({pending:true})))]);
   assert.equal(observed.pending,undefined,'steer must time out independently of the live run');
   assert.equal(observed.error?.code,'steering_timeout');
  }
 } finally {t.mock.timers.reset();await run.cleanup();}
});

test('run timeout forces termination even with zero grace', async () => {
 const run=await start('rpc-zero-grace',{timeoutSec:0.2});
 try {
  const result=await Promise.race([run.running,sleep(1800).then(()=>({stuck:true}))]);
  assert.equal(result.stuck,undefined,'SIGTERM-ignoring child must not outlive the deadline indefinitely');
  assert.equal(result.timedOut,true);
  assert.equal(result.signal,'SIGKILL');
 } finally {await run.cleanup();}
});

test('acknowledgement callback rejection preserves an accepted correlation', async () => {
 const runId='rpc-callback-rejection';
 const run=await start(runId,{args:['-e',childSource.replace("if (command.type === 'steer') return;", "if (command.type === 'steer' && global.accepted) { emit({type:'response',id:command.id,command:'steer',success:false,error:'duplicate send'}); return; } if(command.type === 'steer') global.accepted=true;")]});
 try {
  await assert.rejects(steer({runId,message:'once',correlationId:'callback-id',onAcknowledged:async()=>{throw Object.assign(new Error('host commit failed'),{code:'steering_rejected'});}}),/host commit failed/);
  assert.deepEqual(await steer({runId,message:'once',correlationId:'callback-id'}),{turnId:'steer:callback-id'});
 } finally {await run.cleanup();}
});
