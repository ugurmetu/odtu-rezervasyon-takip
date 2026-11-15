import {timingSafeEqual} from 'node:crypto';
import {WebSocketServer,WebSocket} from 'ws';

// A loopback-only, authenticated clock. It sends no site requests or secrets.
// Chrome 116+ keeps an extension worker alive when WebSocket messages arrive
// within its 30-second idle window. The normal alarm remains a fallback.
export function attachReaderClock(server,{key,extensionId,tickMs=10_000}={}){
 const wss=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false,
  handleProtocols:protocols=>protocols.has('rez-v1')?'rez-v1':false});
 const clients=new Set(),pending=new Set();let closed=false;
 const tick=ws=>{if(ws.readyState===WebSocket.OPEN){const at=Date.now();if(ws.lastTickAt&&at-ws.lastTickAt<(ws.tickMs||tickMs))return;ws.lastTickAt=at;ws.send(JSON.stringify({type:'tick',at}));}};
 function upgrade(req,socket,head){
  const reject=status=>{socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);};
  if(closed||req.url!=='/reader-clock'||req.headers.host!==`127.0.0.1:${server.address()?.port}`){reject('404 Not Found');return;}
  if(req.headers.origin!==`chrome-extension://${extensionId}`||req.headers['sec-websocket-protocol']!=='rez-v1'){reject('403 Forbidden');return;}
  if(pending.size>=2){reject('429 Too Many Requests');return;}
  wss.handleUpgrade(req,socket,head,ws=>{
   pending.add(ws);const timeout=setTimeout(()=>ws.close(1008,'authentication required'),3000);timeout.unref();
   ws.on('error',()=>{});
   ws.on('close',()=>{clearTimeout(timeout);pending.delete(ws);clients.delete(ws);});
   ws.on('message',bytes=>{
    if(clients.has(ws))return;
    let value;try{value=JSON.parse(bytes.toString());}catch{ws.close(1008,'invalid authentication');return;}
    const received=Buffer.from(typeof value?.key==='string'?value.key:'');const expected=Buffer.from(key);
    if(value?.type!=='auth'||received.length!==expected.length||!timingSafeEqual(received,expected)){ws.close(1008,'invalid authentication');return;}
    clearTimeout(timeout);pending.delete(ws);
    for(const old of clients)old.close(1000,'replaced');
    clients.clear();ws.tickMs=value.tickMs===1000?1000:tickMs;clients.add(ws);tick(ws);
   });
  });
 }
 server.on('upgrade',upgrade);
 const timer=setInterval(()=>{for(const ws of clients)tick(ws);},Math.min(tickMs,1000));timer.unref();
 return {status:()=>({connected:clients.size>0,tickMs:[...clients][0]?.tickMs||tickMs}),close(){closed=true;clearInterval(timer);server.off('upgrade',upgrade);for(const ws of [...clients,...pending])ws.terminate();clients.clear();pending.clear();wss.close();}};
}
