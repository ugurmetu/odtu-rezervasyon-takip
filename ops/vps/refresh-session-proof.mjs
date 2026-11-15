import fs from'node:fs';import {execFileSync}from'node:child_process';
const flag=process.argv.slice(2);if(flag.some(x=>!['--refresh-now','--status'].includes(x))||flag.length>1)throw Error('invalid refresh arguments');
const c=JSON.parse(fs.readFileSync(new URL('../../.local/vps-connection.json',import.meta.url),'utf8'));
const code=fs.readFileSync(new URL('./official-session-proof.py',import.meta.url),'utf8');
try{
 const r=JSON.parse(execFileSync('ssh',['-i',c.key,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',c.host,'sudo -u rez python3 -'+(flag.length?' '+flag[0]:'')],{input:code,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:90000}));
 if(flag[0]!=='--status'){
 fs.mkdirSync(new URL('../../.local/',import.meta.url),{recursive:true,mode:0o700});
 fs.writeFileSync(new URL('../../.local/official-session-refresh-last.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),...r},null,2)+'\n',{mode:0o600});
 }
 console.log(JSON.stringify(r));if(!r.ok)process.exitCode=1;
}catch{console.error(JSON.stringify({ok:false,state:'refresh_unavailable'}));process.exitCode=1;}

