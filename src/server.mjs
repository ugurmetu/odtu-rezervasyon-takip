import { createServer } from 'node:http';
import {isPublicationWait} from './publication-wait.mjs';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalStore } from './store.mjs';
import { normalizeSnapshot } from './core.mjs';
import { createCredentialStore } from './credentials.mjs';
import { TelegramApi, runTelegramLoop } from './telegram.mjs';
import { runCoverageLoop } from './coverage.mjs';
import {configureOperatorChannel} from './operator-alerts.mjs';
import {isReaderFacility} from './reader-facilities.mjs';
import {syncPublicReaderDates} from './reader-plan.mjs';
import {homedir} from 'node:os';
import {runLegacyRedirect} from './legacy-redirect.mjs';
import {attachReaderClock} from './reader-clock.mjs';
import {createMemoryGuard,normalizeMemoryRecycle} from './memory-guard.mjs';
import {createNativeVerification} from './native-verification.mjs';
import { appendHealthSample } from './health-history.mjs';
import {ownerStatsText} from './owner-stats.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY_BYTES = 64 * 1024;

export function validateBotStartup(botToken, betaInviteCode, accessMode = 'invite') {
  if (!['invite','public'].includes(accessMode)) throw new Error('invalid access mode');
  if (!botToken) return;
  if (accessMode !== 'public' && !betaInviteCode) throw new Error('Telegram beta invite code is missing');
  if (!/^\d{8,12}:[A-Za-z0-9_-]{30,70}$/.test(botToken)) {
    throw new Error('invalid Telegram bot token');
  }
}

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function validKey(received, expected) {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RangeError('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startLocalServer({ port = 8765, key, stateFile = resolve(project, '.local/state.json'), betaInviteCode = '', betaMaxChats = 6, accessMode = 'invite', publicMaxChats = 5000,
  credentialStore = createCredentialStore(), nativeVerification = createNativeVerification({privateDir:dirname(stateFile)}), extensionId = process.env.REZ_EXTENSION_ID||'mjfddbpabfknhnpmhbdkfpjpefepomjn' } = {}) {
  if (!/^[a-f0-9]{64}$/.test(key || '')) throw new Error('local key is missing or invalid');
  if(!/^[a-p]{32}$/.test(extensionId))throw new Error('invalid extension id');
  const store = new LocalStore(stateFile, { betaInviteCode, betaMaxChats, accessMode, publicMaxChats });
  // Coalesce routine reading writes (see LocalStore.saveSoon); 0 keeps every write immediate.
  store.saveThrottleMs = Number.isFinite(Number(process.env.REZ_SAVE_THROTTLE_MS)) ? Number(process.env.REZ_SAVE_THROTTLE_MS) : 5000;
  let lastReaderSaveAt = 0;
  const server = createServer(async (request, response) => {
    const address = request.headers.host;
    if (address !== `127.0.0.1:${server.address()?.port}` || !validKey(request.headers['x-local-key'], key)) {
      send(response, 403, { error: 'forbidden' });
      return;
    }
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/session/')) {
        if (request.headers['x-rez-extension'] !== extensionId || (request.headers.origin
          && request.headers.origin !== `chrome-extension://${extensionId}`)) {
          send(response,403,{error:'forbidden'});return;
        }
        if(request.method==='POST'&&url.pathname==='/session/verification-click'){
          if(request.headers.origin!==`chrome-extension://${extensionId}`){send(response,403,{error:'forbidden'});return;}
          if(!String(request.headers['content-type']||'').startsWith('application/json')){send(response,415,{error:'json_required'});return;}
          const result=await nativeVerification.click(await readJson(request),{phase:store.state.readerState?.phase});
          send(response,200,result);return;
        }
        if(request.method==='GET'&&url.pathname==='/session/verification-ready'){
          send(response,200,nativeVerification.readiness?await nativeVerification.readiness({phase:store.state.readerState?.phase}):{ready:false,retryable:false});return;
        }
        if (request.method === 'GET' && url.pathname === '/session/status') {
          send(response,200,await credentialStore.status());return;
        }
        if (request.method === 'GET' && url.pathname === '/session/credentials') {
          try {send(response,200,await credentialStore.get());}
          catch(error){send(response,409,{error:['credentials_missing','credentials_locked'].includes(error.message)?error.message:'credentials_unavailable'});}
          return;
        }
        if (request.method === 'POST' && url.pathname === '/session/credentials'
          && String(request.headers['content-type']||'').startsWith('application/json')) {
          try {const result=await credentialStore.set(await readJson(request));
            store.state.autoLoginConfigured=true;store.save();send(response,200,result);}
          catch {send(response,400,{error:'credentials_not_saved'});}return;
        }
        send(response,404,{error:'not_found'});return;
      }
      if(request.method==='POST'&&url.pathname==='/catalog/official-session-proof'){
        if(!String(request.headers['content-type']||'').startsWith('application/json')){send(response,415,{error:'json_required'});return;}
        store.refreshOfficialSessionEvidence(await readJson(request));
        send(response,200,{ok:true});return;
      }
      if(request.method==='POST'&&url.pathname==='/catalog/discover'){
        const value=await readJson(request);
        if(value?.source!=='official-facility-select')throw new Error('invalid catalog source');
        store.mergeDiscoveredCatalog(value);send(response,200,{ok:true});return;
      }
      if(request.method==='POST'&&url.pathname==='/reader-policy'){
        const value=await readJson(request);if(!['priority','round-robin','parallel'].includes(value?.mode))throw new Error('invalid scan policy');
        store.state.readerScanMode=value.mode;store.save();send(response,200,{ok:true});return;
      }
      if(request.method==='POST'&&url.pathname==='/reader-request'){
        const value=await readJson(request),id=String(value?.facilityId||'');
        if(!isReaderFacility(store.catalogFacility(id)))throw new Error('unsupported reader request');
        store.state.readerRequests||={};store.state.readerRequests[id]=Date.now();store.save();
        send(response,200,{ok:true,scheduled:store.state.readerPlan?.facilityIds.includes(id)||false});return;
      }
      if (request.method === 'POST' && url.pathname === '/reader-state') {
        const value=await readJson(request);
        const allowed=['preparing','signing_in','waiting_verification','credentials_missing','credentials_locked',
          'credentials_unavailable','login_failed','ready','reconnecting','network_wait','site_access_denied','site_rate_limited','paused'];
        if(!allowed.includes(value?.phase))throw new Error('invalid reader state');
        const at=new Date().toISOString();
        let plan;
        if(value.facilityIds!==undefined||value.dates!==undefined){
          if(!Array.isArray(value.facilityIds)||!value.facilityIds.length||value.facilityIds.length>200
            ||value.facilityIds.some(id=>!store.catalogFacility(String(id)))
            ||!Array.isArray(value.dates)||!value.dates.length||value.dates.length>7
            ||value.dates.some(date=>!/^\d{4}-\d{2}-\d{2}$/.test(date)))throw new Error('invalid reader plan');
          const priorityFacilities=Array.isArray(value.priorityFacilities)?value.priorityFacilities.map(String):[];
          if(priorityFacilities.length>200||priorityFacilities.some(id=>!value.facilityIds.includes(id)))throw new Error('invalid priority facilities');
          const facilityIds=[...new Set(value.facilityIds.map(String))];
          const same=JSON.stringify(store.state.readerPlan?.facilityIds)===JSON.stringify(facilityIds)&&JSON.stringify(store.state.readerPlan?.dates)===JSON.stringify(value.dates);
          plan={facilityIds,dates:[...new Set(value.dates)],priorityFacilities,scanMode:['priority','round-robin','parallel','single-tab'].includes(value.scanMode)?value.scanMode:'round-robin',since:same?store.state.readerPlan.since||at:at};
        }
        if(value.currentFacilityId&&!store.catalogFacility(String(value.currentFacilityId)))throw new Error('invalid current facility');
        const memoryAck=value.memoryRecycle!==undefined?normalizeMemoryRecycle(value.memoryRecycle):null;
        if(value.autoRefresh!==undefined){
          const a=value.autoRefresh,started=Date.parse(a?.at||''),resumed=Date.parse(a?.resumedAt||'');
          const reasons=['network_wait','preparing','unverified_response','timeout','content_timeout','content_unreachable','schedule_render_failed','primefaces_unavailable','schedule_widget_missing','schedule_widget_unusable','calendar_view_unavailable','no_schedule_request','refresh_failed','unexpected_page','ambiguous_request','facility_not_selected','calendar_date_mismatch'];
          if(!Number.isFinite(started)||started<=0||started>Date.now()+5000||!reasons.includes(a.reason)||!['requested','resumed'].includes(a.outcome)
            ||a.outcome==='resumed'&&(!Number.isFinite(resumed)||resumed<started||resumed>Date.now()+5000))throw Error('invalid auto refresh');
          const record={at:new Date(started).toISOString(),reason:a.reason,outcome:a.outcome,...(a.outcome==='resumed'?{resumedAt:new Date(resumed).toISOString()}:{})};
          if(JSON.stringify(record)!==JSON.stringify(store.state.readerAutoRefresh)){store.state.readerAutoRefresh=record;store.save();}
        }
        if(value.phase==='ready'&&value.readStats)store.recordReadStats(value.readStats);
        const before=JSON.stringify([store.state.readerState?.phase,store.state.readerPlan,store.state.readerCapabilities&&{...store.state.readerCapabilities,at:null}]);
        if(value.maxFacilities!==undefined){
          if(![2,16,200].includes(value.maxFacilities)||!/^\d+\.\d+\.\d+$/.test(value.version||''))throw new Error('invalid reader capabilities');
          store.state.readerCapabilities={version:value.version,maxFacilities:value.maxFacilities,catalogDiscovery:value.catalogDiscovery===true,parallelRead:value.singleTab===true?false:value.parallelRead===true,singleTab:value.singleTab===true,memoryGuard:value.memoryGuard===true,at};
        }else store.state.readerCapabilities={version:'legacy',maxFacilities:2,at};
        if(memoryAck){store.state.readerMemoryRecycle=memoryAck;store.save();}
        if(value.currentFacilityId){
          const id=String(value.currentFacilityId);if(!store.catalogFacility(id))throw new Error('invalid current facility');
          store.state.readerFacilityStates||={};const old=store.state.readerFacilityStates[id];store.state.readerFacilityStates[id]={phase:value.phase,at,since:old?.phase===value.phase?old.since:at};
        }
        store.state.readerState={phase:value.phase,at,since:store.state.readerState?.phase===value.phase?store.state.readerState.since:at};
        if(plan){
          store.state.readerScopeStartedAt||={};
          const scopes=new Set(plan.facilityIds.flatMap(id=>plan.dates.map(date=>`${id}|${date}`)));
          for(const scope of scopes)store.state.readerScopeStartedAt[scope]||=at;
          for(const scope of Object.keys(store.state.readerScopeStartedAt))if(!scopes.has(scope))delete store.state.readerScopeStartedAt[scope];
          store.state.readerPlan=plan;
        }
        // The reader reports a phase about once per second. Persist only real
        // changes, plus a periodic copy of the timestamps.
        const after=JSON.stringify([store.state.readerState?.phase,store.state.readerPlan,store.state.readerCapabilities&&{...store.state.readerCapabilities,at:null}]);
        if(before!==after||Date.now()-lastReaderSaveAt>=30000){lastReaderSaveAt=Date.now();store.save();}
        send(response,200,{ok:true});return;
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        send(response, 200, { ok: true, ...store.status(),readerClock:readerClock.status() });
        return;
      }
      if (request.method !== 'POST' || !['/ingest', '/catalog'].includes(url.pathname)) {
        send(response, 404, { error: 'not_found' });
        return;
      }
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
        send(response, 415, { error: 'json_required' });
        return;
      }
      const payload = await readJson(request);
      if (url.pathname === '/catalog') {
        store.setFacilityCatalog(payload?.facilities);
        send(response, 200, { ok: true, facilities: store.availableFacilities().length });
      } else {
        const snapshots = payload?.snapshots ?? [payload];
        if (!Array.isArray(snapshots) || snapshots.length < 1 || snapshots.length > 7) throw new Error('invalid batch');
        // Validate the entire week before changing any comparison history.
        const normalized = snapshots.map(snapshot => normalizeSnapshot(snapshot));
        if (payload?.snapshots && (normalized.some(item => item.state !== 'ok' || !item.fresh
          || item.facility.id !== normalized[0].facility.id)
          || new Set(normalized.map(item => item.date)).size !== normalized.length)) throw new Error('invalid week');
        let changes = 0;
        for (const snapshot of snapshots) changes += store.ingest(snapshot).length;
        send(response, 200, { ok: true, changes,
          ...(isPublicationWait({state:store.state,engine:store.engine})?{waitingPublication:true}:{}) });
      }
    } catch (error) {
      if (response.destroyed || response.headersSent) {
        response.destroy();
        return;
      }
      send(response, error instanceof RangeError ? 413 : 400, { error: 'invalid_snapshot' });
    }
  });
  const readerClock=attachReaderClock(server,{key,extensionId});
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return {
    store,
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {readerClock.close();return new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));}
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // An unpacked extension's ID depends on its folder; the Mac default is wrong elsewhere.
  if (process.platform !== 'darwin' && !process.env.REZ_EXTENSION_ID) throw new Error('REZ_EXTENSION_ID is required outside this Mac');
  const key = readFileSync(resolve(project, '.local/ingest.key'), 'utf8').trim();
  let betaInviteCode = process.env.REZ_BETA_INVITE_CODE?.trim() || '';
  if (!betaInviteCode) {
    try {
      betaInviteCode = readFileSync(resolve(project, '.local/beta-invite-code'), 'utf8').trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  let accessMode = process.env.REZ_ACCESS_MODE?.trim();
  if (!accessMode) {
    try { accessMode = readFileSync(resolve(project, '.local/access-mode'), 'utf8').trim(); }
    catch(error) { if(error.code !== 'ENOENT') throw error; }
  }
  accessMode ||= 'invite';
  const publicMaxChats = Number(process.env.REZ_PUBLIC_MAX_CHATS || 5000);
  const betaMaxChats = process.env.REZ_BETA_MAX_CHATS ? Number(process.env.REZ_BETA_MAX_CHATS) : 6;
  let botToken = process.env.REZ_BOT_TOKEN?.trim() || '';
  if (!botToken) {
    try {
      botToken = readFileSync(resolve(project, '.local/telegram-token'), 'utf8').trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  let ownerChatId = process.env.REZ_OWNER_CHAT_ID?.trim() || '';
  if (!ownerChatId) {
    try {
      ownerChatId = readFileSync(resolve(project, '.local/owner-chat-id'), 'utf8').trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  // The local listener can run without Telegram for demos, but a configured
  // bot must never fall back to accepting every private chat when its invite
  // file or environment variable is missing.
  validateBotStartup(botToken, betaInviteCode, accessMode);
  const controller = new AbortController();
  const local = await startLocalServer({ key, betaInviteCode, betaMaxChats, accessMode, publicMaxChats });
  // The unpacked extension reads its plan from local-config.json in the folder
  // Chrome loaded. On another machine set REZ_READER_CONFIG_FILES (":"-separated).
  const readerConfigFiles=process.env.REZ_READER_CONFIG_FILES?.split(':').map(item=>item.trim()).filter(Boolean)
    ||[resolve(project,'extension/local-config.json'),resolve(homedir(),'Desktop/REZ-PILOT-EKLENTI/local-config.json')];
  let missingConfigWarned=false;
  const refreshReaderDates=()=>{
    try{
      local.store.pruneEndedSelections();
      syncPublicReaderDates({accessMode,store:local.store,files:readerConfigFiles});
      const present=readerConfigFiles.some(file=>{try{return statSync(file).isFile();}catch{return false;}});
      if(!present&&!missingConfigWarned){missingConfigWarned=true;console.error('Okuyucu yapılandırma dosyası bulunamadı; tarih planı uzantıya ulaşmaz. REZ_READER_CONFIG_FILES ayarını kontrol et.');}
      if(present)missingConfigWarned=false;
    }
    catch(error){console.error('Okuyucu tarih planı güncellenemedi: '+(error.code||'configuration'));}
  };
  let memoryTimer;
  if(process.platform==='linux'&&process.env.REZ_BROWSER_MEMORY_GUARD==='1'){
    const memoryGuard=createMemoryGuard({store:local.store,configFiles:readerConfigFiles,stateFile:resolve(project,'.local/memory-guard.json'),historyFile:resolve(project,'.local/memory-history.ndjson'),interventionDir:resolve(project,'.local')});
    const sample=()=>{try{memoryGuard.tick();}catch{console.error('REZ_MEMORY_GUARD sample_unavailable');}};
    sample();memoryTimer=setInterval(sample,60000);memoryTimer.unref();
  }
  refreshReaderDates();
  const readerDateTimer=setInterval(refreshReaderDates,10000);readerDateTimer.unref();
  console.log(`Yerel rezervasyon dinleyicisi: ${local.url}`);
  console.log(accessMode === 'public' ? 'Telegram herkese açık katılım etkin.' : 'Telegram kapalı beta davet kapısı etkin.');
  let legacyRun=null,telegramRun=null,coverageRun=null,legacyToken='';
  try{legacyToken=readFileSync(resolve(project,'.local/telegram-legacy-token'),'utf8').trim();}
  catch(error){if(error.code!=='ENOENT')throw error;}
  let operatorToken=process.env.REZ_OPERATOR_BOT_TOKEN?.trim()||'';
  if(!operatorToken&&process.env.REZ_OPERATOR_BOT_TOKEN_FILE){
    try{operatorToken=readFileSync(process.env.REZ_OPERATOR_BOT_TOKEN_FILE,'utf8').trim();}
    catch{console.error('Yönetici botu anahtarı okunamadı; ortak bota teknik uyarı gönderilmez.');}
  }
  let operatorChannel=null;
  if(botToken){
    const api=new TelegramApi(botToken);
    local.store.setTelegramConfigured(true);
    telegramRun=runTelegramLoop(local.store,api,controller.signal);
    console.log('Kullanıcı botu etkin; teknik uyarılar bu kanala gönderilmez.');
    const route=await configureOperatorChannel({publicToken:botToken,operatorToken,ownerChatId,apiFactory:token=>new TelegramApi(token)});
    operatorChannel=route.channel;
    local.store.state.operatorAlerts={...local.store.state.operatorAlerts,configured:!!operatorToken,ready:!!operatorChannel,reason:route.reason,checkedAt:new Date().toISOString()};local.store.save();
    if(operatorChannel){coverageRun=runCoverageLoop(local.store,operatorChannel,ownerChatId,controller.signal);console.log('Ayrı özel yönetici bildirim kanalı etkin.');}
    else console.log('Ayrı yönetici kanalı hazır değil; teknik uyarılar yalnız kayıtlarda.');
  }else console.log('Telegram bağlı değil; bildirimler yalnız yerel kuyruğa yazılır.');
  if(botToken&&legacyToken&&legacyToken!==botToken){
    legacyRun=runLegacyRedirect(new TelegramApi(legacyToken),resolve(project,'.local/legacy-redirect.json'),controller.signal,
      operatorChannel&&operatorToken===legacyToken?{operatorOwnerId:ownerChatId,ownerStats:()=>ownerStatsText(local.store.state,{limit:local.store.publicMaxChats})}:{});
  }
  const historyFile = resolve(project, '.local/health-history.ndjson');
  const recordHealth = () => {
    try {
      appendHealthSample(historyFile, local.store.status());
    } catch (error) {
      console.error(`${new Date().toISOString()} Yerel sağlık geçmişi yazılamadı: ${error.code || 'unknown'}`);
    }
  };
  recordHealth();
  const healthTimer = setInterval(recordHealth, 5 * 60_000);
  healthTimer.unref();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, async () => {
    controller.abort();
    clearInterval(healthTimer);
    clearInterval(memoryTimer);
    clearInterval(readerDateTimer);
    await local.close();
    local.store.flushSave();
    await telegramRun;
    await coverageRun;
    await legacyRun;
    process.exit(0);
  });
}
