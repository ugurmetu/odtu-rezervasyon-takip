import {readFileSync,writeFileSync,renameSync,lstatSync} from 'node:fs';
import {requestedFacilities,MAX_READER_FACILITIES,isReaderFacility,priorityFacilities,budgetFastLanes} from './reader-facilities.mjs';
import {pickerDates} from './telegram-picker.mjs';
// Runtime date data only: no extension source, permissions or credentials change.
// The installed reader already fetches this JSON with cache:no-store per tick.
export function syncPublicReaderDates({accessMode,files,store=null,now=Date.now()}){
 if(accessMode!=='public')return {changed:0,dates:[]};
 const dates=pickerDates(now);let changed=0;
 const catalog=store?.state.facilityCatalog||[];
 const targets=store?requestedFacilities({catalog,subscriptions:store.state.subscriptions,requests:store.state.readerRequests,capabilities:store.state.readerCapabilities,now}):null;
 for(const file of files){
  let raw;try{if(lstatSync(file).isSymbolicLink())throw new Error('reader_config_symlink');raw=readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')continue;throw e;}
  const config=JSON.parse(raw);
  if(config.autoManage!==true)continue;
  if(config.ingestUrl!=='http://127.0.0.1:8765/ingest'||!Array.isArray(config.watchFacilities)
    ||!config.watchFacilities.length||config.watchFacilities.length>MAX_READER_FACILITIES||config.watchFacilities.some(id=>!['17','21'].includes(id)&&!isReaderFacility(catalog.find(f=>f.id===id))))throw new Error('unexpected_reader_config');
  const watchFacilities=targets?.length?targets:config.watchFacilities;
  const all=store?.state.readerCapabilities?.catalogDiscovery===true&&store.state.readerCapabilities.maxFacilities>=200;
  const requestedPriorities=all?priorityFacilities({catalog,subscriptions:store.state.subscriptions,requests:store.state.readerRequests,now}):[];
  const priorities=all&&store.state.readerCapabilities.singleTab?budgetFastLanes({facilityIds:watchFacilities,priorityIds:requestedPriorities,subscriptions:store.state.subscriptions,requests:store.state.readerRequests}):requestedPriorities;
  const extra=all?{scanMode:store.state.readerCapabilities.singleTab?'single-tab':store.state.readerCapabilities.parallelRead?'parallel':store.state.readerScanMode||'priority',singleTab:store.state.readerCapabilities.singleTab===true,parallelRead:store.state.readerCapabilities.singleTab?false:store.state.readerCapabilities.parallelRead===true,priorityFacilities:priorities,catalogDiscovery:true,watchFacilityUnits:Object.fromEntries(catalog.filter(f=>f.unitId).map(f=>[f.id,f.unitId]))}:{};
  if(JSON.stringify(config.watchDates)===JSON.stringify(dates)&&JSON.stringify(config.watchFacilities)===JSON.stringify(watchFacilities)&&(!all||JSON.stringify(config.priorityFacilities)===JSON.stringify(priorities)&&config.scanMode===extra.scanMode&&config.catalogDiscovery===true&&config.parallelRead===extra.parallelRead&&config.singleTab===extra.singleTab&&JSON.stringify(config.watchFacilityUnits)===JSON.stringify(extra.watchFacilityUnits)))continue;
  const temporary=file+'.dates.tmp';writeFileSync(temporary,JSON.stringify({...config,...extra,watchDates:dates,watchFacilities},null,2)+'\n',{mode:0o600});renameSync(temporary,file);changed++;
 }
 return {changed,dates};
}
