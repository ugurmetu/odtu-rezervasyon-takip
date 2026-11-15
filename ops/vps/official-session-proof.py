"""Revalidate existing dated parser proofs through the normal official form.
No session selection or save action exists here. Credentials remain in memory.
"""
import sys,json,pathlib,datetime,time,subprocess,sqlite3,hashlib,re,os
from html.parser import HTMLParser
from zoneinfo import ZoneInfo
import xml.etree.ElementTree as ET
import requests
PRIVATE=pathlib.Path('/var/lib/odtu-rez/private')
URL='https://rez.metu.edu.tr/view/reservationControl/reservation/createReservation.jsf'
FORM='formCreateReservation'
NOW=datetime.datetime.now(datetime.timezone.utc)
def instant(v):
 try:
  result=datetime.datetime.fromisoformat(v.replace('Z','+00:00'))
  return result if result.tzinfo is not None else None
 except (ValueError,TypeError,AttributeError):return None
def atomic(p,v):
 t=p.with_suffix('.tmp');t.write_text(json.dumps(v,separators=(',',':'))+'\n');t.chmod(0o600);os.replace(t,p)
class Form(HTMLParser):
 def __init__(self):super().__init__();self.active=False;self.inputs={};self.selects={};self.selected={};self.current=None;self.option=None
 def handle_starttag(self,t,attrs):
  a=dict(attrs)
  if t=='form':self.active=a.get('id')==FORM
  if not self.active:return
  if t=='input' and a.get('name') and a.get('type') not in ['submit','button']:self.inputs[a['name']]=a.get('value','')
  if t=='select':self.current=a.get('name');self.selects[self.current]=[]
  if t=='option' and self.current:self.option={'value':a.get('value',''),'label':'','selected':'selected'in a}
 def handle_data(self,v):
  if self.option is not None:self.option['label']+=v
 def handle_endtag(self,t):
  if t=='form':self.active=False
  if t=='select':self.current=None
  if t=='option' and self.option is not None:
   self.selects[self.current].append(self.option)
   if self.option['selected']:self.selected[self.current]=self.option['value']
   self.option=None
def parse(text):
 f=Form();f.feed(text);return f
def required_sessions(state,fid,date):
 required=set()
 for e in state.get('readerDiagnostics',{}).get(fid,{}).get('events',[]):
  start,end=instant(e.get('start')),instant(e.get('end'))
  if not start or not end:continue
  start,end=start.astimezone(ZoneInfo('Europe/Istanbul')),end.astimezone(ZoneInfo('Europe/Istanbul'))
  if start.date().isoformat()==date and (start.date()-end.date()).days==7 and start.time()<end.time():
   required.add((start.strftime('%H:%M'),end.strftime('%H:%M')))
 return required
def scope_assessment(state,fid,date,proof,now=NOW):
 """A newer verified read after proof expiry supersedes an old failure only.
 It does not renew evidence or claim the malformed event was repaired.
 A new rejection, stale/future timestamp or unavailable reader keeps renewal due.
 """
 verified=instant(proof.get('verifiedAt'))
 diagnostic=instant(state.get('readerDiagnostics',{}).get(fid,{}).get('at'))
 page=state.get('engine',{}).get('pages',{}).get(fid+'|'+date,{})
 success=instant(page.get('lastSuccessAt'))
 expired=bool(verified and (now-verified).total_seconds()>=86400)
 superseded=bool(expired and diagnostic and success and state.get('readerState',{}).get('phase')=='ready'
  and page.get('date')==date and str(page.get('facility',{}).get('id'))==fid
  and 0<=(now-success).total_seconds()<=180 and success>diagnostic
  and success>=verified+datetime.timedelta(hours=24))
 return {'scope':fid+'|'+date,'state':'currently_not_required'if superseded else'renewal_required',
  'proofExpired':expired,'latestSuccessAt':page.get('lastSuccessAt'),
  'diagnosticAt':state.get('readerDiagnostics',{}).get(fid,{}).get('at')}
def renewal_scopes(state,force=False):
 plan=state.get('readerPlan',{});today=NOW.astimezone(ZoneInfo('Europe/Istanbul')).date().isoformat()
 due=[];assessments=[]
 for key,proof in state.get('officialSessionEvidence',{}).items():
  parts=key.split('|')
  if len(parts)!=2:continue
  fid,date=parts;at=instant(proof.get('verifiedAt'))
  if proof.get('source')!='official-booking-form'or fid not in plan.get('facilityIds',[])or date not in plan.get('dates',[])or date<today:continue
  required=required_sessions(state,fid,date)
  if not required or not at:continue
  assessment=scope_assessment(state,fid,date,proof,now=NOW);assessments.append(assessment)
  if assessment['state']!='currently_not_required'and(force or(NOW-at).total_seconds()>=3600):due.append((fid,date,required))
 return due,assessments
def failure_reason(error):
 # A fixed vocabulary only: exception text may contain URLs or session data.
 reasons={'session unavailable':'session_unavailable','unsupported session storage':'unsupported_session_storage',
  'form unavailable':'form_unavailable','department unavailable':'department_unavailable',
  'facility unavailable':'facility_unavailable','wrong selected facility':'wrong_selected_facility',
  'wrong selected scope':'wrong_selected_scope','invalid official session label':'invalid_official_session_label',
  'invalid official session range':'invalid_official_session_range','invalid official sessions':'invalid_official_sessions',
  'no visible sessions':'no_visible_sessions','required session not currently visible':'required_session_not_visible',
  'local refresh rejected':'local_refresh_rejected'}
 return reasons.get(str(error),'unverified_request')
def due():
 # systemd ExecCondition: exit 1 skips a no-longer-needed job without making
 # a request, consuming an attempt or rewriting the previous failure receipt.
 scopes,assessments=renewal_scopes(json.loads((PRIVATE/'state.json').read_text()))
 return {'ok':True,'state':'due'if scopes else'not_required','due':bool(scopes),'assessment':assessments}
def cookie_session():
 p=PRIVATE.parent/'chrome-profile/Default/Cookies'
 if not p.exists():p=PRIVATE.parent/'chrome-profile/Default/Network/Cookies'
 c=sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True)
 row=c.execute("SELECT host_key,name,value,encrypted_value FROM cookies WHERE name='JSESSIONID' AND host_key='rez.metu.edu.tr'").fetchone();c.close()
 if not row:raise ValueError('session unavailable')
 host,name,value,encrypted=row
 if not value:
  if encrypted[:3]!=b'v10':raise ValueError('unsupported session storage')
  key=hashlib.pbkdf2_hmac('sha1',b'peanuts',b'saltysalt',1,16)
  p=subprocess.run(['openssl','enc','-aes-128-cbc','-d','-K',key.hex(),'-iv',(b' '*16).hex()],input=encrypted[3:],capture_output=True)
  if p.returncode:raise ValueError('session unavailable')
  value=p.stdout
  if value.startswith(hashlib.sha256(host.encode()).digest()):value=value[32:]
  value=value.decode()
 s=requests.Session();s.cookies.set(name,value,domain=host,path='/');return s
def official(s,fid,date):
 def request(method,**kw):
  r=s.request(method,URL,allow_redirects=False,timeout=15,**kw)
  if r.status_code!=200 or r.url!=URL:raise ValueError('form unavailable')
  return r
 f=parse(request('GET').text)
 def change(field,value,event='valueChange'):
  nonlocal f
  if field not in ['department','facility','reservationDay']:raise ValueError('forbidden form action')
  source=FORM+':'+field
  data={FORM:FORM,'javax.faces.ViewState':f.inputs['javax.faces.ViewState'],
   'javax.faces.partial.ajax':'true','javax.faces.source':source,'javax.faces.partial.execute':source,
   'javax.faces.partial.render':FORM,'javax.faces.behavior.event':event,'javax.faces.partial.event':'change',source+'_input':value}
  xml=ET.fromstring(request('POST',data=data,headers={'Faces-Request':'partial/ajax'}).text)
  updates=xml.findall('.//update');html=next(x.text for x in updates if x.get('id')==FORM)
  f=parse(html);view=next((x.text for x in updates if 'ViewState'in x.get('id','')),None)
  if view:f.inputs['javax.faces.ViewState']=view
  time.sleep(.6)
 if not any(o['value']=='1' for o in f.selects.get(FORM+':department_input',[])):raise ValueError('department unavailable')
 change('department','1')
 if not any(o['value']==fid for o in f.selects.get(FORM+':facility_input',[])):raise ValueError('facility unavailable')
 change('facility',fid)
 if f.selected.get(FORM+':facility_input')!=fid:raise ValueError('wrong selected facility')
 label=datetime.date.fromisoformat(date).strftime('%d.%m.%Y')
 change('reservationDay',label,'dateSelect')
 if f.selected.get(FORM+':facility_input')!=fid or f.inputs.get(FORM+':reservationDay_input')!=label:raise ValueError('wrong selected scope')
 if FORM+':reservationSession_input'not in f.selects:raise ValueError('invalid official sessions')
 options=f.selects[FORM+':reservationSession_input']
 sessions=[]
 for o in options:
  if not o['value']:continue
  m=re.fullmatch(r'Seans '+re.escape(label)+r' / (\d\d)\.(\d\d) - (\d\d)\.(\d\d)',o['label'].strip())
  if not m:raise ValueError('invalid official session label')
  start,end=m[1]+':'+m[2],m[3]+':'+m[4]
  if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d',start)or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d',end)or start>=end:raise ValueError('invalid official session range')
  sessions.append({'start':start,'end':end})
 if not sessions:raise ValueError('no visible sessions')
 if len(sessions)>100 or len({(x['start'],x['end'])for x in sessions})!=len(sessions):raise ValueError('invalid official sessions')
 return sessions
def run(force=False):
 state=json.loads((PRIVATE/'state.json').read_text());today=NOW.astimezone(ZoneInfo('Europe/Istanbul')).date().isoformat()
 scopes,assessments=renewal_scopes(state,force)
 if not scopes:return {'ok':True,'state':'not_required'if any(a['state']=='currently_not_required'for a in assessments)else'not_due','refreshed':0,'assessment':assessments}
 if len(scopes)>4:return {'ok':False,'state':'scope_limit','refreshed':0}
 node='/opt/odtu-rez/runtime/node/bin/node';wd='/opt/odtu-rez/watchdog/watchdog.mjs';owner='codex-official-proof'
 lock=subprocess.run([node,wd,'lock',owner,'3','bounded official proof refresh'],capture_output=True)
 if lock.returncode:return {'ok':False,'state':'intervention_busy','refreshed':0}
 refreshed=0
 try:
  receipt=PRIVATE/'official-session-refresh.json'
  prior=json.loads(receipt.read_text())if receipt.exists()else {}
  now=time.time();day=today;attempts=prior.get('attempts',0)if prior.get('day')==day else 0
  if now-prior.get('lastAttemptAt',0)<900 or attempts>=2:return {'ok':True,'state':'rate_limited','refreshed':0}
  atomic(receipt,{'lastAttemptAt':now,'day':day,'attempts':attempts+1,'state':'started'})
  s=cookie_session();key=(PRIVATE/'ingest.key').read_text().strip()
  for fid,date,required in scopes:
   sessions=official(s,fid,date)
   if not required.issubset({(x['start'],x['end'])for x in sessions}):raise ValueError('required session not currently visible')
   verified=datetime.datetime.now(datetime.timezone.utc).isoformat()
   payload={'facilityId':fid,'date':date,'source':'official-booking-form','verifiedAt':verified,'sessions':sessions}
   r=requests.post('http://127.0.0.1:8765/catalog/official-session-proof',json=payload,headers={'X-Local-Key':key},timeout=5,allow_redirects=False)
   if r.status_code!=200 or not r.json().get('ok'):raise ValueError('local refresh rejected')
   refreshed+=1
  atomic(receipt,{'lastAttemptAt':now,'day':day,'attempts':attempts+1,'state':'refreshed','refreshed':refreshed,'verifiedAt':verified})
  return {'ok':True,'state':'refreshed','refreshed':refreshed,'verifiedAt':verified}
 except Exception as error:
  reason=failure_reason(error)
  atomic(receipt,{'lastAttemptAt':time.time(),'day':today,'attempts':attempts+1,'state':'unverified','refreshed':refreshed,'reason':reason})
  return {'ok':False,'state':'unverified','refreshed':refreshed,'reason':reason}
 finally:subprocess.run([node,wd,'unlock',owner],capture_output=True)
def status():
 state=json.loads((PRIVATE/'state.json').read_text());now=NOW
 proofs=[{'scope':k,'verifiedAt':v.get('verifiedAt'),'ageSeconds':(now-instant(v.get('verifiedAt'))).total_seconds()}for k,v in state.get('officialSessionEvidence',{}).items()if instant(v.get('verifiedAt')) and k.split('|')[-1]in state.get('readerPlan',{}).get('dates',[])]
 receipt=PRIVATE/'official-session-refresh.json';record=json.loads(receipt.read_text())if receipt.exists()else {}
 _,assessments=renewal_scopes(state)
 expiredRequired=any(a['proofExpired']and a['state']=='renewal_required'for a in assessments)
 return {'ok':True,'state':'status','proofs':proofs,'lastRefresh':{k:record.get(k)for k in ['lastAttemptAt','state','refreshed','verifiedAt','day','attempts','reason']},
  'assessment':{'state':'renewal_required'if expiredRequired else'currently_not_required'if assessments and all(a['state']=='currently_not_required'for a in assessments)else'monitor',
   'expiredRequired':expiredRequired,'scopes':assessments}}
if __name__=='__main__':
 try:result=due()if '--due'in sys.argv else status()if '--status'in sys.argv else run('--refresh-now'in sys.argv)
 except Exception:result={'ok':False,'state':'unavailable','refreshed':0}
 print(json.dumps(result))
 sys.exit((0 if result.get('due')else 1)if '--due'in sys.argv and result.get('ok')else 255 if '--due'in sys.argv else 0 if result.get('ok')else 1)

