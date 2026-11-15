/* global chrome */
(function(root){
'use strict';
function select(config,state={}){
 const ids=config.watchFacilities||[],priority=(config.priorityFacilities||[]).filter(id=>ids.includes(id));
 const background=ids.filter(id=>!priority.includes(id));
 if(config.scanMode==='priority'&&priority.length&&background.length){
  const turn=Number(state.scanTurn||0),slow=turn%4===3;
  const cursor=Number(slow?state.backgroundCursor||0:state.priorityCursor||0),list=slow?background:priority;
  return {facilityId:list[cursor%list.length],advance:{scanTurn:turn+1,[slow?'backgroundCursor':'priorityCursor']:cursor+1}};
 }
 const cursor=Number(state.watchCursor||0);return {facilityId:ids[cursor%ids.length],advance:{watchCursor:(cursor+1)%ids.length}};
}
root.RezScheduler={select};
})(typeof globalThis==='undefined'?self:globalThis);
