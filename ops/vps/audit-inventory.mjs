import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
process.chdir(project);
const folder=path.resolve(process.argv[2]||'.local/nightly-audits/inventory');
if(!folder.startsWith(path.join(project,'.local')+path.sep))throw Error('Private audit output required');
fs.mkdirSync(folder,{recursive:true,mode:0o700});
const c=JSON.parse(fs.readFileSync('.local/vps-connection.json')),receipt=JSON.parse(fs.readFileSync('.local/vps-current-release.json'));
const expected=JSON.parse(fs.readFileSync(receipt.release+'/release.json'));
const expectedManifest=JSON.parse(fs.readFileSync(receipt.release+'/source/extension/manifest.json'));
const code=String.raw`import pathlib,json,subprocess,os,time,hashlib,datetime,pwd,stat,re
root=pathlib.Path('/opt/odtu-rez/current');private=pathlib.Path('/var/lib/odtu-rez/private');now=time.time();uid=pwd.getpwnam('rez').pw_uid
iso=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
def run(args):
 r=subprocess.run(args,capture_output=True,text=True,timeout=15)
 return r.stdout.strip() if r.returncode==0 else ''
def stamp(value):
 try:
  if isinstance(value,(int,float)):return value/1000
  return datetime.datetime.fromisoformat(str(value).replace('Z','+00:00')).timestamp()
 except:return None
def elapsed(value):
 t=stamp(value)
 return max(0,now-t) if t is not None else None
def newest_age(items,field):
 values=[elapsed(i.get(field)) for i in items]
 return max((v for v in values if v is not None),default=0)
def secure_file(p):
 try:
  s=p.lstat()
  return {'exists':True,'regular':stat.S_ISREG(s.st_mode),'privateMode':s.st_mode&0o077==0,'ownedByApp':s.st_uid==uid}
 except:return {'exists':False,'regular':False,'privateMode':False,'ownedByApp':False}
expected=json.loads(${JSON.stringify(JSON.stringify(expected))})
mis=[]
for p,h in expected['files'].items():
 f=root/p
 if not f.is_file():mis.append(p+':missing');continue
 if p=='extension/manifest.json':continue
 if hashlib.sha256(f.read_bytes()).hexdigest()!=h:mis.append(p+':hash')
expected_manifest=json.loads(${JSON.stringify(JSON.stringify(expectedManifest))})
actual_manifest=json.loads((root/'extension/manifest.json').read_text())
for m in [expected_manifest,actual_manifest]:m.pop('key',None)
if actual_manifest!=expected_manifest:mis.append('extension/manifest.json:content')
services={}
for n in ['odtu-rez','odtu-rez-browser','odtu-rez-display']:
 txt=run(['systemctl','show',n+'.service','-p','ActiveState','-p','SubState','-p','NRestarts','-p','MemoryCurrent','-p','MemoryPeak','-p','MainPID','-p','ExecMainStartTimestamp','-p','MemoryHigh','-p','MemoryMax'])
 services[n]=dict(line.split('=',1) for line in txt.splitlines() if '=' in line)
state=json.loads((private/'state.json').read_text());env={}
state_valid=state.get('version')==1 and isinstance(state.get('subscriptions'),list) and isinstance(state.get('outbox'),list)
for line in (private/'runtime.env').read_text().splitlines():
 if '=' in line and not line.startswith('#'):
  k,v=line.split('=',1);env[k]=v
secure={name:secure_file(private/name) for name in ['state.json','runtime.env','telegram-token','telegram-legacy-token','ingest.key','owner-chat-id']}
for var in ['REZ_CREDENTIALS_FILE','REZ_OPERATOR_BOT_TOKEN_FILE']:
 p=pathlib.Path(env.get(var,''));secure[var]={'configured':var in env,**secure_file(p)}
ports=[]
for line in run(['ss','-lnt']).splitlines()[1:]:
 bits=line.split()
 if len(bits)<4:continue
 address=bits[3];port=address.rsplit(':',1)[-1]
 if port in ['8765','6080','5900','9222','22']:ports.append({'port':int(port),'loopback':address.startswith('127.0.0.1:') or address.startswith('[::1]:')})
def log_summary(since):
 lines=run(['journalctl','-u','odtu-rez.service','-u','odtu-rez-browser.service','--since',since,'-n','20000','-o','cat','--no-pager']).splitlines()
 patterns={'error':r'\berror\b','failed':r'\bfailed\b','oom':r'\boom\b','out of memory':r'out of memory','Unhandled':r'\bunhandled\b','Too many requests':r'too many requests','conflict':r'\bconflict\b','401':r'\b401\b','403':r'\b403\b','429':r'\b429\b'}
 return {**{k:sum(bool(re.search(p,line,re.I)) for line in lines) for k,p in patterns.items()},'limitReached':len(lines)>=20000}
backups=list((private/'backups').glob('*.json')) if (private/'backups').exists() else []
latest=max(backups,key=lambda p:p.stat().st_mtime) if backups else None
backup=None
if latest:
 try:
  b=json.loads(latest.read_text());valid=b.get('version')==1 and isinstance(b.get('subscriptions'),list) and isinstance(b.get('outbox'),list)
 except:valid=False
 directory=(private/'backups').lstat()
 backup={'count':len(backups),'ageSeconds':round(now-latest.stat().st_mtime),'valid':valid,**secure_file(latest),
  'directoryPrivateMode':stat.S_ISDIR(directory.st_mode)and directory.st_mode&0o077==0,'directoryOwnedByApp':directory.st_uid==uid}
backup_timer=dict(line.split('=',1)for line in run(['systemctl','show','odtu-rez-backup.timer','-p','LoadState','-p','ActiveState','-p','UnitFileState','-p','NextElapseUSecRealtime']).splitlines()if '='in line)
backup_job=dict(line.split('=',1)for line in run(['systemctl','show','odtu-rez-backup.service','-p','Result','-p','ExecMainStatus','-p','ExecMainStartTimestamp','-p','PrivateNetwork']).splitlines()if '='in line)
backup_schedule={'installed':backup_timer.get('LoadState')=='loaded','enabled':backup_timer.get('UnitFileState')=='enabled','active':backup_timer.get('ActiveState')=='active',
 'nextAt':backup_timer.get('NextElapseUSecRealtime'),'lastResult':backup_job.get('Result'),'lastExitCode':backup_job.get('ExecMainStatus'),'lastStartedAt':backup_job.get('ExecMainStartTimestamp'),'networkIsolated':backup_job.get('PrivateNetwork')=='yes'}
outbox=state.get('outbox',[]);counts={s:sum(i.get('status')==s for i in outbox) for s in {i.get('status') for i in outbox}}
jobs=list((state.get('slotStatusJobs') or {}).values());broadcast=state.get('broadcast') or {}
queued=[{'at':i.get('event',{}).get('observedAt')} for i in outbox if i.get('status')=='queued']
sending=[i for i in outbox if i.get('status')=='sending'];recent=lambda value:elapsed(value) is not None and elapsed(value)<=86400
# Only aggregate counters leave the server; no recipient, text, event or preference is exported.
delivery={'oldestQueuedAgeSeconds':newest_age(queued,'at'),'oldestSendingAgeSeconds':newest_age(sending,'sendStartedAt'),
 'uncertain':counts.get('uncertain',0),'recentExpired':sum(i.get('status')=='expired' and recent(i.get('failedAt')) for i in outbox),
 'slotUncertain':sum(j.get('notifyState')=='uncertain' for j in jobs),'oldestSlotJobAgeSeconds':newest_age(jobs,'observedAt'),
 'slotFailedRecent':recent(state.get('slotUpdateFailedAt')),'slotUncertainRecent':recent(state.get('slotUpdateUncertainAt')),
 'broadcastPending':len(broadcast.get('pending',[])),'broadcastAgeSeconds':elapsed(broadcast.get('createdAt')) or 0}
def health_history():
 p=private/'health-history.ndjson'
 if not p.is_file():return {'samples':0,'unavailable':True}
 rows=[];malformed=0
 # The producer caps this history at seven days; refuse unbounded input.
 if p.stat().st_size>16*1024*1024:return {'samples':0,'oversize':True}
 for line in p.read_text().splitlines():
  try:
   r=json.loads(line);t=stamp(r.get('at'))
   if t is not None and now-86400<=t<=now:rows.append(r)
  except:malformed+=1
 rows.sort(key=lambda r:stamp(r['at']))
 if not rows:return {'samples':0,'malformed':malformed}
 times=[stamp(r['at']) for r in rows];gaps=[b-a for a,b in zip(times,times[1:])]
 bad_calendar=lambda r:r.get('calendarState') in ['login_required','calendar_unavailable','no_tab','paused','unknown'] or r.get('calendarAgeSeconds') is None or r.get('calendarAgeSeconds',0)>240
 bad_poll=lambda r:r.get('telegramConfigured')!=True or r.get('telegramPollAgeSeconds') is None or r.get('telegramPollAgeSeconds',0)>180
 trouble=lambda r:any(r.get(k,0)>0 for k in ['queued','sending','uncertain','failed','expired'])
 resets=sum(isinstance(a.get('uptimeSeconds'),(int,float)) and isinstance(b.get('uptimeSeconds'),(int,float)) and b['uptimeSeconds']<a['uptimeSeconds'] for a,b in zip(rows,rows[1:]))
 return {'samples':len(rows),'firstAt':rows[0]['at'],'lastAt':rows[-1]['at'],'observedHours':round((times[-1]-times[0])/3600,2),
  'maxGapSeconds':round(max(gaps,default=0)),'calendarTrouble':sum(map(bad_calendar,rows)),'telegramTrouble':sum(map(bad_poll,rows)),
  'deliveryTrouble':sum(map(trouble,rows)),'uptimeResets':resets,'malformed':malformed}
disk=run(['df','-Pk','/']).splitlines()[-1].split()[1:5]
result={'at':iso(),'releaseMatches':str(root.resolve())==${JSON.stringify(receipt.remoteRelease)},'sourceMismatches':mis,
 'extensionVersion':json.loads((root/'extension/manifest.json').read_text()).get('version'),'services':services,'load':os.getloadavg(),'cpuCount':os.cpu_count(),
 'disk':disk,'diskAvailableMiB':round(int(disk[2])/1024),'clockSynchronized':run(['timedatectl','show','-p','NTPSynchronized','--value']),'backupSchedule':backup_schedule,
 'privateFiles':secure,'privateDirectoryMode':private.stat().st_mode&0o777,'listeners':ports,'logSummary30m':log_summary('30 minutes ago'),
 'logSummary24h':log_summary('24 hours ago'),'backup':backup,'stateValid':state_valid,'stateMiB':round((private/'state.json').stat().st_size/1048576,2),
 'outboxCounts':counts,'delivery':delivery,'healthHistory24h':health_history(),'slotAlertStates':len(state.get('slotAlerts',{})),
 'slotStatusJobs':len(jobs),'selectionCount':len(state.get('subscriptions',[])),'chatCount':len(state.get('betaApprovedChatIds',[])),
 'draftCount':len(state.get('selectionDrafts',{})),'broadcastPending':len(broadcast.get('pending',[]))}
print(json.dumps(result))`;
try{
 const raw=execFileSync('ssh',['-i',c.key,'-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',c.host,'sudo python3 -'],{input:code,encoding:'utf8',timeout:35000,stdio:['pipe','pipe','pipe']});
 const result=JSON.parse(raw);fs.writeFileSync(folder+'/inventory.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
}catch{console.error('Inventory unavailable');process.exitCode=1;}
