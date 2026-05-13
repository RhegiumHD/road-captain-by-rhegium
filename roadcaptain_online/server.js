import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const USER_AGENT = 'RoadCaptainByRhegium/1.0 contact:private-local-planner';

async function ensureData(){ await fs.mkdir(DATA, {recursive:true}); for(const f of ['garage.json','trips.json']){ try{await fs.access(path.join(DATA,f));}catch{await fs.writeFile(path.join(DATA,f),'[]','utf8');} } }
await ensureData();

function send(res, status, body, type='application/json'){ res.writeHead(status, {'Content-Type':type, 'Access-Control-Allow-Origin':'*'}); res.end(type==='application/json'?JSON.stringify(body):body); }
function parseBody(req){ return new Promise((resolve,reject)=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ try{resolve(b?JSON.parse(b):{});}catch(e){reject(e);} }); }); }
function q(url){ return new URL(url, 'http://localhost'); }
async function fetchJson(url, timeoutMs=18000){ const ctrl = new AbortController(); const t=setTimeout(()=>ctrl.abort(), timeoutMs); try{ const r = await fetch(url, {headers:{'User-Agent':USER_AGENT,'Accept':'application/json'}, signal:ctrl.signal}); const text=await r.text(); if(!r.ok) throw new Error(`${r.status} ${text.slice(0,160)}`); return JSON.parse(text); } finally { clearTimeout(t); } }
async function readJson(name){ try{return JSON.parse(await fs.readFile(path.join(DATA,name),'utf8'));}catch{return [];} }
async function writeJson(name,val){ await fs.writeFile(path.join(DATA,name), JSON.stringify(val,null,2),'utf8'); }

import { haversine, cumulative, pointAt, nearestProgress } from './engine.js';
function simplifyForOverpass(points, dist, startKm, endKm){ const out=[]; const step=Math.max(5, Math.floor((endKm-startKm)/8)); for(let km=startKm; km<=endKm; km+=step) out.push(pointAt(points,dist,km)); out.push(pointAt(points,dist,endKm)); return out; }
async function overpassFuelNearPolyline(points, dist, startKm, endKm){ const probes=simplifyForOverpass(points,dist,startKm,endKm); const radius=80; const chunks = probes.map(p=>`node(around:${radius},${p.lat},${p.lon})[amenity=fuel];way(around:${radius},${p.lat},${p.lon})[amenity=fuel];relation(around:${radius},${p.lat},${p.lon})[amenity=fuel];`).join('');
 const query=`[out:json][timeout:18];(${chunks});out center tags;`;
 const data=await fetchJson('https://overpass-api.de/api/interpreter?data='+encodeURIComponent(query), 25000);
 const seen=new Map();
 for(const e of data.elements||[]){ const lat=e.lat ?? e.center?.lat, lon=e.lon ?? e.center?.lon; if(lat==null||lon==null) continue; const id=`${e.type}-${e.id}`; const tags=e.tags||{}; const name=tags.name || tags.brand || tags.operator || 'Distributore / area carburante'; const np=nearestProgress(points,dist,{lat,lon}); if(np.d<=0.25 && np.km>=startKm-0.1 && np.km<=endKm+0.1){ seen.set(id,{id,name,lat,lon,progressKm:np.km,offRouteKm:np.d,brand:tags.brand||'',operator:tags.operator||'',source:'OSM/Overpass'}); }
 }
 return [...seen.values()].sort((a,b)=>a.progressKm-b.progressKm);
}
async function geocode(text){ const s=text.trim(); if(s.length<3) return [];
 const nom=`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=it&q=${encodeURIComponent(s)}`;
 try{ const arr=await fetchJson(nom,12000); if(arr?.length) return arr.map(x=>({label:x.display_name,lat:+x.lat,lon:+x.lon,source:'Nominatim'})); }catch(e){}
 const pho=`https://photon.komoot.io/api/?limit=6&lang=it&q=${encodeURIComponent(s)}`;
 try{ const data=await fetchJson(pho,12000); return (data.features||[]).map(f=>({label:[f.properties.name,f.properties.street,f.properties.city,f.properties.county,f.properties.country].filter(Boolean).join(', '), lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0], source:'Photon'})); }catch(e){ return []; }
}
async function route(points){ const coord=points.map(p=>`${p.lon},${p.lat}`).join(';'); const url=`https://router.project-osrm.org/route/v1/driving/${coord}?overview=full&geometries=geojson&steps=false&alternatives=false`;
 const data=await fetchJson(url,20000); const r=data.routes?.[0]; if(!r) throw new Error('Nessuna rotta OSRM'); return {distanceKm:r.distance/1000, durationMin:r.duration/60, geometry:r.geometry.coordinates.map(([lon,lat])=>({lat,lon}))}; }
async function plan(body){ const startList= await geocode(body.start); const endList= await geocode(body.end); if(!startList[0]||!endList[0]) throw new Error('Partenza o arrivo non risolti'); const r= await route([startList[0], ...(body.waypoints||[]), endList[0]]); const dist=cumulative(r.geometry);
 const stopEvery=Number(body.stopEveryKm||150), forward=Number(body.forwardWindowKm||25), maxAut=Number(body.maxAutonomyKm||200);
 let last=0; const stops=[]; const total=r.distanceKm; let guard=0;
 while(total-last>maxAut*0.75 && guard++<20){ const target=last+stopEvery; const limit=Math.min(last+stopEvery+forward, total); let candidates=[]; try{ candidates=await overpassFuelNearPolyline(r.geometry,dist,target,limit); }catch(e){ candidates=[]; }
 let status='VALIDA'; let selected=candidates[0];
 if(!selected){ let back=[]; try{ back=await overpassFuelNearPolyline(r.geometry,dist,last+5,Math.min(target,total)); }catch(e){} back=back.filter(x=>x.progressKm>last+20).sort((a,b)=>b.progressKm-a.progressKm); selected=back[0]; status='ANTICIPATA'; }
 if(!selected){ stops.push({status:'CRITICA',message:`Nessuna sosta carburante sulla rotta tra km ${Math.round(last)} e km ${Math.round(limit)}. Serve verifica manuale.`,targetKm:target}); break; }
 stops.push({...selected,status,targetKm:target}); last=selected.progressKm;
 if(total-last<maxAut) break;
 }
 const consumption=Number(body.consumptionKmL||13); const fuelPrice=Number(body.fuelPrice||1.85); const liters=total/consumption; const fuelCost=liters*fuelPrice;
 const stopMinutes=Number(body.stopMinutes||15); const pauseMinutes=Number(body.pauseMinutes||0); const totalMinutes=r.durationMin+stops.filter(s=>s.status!=='CRITICA').length*stopMinutes+pauseMinutes;
 let departure='', arrival='';
 if(body.mode==='arrival' && body.date && body.time){ const arr=new Date(`${body.date}T${body.time}:00`); const dep=new Date(arr.getTime()-totalMinutes*60000); departure=dep.toISOString(); arrival=arr.toISOString(); }
 else if(body.date && body.time){ const dep=new Date(`${body.date}T${body.time}:00`); const arr=new Date(dep.getTime()+totalMinutes*60000); departure=dep.toISOString(); arrival=arr.toISOString(); }
 return {start:startList[0], end:endList[0], route:r, stops, metrics:{km:total,durationMin:r.durationMin,totalMinutes,liters,fuelCost,fuelPrice, tolls:'N/D - richiede fonte/API pedaggi affidabile', departure, arrival}, limitations:['Pedaggi automatici non calcolati senza API commerciale o fonte ufficiale interrogabile stabilmente.','Prezzo carburante: usare dato MIMIT/import o valore manuale aggiornato; non simulato.']};
}

const server=http.createServer(async (req,res)=>{ try{ const url=q(req.url); if(req.method==='GET' && url.pathname.startsWith('/api/suggest')) return send(res,200, await geocode(url.searchParams.get('q')||''));
 if(req.method==='GET' && url.pathname==='/api/garage') return send(res,200, await readJson('garage.json'));
 if(req.method==='POST' && url.pathname==='/api/garage'){ const b=await parseBody(req); const arr=await readJson('garage.json'); const item={id:Date.now().toString(36),...b}; arr.push(item); await writeJson('garage.json',arr); return send(res,200,item); }
 if(req.method==='POST' && url.pathname==='/api/plan') return send(res,200, await plan(await parseBody(req)));
 if(req.method==='POST' && url.pathname==='/api/trips'){ const b=await parseBody(req); const arr=await readJson('trips.json'); const item={id:Date.now().toString(36),createdAt:new Date().toISOString(),...b}; arr.push(item); await writeJson('trips.json',arr); return send(res,200,item); }
 let file=url.pathname==='/'?'index.html':url.pathname.slice(1); file=path.normalize(file).replace(/^\.\.(\/|\\|$)/,''); const fp=path.join(PUBLIC,file); const ext=path.extname(fp); const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'}; const data=await fs.readFile(fp); return send(res,200,data,types[ext]||'application/octet-stream'); } catch(e){ return send(res,500,{error:e.message||String(e)}); } });
server.listen(PORT,()=>console.log(`Road Captain online su http://localhost:${PORT}`));

