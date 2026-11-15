(function(root){
'use strict';
const PORTAL='https://rez.metu.edu.tr',CHALLENGE='https://challenges.cloudflare.com';
function inScope(location){
 const ancestors=Array.from(location?.ancestorOrigins||[]);
 return location?.origin===CHALLENGE&&ancestors.length>0&&ancestors.at(-1)===PORTAL;
}
function accessibleName(element){
 const label=element.getAttribute('aria-label')||Array.from(element.labels||[]).map(x=>x.textContent||'').join(' ')||element.closest?.('label')?.textContent||element.textContent||'';
 return String(label).replace(/\s+/g,' ').trim();
}
function findCheckbox(env){
 if(!inScope(env.location))return {outcome:'out_of_scope'};
 const candidates=[],roots=new Set(),stack=[env.document];let visited=0;
 while(stack.length){
  if(++visited>3000)return {outcome:'too_large'};
  const node=stack.pop();if(!node)continue;
  if(node.nodeType===1){
   if(node.matches?.('input[type="checkbox"], [role="checkbox"]')){
    const box=node.getBoundingClientRect(),style=env.getComputedStyle(node);
    const visible=box.width>0&&box.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.visibility!=='collapse';
    const checked=node.checked===true||node.getAttribute('aria-checked')==='true';
    const disabled=node.disabled===true||node.getAttribute('aria-disabled')==='true';
    if(visible&&!checked&&!disabled&&/verify.*human|human.*verify|insan|robot\s+degil/.test(accessibleName(node).normalize('NFKD').replace(/\p{M}/gu,'').replace(/ı/g,'i').toLowerCase()))candidates.push(node);
   }
   let shadow=node.shadowRoot;try{shadow=env.openShadow?.(node)||shadow;}catch{}
   if(shadow&&!roots.has(shadow)){roots.add(shadow);stack.push(shadow);}
  }
  for(const child of Array.from(node.children||[]))stack.push(child);
 }
 if(candidates.length!==1)return {outcome:candidates.length?'ambiguous':'no_checkbox',roots:[...roots]};
 return {outcome:'candidate',element:candidates[0],roots:[...roots]};
}
function create(env){
 let attempted=false,inFlight=false;
 async function attempt(){
  if(attempted)return {outcome:'already_attempted',attempted:false};
  if(inFlight)return {outcome:'busy',attempted:false};
  if(!inScope(env.location))return {outcome:'out_of_scope',attempted:false};
  inFlight=true;
  try{
   const permission=await env.authorize();if(permission?.allowed!==true)return {outcome:'not_authorized',attempted:false,retryable:permission?.retryable===true};
   if(env.isEnabled&&env.isEnabled()!==true)return {outcome:'not_authorized',attempted:false};
   const found=findCheckbox(env);
   if(found.outcome!=='candidate')return {outcome:found.outcome,attempted:false};
   if(found.element.isConnected===false)return {outcome:'detached',attempted:false};
   attempted=true;
   try{
    if(permission.native===true){
     if(typeof env.nativeClick!=='function'||Array.from(env.location?.ancestorOrigins||[]).length!==1)return {outcome:'click_failed',attempted:true};
     const box=found.element.getBoundingClientRect();
     if(await env.nativeClick({x:box.x+box.width/2,y:box.y+box.height/2})!==true)return {outcome:'click_failed',attempted:true};
    }else found.element.click();
   }catch{return {outcome:'click_failed',attempted:true};}
   // A synthetic DOM click is never presented as trusted input or proof of
   // challenge acceptance. The real portal must still validate the result.
   return {outcome:'clicked',attempted:true};
  }finally{inFlight=false;}
 }
 return {attempt,find:()=>findCheckbox(env)};
}
root.RezVerificationCheckbox={create,findCheckbox,inScope};
})(globalThis);
