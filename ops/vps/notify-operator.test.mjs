import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOperatorChannel} from '../../src/operator-alerts.mjs';
import {notifyOperator,validateNotice} from './notify-operator.mjs';

const input={key:'reader_stale',state:'problem',message:'Takvim verisi güncellenmiyor.'};
function fixture(t,send){
 const dir=mkdtempSync(join(tmpdir(),'rez-monitor-notice-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const calls=[];
 return {calls,stateFile:join(dir,'notices.json'),ownerChatId:'123',
  channel:createOperatorChannel({sendMessage:async(id,text)=>{calls.push({id,text});if(send)return send();return {message_id:1};}},'123')};
}
test('plain public sender and wrong owner cannot send or create notice state',async t=>{
 const f=fixture(t);
 assert.equal((await notifyOperator({...f,input,channel:{sendMessage:()=>assert.fail()}})).result,'private_channel_required');
 assert.equal((await notifyOperator({...f,input,ownerChatId:'456'})).result,'private_channel_required');
 assert.equal(f.calls.length,0);
});
test('one problem then one recovery; repeated runs and concurrent sends do not duplicate',async t=>{
 const f=fixture(t);
 const results=await Promise.all([notifyOperator({...f,input,now:1}),notifyOperator({...f,input,now:2})]);
 assert.equal(results.filter(r=>r.result==='accepted').length,1);
 assert.equal((await notifyOperator({...f,input,now:3600001})).result,'duplicate_suppressed');
 assert.equal((await notifyOperator({...f,input:{...input,state:'recovered'},now:3600002})).result,'accepted');
 assert.equal((await notifyOperator({...f,input:{...input,state:'recovered'},now:3600003})).result,'no_open_problem');
 assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.id==='123'));
 assert.equal((statSync(f.stateFile).mode&0o777),0o600);
 assert.doesNotMatch(readFileSync(f.stateFile,'utf8'),/Takvim|chat|token|123/);
 assert.equal((await notifyOperator({...f,input,now:3600004})).result,'accepted');
});
test('recovery without a previously recorded problem stays quiet',async t=>{
 const f=fixture(t);assert.equal((await notifyOperator({...f,input:{...input,state:'recovered'}})).result,'no_open_problem');
 assert.equal(f.calls.length,0);
});
test('uncertain network delivery is not automatically repeated',async t=>{
 const f=fixture(t,()=>{throw new Error('timeout');});
 assert.equal((await notifyOperator({...f,input,now:1})).result,'uncertain');
 assert.equal((await notifyOperator({...f,input,now:7200001})).result,'duplicate_suppressed');
 assert.equal(f.calls.length,1);
});
test('definitely rejected request retries only after an hour',async t=>{
 const f=fixture(t,()=>{throw Object.assign(new Error('rejected'),{status:429});});
 assert.equal((await notifyOperator({...f,input,now:1})).result,'rejected');
 assert.equal((await notifyOperator({...f,input,now:2})).result,'duplicate_suppressed');
 assert.equal((await notifyOperator({...f,input,now:3600001})).result,'rejected');
 assert.equal(f.calls.length,2);
});
test('invalid keys and secret-shaped messages are rejected',()=>{
 for(const bad of [{...input,key:'../../anything'},{...input,state:'healthy'},{...input,message:'token=secret'},
  {...input,message:'123456789:'+ 'x'.repeat(32)},{...input,message:''}])assert.throws(()=>validateNotice(bad),/invalid_notice/);
});
