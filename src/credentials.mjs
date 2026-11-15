import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openSync,fstatSync,readFileSync,closeSync,constants} from 'node:fs';
import {isAbsolute} from 'node:path';

export function validateCredentials(value) {
  const username=typeof value?.username==='string'?value.username.trim():'';
  const password=value?.password;
  if(!/^[A-Za-z0-9@._-]{3,128}$/.test(username)||typeof password!=='string'||!password.length||password.length>256) {
    throw new Error('invalid_credentials');
  }
  return {username,password};
}
export class MacCredentialStore {
  constructor(binary=fileURLToPath(new URL('../.local/rez-keychain',import.meta.url))){this.binary=binary;}
  run(command,input){return new Promise((resolve,reject)=>{
    const child=spawn(this.binary,[command],{stdio:['pipe','pipe','ignore']});
    const chunks=[];let size=0;const timer=setTimeout(()=>{child.kill();reject(new Error('credentials_locked'));},5000);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>8192){child.kill();reject(new Error('credentials_unavailable'));}else chunks.push(chunk);});
    child.on('error',()=>{clearTimeout(timer);reject(new Error('credentials_unavailable'));});
    child.on('close',code=>{clearTimeout(timer);try{const value=JSON.parse(Buffer.concat(chunks).toString());
      if(code!==0)throw new Error(['credentials_missing','credentials_locked'].includes(value.error)?value.error:'credentials_unavailable');resolve(value);
    }catch(error){reject(new Error(['credentials_missing','credentials_locked'].includes(error.message)?error.message:'credentials_unavailable'));}});
    child.stdin.on('error',()=>{});child.stdin.end(input?JSON.stringify(input):undefined);
  });}
  async status(){try{return await this.run('status');}catch{return {configured:false,available:false};}}
  async get(){return validateCredentials(await this.run('get'));}
  async set(value){await this.run('put',validateCredentials(value));return {configured:true,available:true};}
}

// Linux deployment reads an operator-provisioned private file. No password
// is included in the source bundle or exposed through process arguments.
export class PrivateFileCredentialStore {
  constructor(file){
    if(file&&!isAbsolute(file))throw new Error('invalid_credentials_file');
    this.file=file||null;
  }
  async get(){
    if(!this.file)throw new Error('credentials_missing');
    let fd;
    try{
      fd=openSync(this.file,constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=fstatSync(fd),mode=stat.mode&0o777;
      if(!stat.isFile()||stat.size>8192||![0o400,0o600].includes(mode)
        ||typeof process.getuid==='function'&&![0,process.getuid()].includes(stat.uid))throw new Error('credentials_unavailable');
      return validateCredentials(JSON.parse(readFileSync(fd,'utf8')));
    }catch(error){
      throw new Error(error.code==='ENOENT'?'credentials_missing':'credentials_unavailable');
    }finally{if(fd!==undefined)closeSync(fd);}
  }
  async status(){
    try{await this.get();return {configured:true,available:true};}
    catch{return {configured:false,available:false};}
  }
  async set(){throw new Error('credentials_read_only');}
}

export function createCredentialStore({platform=process.platform,credentialsFile=process.env.REZ_CREDENTIALS_FILE}={}){
  if(platform==='darwin')return new MacCredentialStore();
  if(platform==='linux')return new PrivateFileCredentialStore(credentialsFile);
  return {status:async()=>({configured:false,available:false}),get:async()=>{throw new Error('credentials_unavailable');},set:async()=>{throw new Error('credentials_unavailable');}};
}
