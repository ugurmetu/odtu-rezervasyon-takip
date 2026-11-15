import test from 'node:test';import assert from 'node:assert/strict';import '../verification-checkbox.js';
const api=globalThis.RezVerificationCheckbox;
function fixture({name='Verify you are human',scope=true,disabled=false,checked=false,hidden=false,count=1,shadow=false,authorize=async()=>({allowed:true})}={}){
 let clicks=0;const items=Array.from({length:count},()=>({nodeType:1,children:[],isConnected:true,disabled,checked,
 matches:s=>s.includes('checkbox'),getAttribute:k=>k==='aria-label'?name:null,
 getBoundingClientRect:()=>({width:hidden?0:20,height:20}),click(){clicks++;}}));
 const shadowRoot={nodeType:11,children:items};const host={nodeType:1,children:[],matches:()=>false};
 const env={location:{origin:'https://challenges.cloudflare.com',ancestorOrigins:[scope?'https://rez.metu.edu.tr':'https://other.invalid']},document:{nodeType:9,children:shadow?[host]:items},getComputedStyle:()=>({display:'block',visibility:'visible'}),openShadow:e=>shadow&&e===host?shadowRoot:null,authorize};
 return {env,items,controller:api.create(env),clicks:()=>clicks};
}
test('one visible named checkbox is clicked once, without claiming acceptance or overwriting its checked state',async()=>{const f=fixture();const r=await f.controller.attempt();assert.equal(r.outcome,'clicked');assert.equal(r.attempted,true);assert.equal(r.verified,undefined);assert.equal(f.clicks(),1);assert.equal(f.items[0].checked,false);assert.equal((await f.controller.attempt()).outcome,'already_attempted');assert.equal(f.clicks(),1);});
test('closed-root access is read through the extension API rather than changing the widget',async()=>{const f=fixture({shadow:true});assert.equal((await f.controller.attempt()).outcome,'clicked');assert.equal(f.clicks(),1);});
test('Turkish human-verification labels are recognised',async()=>{const f=fixture({name:'İnsan olduğunuzu doğrulayın'});assert.equal((await f.controller.attempt()).outcome,'clicked');});
for(const [name,opts]of Object.entries({disabled:{disabled:true},checked:{checked:true},hidden:{hidden:true},absent:{count:0},unnamed:{name:''},unrelated:{name:'Kullanım koşullarını kabul ediyorum'}}))test(`${name} controls are never clicked`,async()=>{const f=fixture(opts);assert.equal((await f.controller.attempt()).outcome,'no_checkbox');assert.equal(f.clicks(),0);});
test('two candidate controls are ambiguous and neither is clicked',async()=>{const f=fixture({count:2});assert.equal((await f.controller.attempt()).outcome,'ambiguous');assert.equal(f.clicks(),0);});
test('a Cloudflare frame on another website is rejected before inspecting controls or authorising',async()=>{let requested=0;const f=fixture({scope:false,authorize:async()=>{requested++;return{allowed:true};}});assert.equal((await f.controller.attempt()).outcome,'out_of_scope');assert.equal(requested,0);assert.equal(f.clicks(),0);});
test('top-level Cloudflare pages and a different frame origin are rejected',()=>{assert.equal(api.inScope({origin:'https://challenges.cloudflare.com',ancestorOrigins:[]}),false);assert.equal(api.inScope({origin:'https://malicious.invalid',ancestorOrigins:['https://rez.metu.edu.tr']}),false);assert.equal(api.inScope({origin:'https://challenges.cloudflare.com',ancestorOrigins:['https://rez.metu.edu.tr','https://other.invalid']}),false);});
test('disabled or denied helper cannot click',async()=>{const f=fixture({authorize:async()=>({allowed:false})});assert.equal((await f.controller.attempt()).outcome,'not_authorized');assert.equal(f.clicks(),0);});
test('concurrent checks share one in-flight authorisation and cannot double-click',async()=>{let resolve;const pending=new Promise(r=>resolve=r);const f=fixture({authorize:()=>pending});const first=f.controller.attempt();assert.equal((await f.controller.attempt()).outcome,'busy');resolve({allowed:true});await first;assert.equal(f.clicks(),1);});
test('the DOM is located again after authorisation, and a removed element is not clicked',async()=>{const f=fixture({authorize:async()=>{f.items[0].isConnected=false;return {allowed:true};}});assert.equal((await f.controller.attempt()).outcome,'detached');assert.equal(f.clicks(),0);});
test('turning the helper off during authorisation cancels the pending click',async()=>{const f=fixture();f.env.isEnabled=()=>false;assert.equal((await f.controller.attempt()).outcome,'not_authorized');assert.equal(f.clicks(),0);});
test('a failed click is recorded and cannot trigger a retry storm',async()=>{const f=fixture();f.items[0].click=()=>{throw Error('not available');};assert.equal((await f.controller.attempt()).outcome,'click_failed');assert.equal((await f.controller.attempt()).outcome,'already_attempted');});
test('an unexpectedly large document fails closed',()=>{const f=fixture();f.env.document.children=Array.from({length:3001},()=>({nodeType:1,children:[],matches:()=>false}));assert.equal(api.findCheckbox(f.env).outcome,'too_large');});

test('opted-in native path sends only the located frame point and never emits a DOM click',async()=>{
 const positions=[];const f=fixture({authorize:async()=>({allowed:true,native:true})});
 f.items[0].getBoundingClientRect=()=>({x:10,y:20,width:20,height:20});f.env.nativeClick=async p=>{positions.push(p);return true;};
 assert.equal((await f.controller.attempt()).outcome,'clicked');assert.equal(f.clicks(),0);assert.deepEqual(positions,[{x:20,y:30}]);
 assert.equal((await f.controller.attempt()).outcome,'already_attempted');
});
test('native failure does not fall back to an extra DOM click',async()=>{const f=fixture({authorize:async()=>({allowed:true,native:true})});f.env.nativeClick=async()=>false;assert.equal((await f.controller.attempt()).outcome,'click_failed');assert.equal(f.clicks(),0);});
