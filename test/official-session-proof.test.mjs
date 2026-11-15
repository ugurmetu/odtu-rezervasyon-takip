import test from'node:test';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';
test('official refresh performs only bounded form selection and rejects fabricated or wrong-scope sessions',()=>{
 const script=String.raw`import sys,types,runpy,datetime,tempfile,pathlib,json
sys.modules['requests']=types.SimpleNamespace()
m=runpy.run_path(sys.argv[1],run_name='proof_test')
m['run'].__globals__['NOW']=datetime.datetime.fromisoformat('2026-11-03T01:10:00+00:00')
m['official'].__globals__['time'].sleep=lambda _:None
URL=m['URL'];FORM=m['FORM']
class Fake:
 def __init__(self,ending='09.30',wrong=False,empty=False):self.calls=[];self.fid='';self.date='';self.ending=ending;self.wrong=wrong;self.empty=empty
 def request(self,method,url,**kw):
  self.calls.append((method,kw.get('data',{})));data=kw.get('data',{})
  assert url==URL and kw.get('allow_redirects')is False
  assert not any('saveButton'in k or 'reservationSession'in k for k in data)
  if method=='POST':
   source=data['javax.faces.source'];assert source in [FORM+':department',FORM+':facility',FORM+':reservationDay']
   if source.endswith(':facility'):self.fid=data[source+'_input']
   if source.endswith(':reservationDay'):self.date=data[source+'_input']
  fid='48'if self.wrong else self.fid
  html='<form id="'+FORM+'"><input name="javax.faces.ViewState" value="test-state"><select name="'+FORM+':department_input"><option value="1">Spor</option></select><select name="'+FORM+':facility_input"><option value="17"'+(' selected="selected"'if fid=='17'else '')+'>Fitness</option></select><input name="'+FORM+':reservationDay_input" value="'+self.date+'"><select name="'+FORM+':reservationSession_input"><option value=""></option>'
  if self.date and not self.empty:html+='<option value="synthetic-session">Seans '+self.date+' / 08.00 - '+self.ending+'</option>'
  html+='</select></form>'
  text=html if method=='GET'else '<partial-response><changes><update id="'+FORM+'"><![CDATA['+html+']]></update><update id="javax.faces.ViewState"><![CDATA[test-state]]></update></changes></partial-response>'
  return types.SimpleNamespace(status_code=200,url=URL,text=text)
f=Fake();assert m['official'](f,'17','2026-11-04')==[{'start':'08:00','end':'09:30'}];assert len(f.calls)==4
for f in [Fake(ending='08.00'),Fake(wrong=True)]:
 try:m['official'](f,'17','2026-11-04')
 except (ValueError,KeyError):pass
 else:raise AssertionError('invalid evidence accepted')
try:m['official'](Fake(empty=True),'17','2026-11-04')
except ValueError as error:assert m['failure_reason'](error)=='no_visible_sessions'
else:raise AssertionError('empty form invented evidence')
state={'readerDiagnostics':{'17':{'events':[{'start':'2026-11-04T08:00:00+0300','end':'2026-10-28T09:30:00+0300'},{'start':'2026-11-04T20:00:00+0300','end':'2026-11-04T20:00:00+0300'}]}}}
assert m['required_sessions'](state,'17','2026-11-04')=={('08:00','09:30')}
assert m['required_sessions'](state,'48','2026-11-04')==set()
with tempfile.TemporaryDirectory()as d:
 p=pathlib.Path(d);now=m['run'].__globals__['NOW'];old=(now-datetime.timedelta(hours=2)).isoformat()
 s={'readerPlan':{'facilityIds':['17'],'dates':['2026-11-04']},'officialSessionEvidence':{'17|2026-11-04':{'source':'official-booking-form','verifiedAt':old}},**state}
 (p/'state.json').write_text(json.dumps(s));g=m['run'].__globals__;g['PRIVATE']=p
 calls=[];g['subprocess']=types.SimpleNamespace(run=lambda args,**kw:(calls.append(args)or types.SimpleNamespace(returncode=0)))
 g['cookie_session']=lambda:(_ for _ in ()).throw(ValueError('unavailable'))
 result=m['run']();assert not result['ok']and result['state']=='unverified';assert json.loads((p/'state.json').read_text())==s
 assert any('unlock'in x for x in calls)
 result=m['run']();assert result['state']=='rate_limited'
print('proof_collector_checks_passed')
`;
 const out=execFileSync('python3',['-c',script,fileURLToPath(new URL('../ops/vps/official-session-proof.py',import.meta.url))],{encoding:'utf8',timeout:10000});assert.match(out,/proof_collector_checks_passed/);
});

test('expired proof with a newer fresh successful day needs no renewal; evidence and the remaining daily attempt stay intact',()=>{
 const script=String.raw`import sys,types,runpy,datetime,tempfile,pathlib,json,copy
sys.modules['requests']=types.SimpleNamespace()
m=runpy.run_path(sys.argv[1],run_name='proof_test');g=m['run'].__globals__
now=datetime.datetime.fromisoformat('2026-11-03T01:10:00+00:00');g['NOW']=now
stamp=lambda seconds:(now+datetime.timedelta(seconds=seconds)).isoformat()
scope='17|2026-11-04'
state={'readerPlan':{'facilityIds':['17'],'dates':['2026-11-04']},'readerState':{'phase':'ready'},
 'officialSessionEvidence':{scope:{'source':'official-booking-form','verifiedAt':stamp(-25*3600),'sessions':[{'start':'08:00','end':'09:30'}]}},
 'readerDiagnostics':{'17':{'at':stamp(-30*3600),'events':[{'start':'2026-11-04T08:00:00+0300','end':'2026-10-28T09:30:00+0300'}]}},
 'engine':{'pages':{scope:{'facility':{'id':'17'},'date':'2026-11-04','lastSuccessAt':stamp(-5),'observedSlotKeys':[]}}}}
def forbidden(*args,**kw):raise AssertionError('unexpected lock, request or session access')
g['cookie_session']=forbidden;g['subprocess']=types.SimpleNamespace(run=forbidden)
with tempfile.TemporaryDirectory()as directory:
 p=pathlib.Path(directory);g['PRIVATE']=p
 receipt={'day':'2026-11-03','attempts':1,'lastAttemptAt':now.timestamp()-600,'state':'unverified','refreshed':0}
 (p/'state.json').write_text(json.dumps(state));(p/'official-session-refresh.json').write_text(json.dumps(receipt))
 before=(p/'state.json').read_bytes(),(p/'official-session-refresh.json').read_bytes()
 for force in [False,True]:
  result=m['run'](force);assert result['ok']and result['state']=='not_required'and result['refreshed']==0
 assert not m['due']()['due']
 assert before==((p/'state.json').read_bytes(),(p/'official-session-refresh.json').read_bytes())
 result=m['status']();assert result['lastRefresh']['state']=='unverified'
 assert result['assessment']['state']=='currently_not_required'and not result['assessment']['expiredRequired']
 assert result['proofs'][0]['ageSeconds']>86400
# A valid proof is still proactively renewed; fresh successful reads cannot
# silently disable the existing 24h refresh while that proof could be in use.
current=copy.deepcopy(state);current['officialSessionEvidence'][scope]['verifiedAt']=stamp(-2*3600)
assert len(m['renewal_scopes'](current)[0])==1
# A future/old/mis-scoped read, new rejection or failed reader is not evidence
# that the historical failure has become irrelevant.
for change in ['stale','before-expiry','future','new-rejection','wrong-facility','wrong-date','not-ready','missing-diagnostic']:
 s=copy.deepcopy(state);page=s['engine']['pages'][scope]
 if change=='stale':page['lastSuccessAt']=stamp(-181)
 if change=='before-expiry':page['lastSuccessAt']=stamp(-25*3600)
 if change=='future':page['lastSuccessAt']=stamp(1)
 if change=='new-rejection':s['readerDiagnostics']['17']['at']=stamp(-1)
 if change=='wrong-facility':page['facility']['id']='21'
 if change=='wrong-date':page['date']='2026-11-05'
 if change=='not-ready':s['readerState']['phase']='waiting_verification'
 if change=='missing-diagnostic':s['readerDiagnostics']['17'].pop('at')
 assert len(m['renewal_scopes'](s)[0])==1,change
assert m['instant']('2026-11-03T01:10:00')is None
print('superseded_proof_checks_passed')`;
 const out=execFileSync('python3',['-c',script,fileURLToPath(new URL('../ops/vps/official-session-proof.py',import.meta.url))],{encoding:'utf8',timeout:10000});assert.match(out,/superseded_proof_checks_passed/);
});

test('proof failure reasons are bounded and new active rejections still fail without rewriting evidence',()=>{
 const script=String.raw`import sys,types,runpy,datetime,tempfile,pathlib,json
sys.modules['requests']=types.SimpleNamespace()
m=runpy.run_path(sys.argv[1],run_name='proof_test');g=m['run'].__globals__
now=datetime.datetime.fromisoformat('2026-11-03T01:10:00+00:00');g['NOW']=now
state={'readerPlan':{'facilityIds':['17'],'dates':['2026-11-04']},'officialSessionEvidence':{'17|2026-11-04':{'source':'official-booking-form','verifiedAt':(now-datetime.timedelta(hours=25)).isoformat()}},
 'readerState':{'phase':'ready'},'readerDiagnostics':{'17':{'at':now.isoformat(),'events':[{'start':'2026-11-04T08:00:00+0300','end':'2026-10-28T09:30:00+0300'}]}}}
with tempfile.TemporaryDirectory()as directory:
 p=pathlib.Path(directory);g['PRIVATE']=p;(p/'state.json').write_text(json.dumps(state));(p/'ingest.key').write_text('test-only-local-key')
 calls=[];g['subprocess']=types.SimpleNamespace(run=lambda args,**kw:(calls.append(args)or types.SimpleNamespace(returncode=0)))
 g['cookie_session']=lambda:object();g['official']=lambda *args:[{'start':'10:00','end':'11:30'}]
 r=m['run']();assert not r['ok']and r['reason']=='required_session_not_visible'
 assert json.loads((p/'state.json').read_text())==state
 assert json.loads((p/'official-session-refresh.json').read_text())['attempts']==1
 assert m['status']()['assessment']['expiredRequired']
 assert m['due']()['due']
 assert any('unlock'in c for c in calls)
 assert m['run']()['state']=='rate_limited'
assert m['failure_reason'](ValueError('https://secret.invalid/session-value'))=='unverified_request'
assert m['failure_reason'](ValueError('no visible sessions'))=='no_visible_sessions'
assert m['failure_reason'](ValueError('session unavailable'))=='session_unavailable'
print('failure_reason_checks_passed')`;
 const out=execFileSync('python3',['-c',script,fileURLToPath(new URL('../ops/vps/official-session-proof.py',import.meta.url))],{encoding:'utf8',timeout:10000});assert.match(out,/failure_reason_checks_passed/);
});

test('systemd condition exits 1 only for a normal skip, 0 for due work and 255 for unreadable state',()=>{
 const script=String.raw`import sys,subprocess,pathlib,tempfile,json
source=pathlib.Path(sys.argv[1]).read_text()
with tempfile.TemporaryDirectory()as directory:
 p=pathlib.Path(directory)
 code="import types,sys\nsys.modules['requests']=types.SimpleNamespace()\n"+source.replace("PRIVATE=pathlib.Path('/var/lib/odtu-rez/private')",'PRIVATE=pathlib.Path('+repr(directory)+')').replace('NOW=datetime.datetime.now(datetime.timezone.utc)',"NOW=datetime.datetime.fromisoformat('2026-11-03T01:10:00+00:00')")
 def check(status,state):
  if state is not None:(p/'state.json').write_text(json.dumps(state))
  r=subprocess.run([sys.executable,'-c',code,'--due'],capture_output=True,text=True,timeout=5)
  assert r.returncode==status,(r.returncode,r.stdout,r.stderr)
  return json.loads(r.stdout)
 assert not check(255,None)['ok']
 assert not check(1,{'readerPlan':{}})['due']
 state={'readerPlan':{'facilityIds':['17'],'dates':['2026-11-04']},'officialSessionEvidence':{'17|2026-11-04':{'source':'official-booking-form','verifiedAt':'2026-11-02T01:00:00Z'}},'readerDiagnostics':{'17':{'at':'2026-11-03T01:09:00Z','events':[{'start':'2026-11-04T08:00:00+0300','end':'2026-10-28T09:30:00+0300'}]}}}
 assert check(0,state)['due']
 assert not(p/'official-session-refresh.json').exists()
print('systemd_condition_checks_passed')`;
 const out=execFileSync('python3',['-c',script,fileURLToPath(new URL('../ops/vps/official-session-proof.py',import.meta.url))],{encoding:'utf8',timeout:10000});assert.match(out,/systemd_condition_checks_passed/);
});

