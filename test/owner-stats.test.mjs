import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalStore} from '../src/store.mjs';
import {ownerStatsText} from '../src/owner-stats.mjs';
import {redirectReply} from '../src/legacy-redirect.mjs';

const update=(chat,text)=>({update_id:1,message:{chat:{id:chat,type:'private'},from:{id:chat},text}});
test('daily counters count new users once and people who leave; no per-person record is kept',t=>{
 const dir=mkdtempSync(join(tmpdir(),'rez-stats-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new LocalStore(join(dir,'state.json'),{accessMode:'public'});
 store.admitChat(770011);store.admitChat(770012);store.admitChat(770011);store.admitChat(770013,'linkedin');
 store.forgetChat(770012);store.forgetChat(770099);
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Istanbul'}).format(new Date());
 assert.deepEqual(store.state.userStats.days[today],{joined:3,left:1});
 assert.ok(!/7700/.test(JSON.stringify(store.state.userStats)),'no chat id in the counters');
 const text=ownerStatsText(store.state,{limit:5000});
 assert.match(text,/👥 Toplam: 2 \/ 5000/);assert.match(text,/: \+3 \/ −1/);assert.equal(text.split('\n').filter(l=>/^\d{2}\.\d{2}/.test(l)).length,7);
});
test('only the owner gets statistics from the operator bot; anyone else is just redirected',()=>{
 const ownerStats=()=>'📊 Kullanıcılar · test';
 assert.equal(redirectReply(update(123,'/istatistik'),{operatorOwnerId:'123',ownerStats}).text,'📊 Kullanıcılar · test');
 assert.equal(redirectReply(update(123,'/stats@odtu_bot'),{operatorOwnerId:'123',ownerStats}).owner,true);
 assert.match(redirectReply(update(123,'merhaba'),{operatorOwnerId:'123',ownerStats}).text,/\/istatistik/);
 const stranger=redirectReply(update(456,'/istatistik'),{operatorOwnerId:'123',ownerStats});
 assert.match(stranger.text,/yeni adresine taşındı/);assert.doesNotMatch(stranger.text,/Kullanıcılar|Toplam/);assert.equal(stranger.owner,undefined);
});
