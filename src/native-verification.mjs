import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {acquireLock,releaseLock,activeHold,activeLock,appendLedger} from './intervention.mjs';

const execFile=promisify(execFileCallback);
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const rect=r=>r&&['x','y','width','height'].every(k=>finite(r[k]))&&r.width>0&&r.height>0;
const inside=(x,y,r)=>x>r.x&&y>r.y&&x<r.x+r.width&&y<r.y+r.height;
const contains=(a,b)=>b.x>=a.x&&b.y>=a.y&&b.x+b.width<=a.x+a.width&&b.y+b.height<=a.y+a.height;
const owner='native-verification';
function configured(){
  return (process.env.REZ_READER_CONFIG_FILES||'').split(':').filter(Boolean).some(file=>{
    try{const c=JSON.parse(readFileSync(file,'utf8'));return c.nativeVerification===true&&c.autoManage===true&&c.autoLogin===true&&!c.maintenance;}catch{return false;}
  });
}

// Ordinary mouse input on the dedicated Linux browser display. No challenge
// response/token is read, constructed or substituted. A sent click is not a
// successful challenge: the existing portal observer checks that separately.
export function createNativeVerification({
  enabled=process.platform==='linux'&&process.env.REZ_NATIVE_VERIFICATION==='1',
  display=':99',privateDir=null,readControl=configured,now=()=>Date.now(),
  run=async(program,args,options={})=>(await execFile(program,args,{env:{...process.env,DISPLAY:display},timeout:options.timeout??3000,maxBuffer:8192})).stdout
}={}){
  const used=new Map();let busy=false,loaded=false,lastInputAt=0,lastResult=null;
  const file=privateDir&&join(privateDir,'native-verification.json');
  function load(){
    if(loaded)return;
    if(file){
      let state;try{state=JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
      if(state){
        if(!Array.isArray(state.used)||!finite(state.lastInputAt))throw Error('invalid input budget');
        for(const entry of state.used){if(!Array.isArray(entry)||typeof entry[0]!=='string'||!finite(entry[1]))throw Error('invalid input budget');used.set(...entry);}
        lastInputAt=state.lastInputAt;lastResult=state.lastResult||null;
      }
    }
    loaded=true;
  }
  function persist(outcome,detail){
    lastResult={at:new Date(now()).toISOString(),outcome,...(detail?{detail}:{})};
    if(!file)return;
    const tmp=file+'.tmp';
    writeFileSync(tmp,JSON.stringify({used:[...used],lastInputAt,lastResult})+'\n',{mode:0o600});
    chmodSync(tmp,0o600);renameSync(tmp,file);
  }
  async function windowInfo(){
    const mainPid=(await run('systemctl',['show','odtu-rez-browser.service','-p','MainPID','--value'])).trim();
    const focus=(await run('xdotool',['getwindowfocus'])).trim();
    if(!/^\d+$/.test(mainPid)||mainPid==='0'||!/^\d+$/.test(focus))return null;
    const pid=(await run('xdotool',['getwindowpid',focus])).trim();
    const title=(await run('xdotool',['getwindowname',focus])).trim();
    if(pid!==mainPid||!/ODTÜ SKSDB REZERVASYON SİSTEMİ.*(?:Login|Giriş)/i.test(title))return null;
    return focus;
  }
  return {enabled,status:()=>({enabled,lastResult}),async readiness({phase}={}){
    // Passive readiness never reserves a document or moves the pointer.
    // In particular, wait out a deployment/watchdog lock before the frame
    // spends its one authorised input attempt.
    try{
      if(!enabled||!await readControl())return {ready:false,retryable:false};
      if(busy||!['waiting_verification','preparing','signing_in'].includes(phase))return {ready:false,retryable:true};
      if(privateDir&&(activeHold(privateDir,now())||activeLock(privateDir,now())))return {ready:false,retryable:true};
      load();
      if(lastInputAt&&now()-lastInputAt<30000)return {ready:false,retryable:true};
      return {ready:true,retryable:false};
    }catch{return {ready:false,retryable:false};}
  },async inspect(){
    try{const sizes=(await run('xdotool',['getdisplaygeometry'])).trim().split(/\s+/).map(Number);
      return {available:sizes.length===2&&sizes.every(Number.isInteger),width:sizes[0],height:sizes[1]};
    }catch{return {available:false};}
  },async click(value,{phase}={}){
    if(!enabled)return {ok:false,reason:'native_disabled'};
    if(busy)return {ok:false,reason:'native_busy'};
    if(!['waiting_verification','preparing','signing_in'].includes(phase))return {ok:false,reason:'wrong_phase'};
    const {requestId,x,y,frame,viewport,expiresAt}=value||{};
    if(!finite(expiresAt)||expiresAt<=now()||expiresAt>now()+10000)return {ok:false,reason:'expired_request'};
    if(typeof requestId!=='string'||! /^[A-Za-z0-9_-]{8,128}$/.test(requestId)||!finite(x)||!finite(y)
      ||!rect(frame)||!rect(viewport)||!contains(viewport,frame)||!inside(x,y,frame)
      ||frame.width<150||frame.width>650||frame.height<35||frame.height>220
      ||viewport.width<300||viewport.height<300)return {ok:false,reason:'invalid_geometry'};
    busy=true;let locked=false,stage='preflight',inputStartedAt=0;
    try{
      if(!await readControl())return {ok:false,reason:'native_disabled'};
      if(privateDir){
        if(activeHold(privateDir,now()))return {ok:false,reason:'intervention_hold'};
        if(!acquireLock(privateDir,owner,30000,'scoped login checkbox input',now()))return {ok:false,reason:'intervention_busy'};
        locked=true;
      }
      load();
      for(const[id,at]of used)if(now()-at>86400000)used.delete(id);
      if(used.has(requestId)||used.size>=100)return {ok:false,reason:'already_used'};
      if(lastInputAt&&now()-lastInputAt<30000)return {ok:false,reason:'native_cooldown'};
      const focus=await windowInfo();if(!focus)return {ok:false,reason:'wrong_window'};
      const g=Object.fromEntries((await run('xdotool',['getwindowgeometry','--shell',focus])).trim().split('\n').map(l=>l.split('=')));
      const window={x:+g.X,y:+g.Y,width:+g.WIDTH,height:+g.HEIGHT};
      const dimensions=(await run('xdotool',['getdisplaygeometry'])).trim().split(/\s+/).map(Number);
      if(!rect(window)||dimensions.length!==2||!dimensions.every(n=>Number.isInteger(n)&&n>=600&&n<=4096)
        ||!contains({x:0,y:0,width:dimensions[0],height:dimensions[1]},window)
        ||!contains(window,viewport)||viewport.y-window.y<60||viewport.y-window.y>220
        ||viewport.x-window.x<0||viewport.x-window.x>30)return {ok:false,reason:'window_geometry_changed'};
      if(!await readControl()||await windowInfo()!==focus)return {ok:false,reason:'context_changed'};
      if(now()>=expiresAt)return {ok:false,reason:'expired_request'};
      // Persist BEFORE input. A timeout, restart or uncertain result never
      // permits a second click for this document.
      used.set(requestId,now());lastInputAt=now();persist('input_reserved');
      stage='pointer';
      const target={x:Math.round(x),y:Math.round(y)};
      const pointer=async()=>{
        const fields=Object.fromEntries((await run('xdotool',['getmouselocation','--shell'])).trim().split('\n').map(line=>line.split('=')));
        const location={x:Number(fields.X),y:Number(fields.Y)};
        if(!Number.isInteger(location.x)||!Number.isInteger(location.y))throw Error('pointer_unavailable');
        return location;
      };
      const same=location=>location.x===target.x&&location.y===target.y;
      // The installed xdotool can wait forever when --sync targets the
      // current position. Check the actual position rather than waiting for
      // movement; a failed move or changed context must never emit a click.
      if(!same(await pointer()))await run('xdotool',['mousemove',String(target.x),String(target.y)]);
      if(!same(await pointer())){persist('pointer_position_changed');return {ok:false,reason:'pointer_position_changed'};}
      if(!await readControl()||await windowInfo()!==focus){persist('context_changed');return {ok:false,reason:'context_changed'};}
      if(now()>=expiresAt){persist('expired_request');return {ok:false,reason:'expired_request'};}
      stage='input';inputStartedAt=now();
      await run('xdotool',['click','--clearmodifiers','1'],{timeout:8000});
      persist('input_sent');
      if(privateDir)appendLedger(privateDir,{actor:owner,action:'input_sent',reason:'one scoped login checkbox'},now());
      return {ok:true};
    }catch(error){
      const detail={stage,kind:error?.killed===true?'timeout':error?.code==='ENOENT'?'not_found':'failed'};
      if(stage==='input')detail.elapsedMs=Math.max(0,Math.min(60000,now()-inputStartedAt));
      if(loaded)try{persist('input_unavailable',detail);}catch{}
      return {ok:false,reason:'native_unavailable'};
    }finally{if(locked)releaseLock(privateDir,owner);busy=false;}
  }};
}
