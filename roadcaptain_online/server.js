import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversine, cumulative, pointAt, nearestProgress } from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const USER_AGENT = 'RoadCaptainByRhegium/2.0 route-planner contact:private-use';

async function ensureData(){
  await fs.mkdir(DATA, {recursive:true});
  for(const f of ['garage.json','trips.json']){
    try{ await fs.access(path.join(DATA,f)); }
    catch{ await fs.writeFile(path.join(DATA,f),'[]','utf8'); }
  }
}
await ensureData();

function send(res, status, body, type='application/json'){
  res.writeHead(status, {'Content-Type':type, 'Access-Control-Allow-Origin':'*'});
  res.end(type==='application/json' ? JSON.stringify(body) : body);
}
function parseBody(req){
  return new Promise((resolve,reject)=>{
    let b='';
    req.on('data',c=>b+=c);
    req.on('end',()=>{ try{ resolve(b?JSON.parse(b):{}); }catch(e){ reject(e); } });
  });
}
function q(url){ return new URL(url, 'http://localhost'); }
async function fetchJson(url, timeoutMs=18000){
  const ctrl = new AbortController();
  const t=setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const r = await fetch(url, {headers:{'User-Agent':USER_AGENT,'Accept':'application/json'}, signal:ctrl.signal});
    const text=await r.text();
    if(!r.ok) throw new Error(`${r.status} ${text.slice(0,180)}`);
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}
async function readJson(name){ try{return JSON.parse(await fs.readFile(path.join(DATA,name),'utf8'));}catch{return [];} }
async function writeJson(name,val){ await fs.writeFile(path.join(DATA,name), JSON.stringify(val,null,2),'utf8'); }

function bboxForSegment(points, dist, startKm, endKm, marginDeg=0.018){
  const samples=[];
  const step=8;
  for(let km=startKm; km<=endKm; km+=step) samples.push(pointAt(points,dist,km));
  samples.push(pointAt(points,dist,endKm));
  const lats=samples.map(p=>p.lat), lons=samples.map(p=>p.lon);
  return {
    s:Math.min(...lats)-marginDeg,
    n:Math.max(...lats)+marginDeg,
    w:Math.min(...lons)-marginDeg,
    e:Math.max(...lons)+marginDeg,
  };
}

async function overpassFuelInBbox(b){
  const query=`[out:json][timeout:22];(
    node["amenity"="fuel"](${b.s},${b.w},${b.n},${b.e});
    way["amenity"="fuel"](${b.s},${b.w},${b.n},${b.e});
    relation["amenity"="fuel"](${b.s},${b.w},${b.n},${b.e});
  );out center tags;`;
  return await fetchJson('https://overpass-api.de/api/interpreter?data='+encodeURIComponent(query), 30000);
}

async function collectRouteFuelCandidates(points, dist, totalKm){
  const seen=new Map();
  const chunk=90;
  for(let start=0; start<totalKm; start+=chunk){
    const end=Math.min(totalKm, start+chunk+20);
    const bbox=bboxForSegment(points, dist, start, end, 0.025);
    let data;
    try{ data=await overpassFuelInBbox(bbox); }
    catch(e){ continue; }
    for(const el of data.elements||[]){
      const lat=el.lat ?? el.center?.lat;
      const lon=el.lon ?? el.center?.lon;
      if(lat==null || lon==null) continue;
      const id=`${el.type}-${el.id}`;
      if(seen.has(id)) continue;
      const tags=el.tags||{};
      const poi={lat, lon};
      const np=nearestProgress(points, dist, poi);
      // Corridoio stretto: non e' una deviazione proposta. Serve solo a tollerare offset cartografico di aree di servizio e carreggiate.
      if(np.d<=0.65 && np.km>=0 && np.km<=totalKm){
        seen.set(id,{
          id,
          name:tags.name || tags.brand || tags.operator || 'Distributore / area carburante',
          lat, lon,
          progressKm:np.km,
          offRouteKm:np.d,
          brand:tags.brand||'',
          operator:tags.operator||'',
          highway:tags.highway||'',
          source:'OSM/Overpass',
          tags
        });
      }
    }
  }
  return [...seen.values()].sort((a,b)=>a.progressKm-b.progressKm);
}

function chooseStopsFromCandidates(candidates, totalKm, opts){
  const stopEvery=Number(opts.stopEveryKm||150);
  const forward=Number(opts.forwardWindowKm||25);
  const maxAut=Number(opts.maxAutonomyKm||200);
  const minAfterLast=Math.min(35, stopEvery*0.4);
  let last=0;
  const stops=[];
  let guard=0;

  while(totalKm-last>maxAut && guard++<30){
    const target=last+stopEvery;
    const limit=Math.min(last+stopEvery+forward, totalKm);
    if(target>=totalKm) break;

    const forwardCandidates=candidates.filter(c=>c.progressKm>=target && c.progressKm<=limit);
    let selected=forwardCandidates[0];
    let status='VALIDA';

    if(!selected){
      const backCandidates=candidates
        .filter(c=>c.progressKm>last+minAfterLast && c.progressKm<target)
        .sort((a,b)=>b.progressKm-a.progressKm);
      selected=backCandidates[0];
      status='ANTICIPATA';
    }

    if(!selected){
      stops.push({
        status:'CRITICA',
        progressKm:target,
        targetKm:target,
        message:`Nessuna sosta carburante sulla rotta tra km ${Math.round(last)} e km ${Math.round(limit)}. Serve verifica manuale: non propongo deviazioni come valide.`
      });
      break;
    }

    if(selected.progressKm-last>maxAut){
      stops.push({
        status:'CRITICA',
        progressKm:target,
        targetKm:target,
        message:`La prima sosta utile sarebbe al km ${selected.progressKm.toFixed(1)}, oltre autonomia massima dal km ${last.toFixed(1)}. Serve verifica manuale.`
      });
      break;
    }

    stops.push({...selected, status, targetKm:target});
    last=selected.progressKm;
  }

  // Ottimizzazione semplice: elimina una sosta ravvicinata se la successiva resta entro autonomia massima.
  for(let i=0;i<stops.length-1;i++){
    const prevKm = i===0 ? 0 : stops[i-1].progressKm;
    const nextKm = stops[i+1].progressKm;
    if(!Number.isFinite(nextKm)) continue;
    if(nextKm-prevKm<=maxAut && stops[i+1].status!=='CRITICA' && nextKm-stops[i].progressKm<70){
      stops.splice(i,1);
      i=Math.max(-1,i-2);
    }
  }

  return stops;
}

function localMinutes(date,time){
  const [y,m,d]=date.split('-').map(Number);
  const [hh,mm]=time.split(':').map(Number);
  return Date.UTC(y,m-1,d,hh,mm,0)/60000;
}
function minutesToLocalString(mins){
  const dt=new Date(mins*60000);
  const pad=n=>String(n).padStart(2,'0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth()+1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:00`;
}

async function geocode(text){
  const s=(text||'').trim();
  if(s.length<3) return [];
  const nom=`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=it&q=${encodeURIComponent(s)}`;
  try{
    const arr=await fetchJson(nom,12000);
    if(arr?.length) return arr.map(x=>({label:x.display_name,lat:+x.lat,lon:+x.lon,source:'Nominatim'}));
  }catch(e){}
  const pho=`https://photon.komoot.io/api/?limit=6&lang=it&q=${encodeURIComponent(s)}`;
  try{
    const data=await fetchJson(pho,12000);
    return (data.features||[]).map(f=>({
      label:[f.properties.name,f.properties.street,f.properties.city,f.properties.county,f.properties.country].filter(Boolean).join(', '),
      lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0], source:'Photon'
    }));
  }catch(e){ return []; }
}

async function route(points){
  const coord=points.map(p=>`${p.lon},${p.lat}`).join(';');
  const url=`https://router.project-osrm.org/route/v1/driving/${coord}?overview=full&geometries=geojson&steps=false&alternatives=false`;
  const data=await fetchJson(url,20000);
  const r=data.routes?.[0];
  if(!r) throw new Error('Nessuna rotta OSRM');
  return {distanceKm:r.distance/1000, durationMin:r.duration/60, geometry:r.geometry.coordinates.map(([lon,lat])=>({lat,lon}))};
}

async function plan(body){
  const startList= await geocode(body.start);
  const endList= await geocode(body.end);
  if(!startList[0]||!endList[0]) throw new Error('Partenza o arrivo non risolti');
  const r= await route([startList[0], ...(body.waypoints||[]), endList[0]]);
  const dist=cumulative(r.geometry);
  const candidates=await collectRouteFuelCandidates(r.geometry, dist, r.distanceKm);
  const stops=chooseStopsFromCandidates(candidates, r.distanceKm, body);

  const consumption=Number(body.consumptionKmL||13);
  const fuelPrice=Number(body.fuelPrice||1.85);
  const liters=r.distanceKm/consumption;
  const fuelCost=liters*fuelPrice;
  const stopMinutes=Number(body.stopMinutes||15);
  const pauseMinutes=Number(body.pauseMinutes||0);
  const validStops=stops.filter(s=>s.status!=='CRITICA').length;
  const totalMinutes=r.durationMin+validStops*stopMinutes+pauseMinutes;

  let departure='', arrival='';
  if(body.mode==='arrival' && body.date && body.time){
    const arr=localMinutes(body.date, body.time);
    const dep=arr-totalMinutes;
    departure=minutesToLocalString(dep);
    arrival=minutesToLocalString(arr);
  } else if(body.date && body.time){
    const dep=localMinutes(body.date, body.time);
    const arr=dep+totalMinutes;
    departure=minutesToLocalString(dep);
    arrival=minutesToLocalString(arr);
  }

  return {
    version:'online-first-v2.0',
    start:startList[0],
    end:endList[0],
    route:r,
    candidatesCount:candidates.length,
    stops,
    metrics:{
      km:r.distanceKm,
      durationMin:r.durationMin,
      totalMinutes,
      liters,
      fuelCost,
      fuelPrice,
      tolls:'N/D - richiede fonte/API pedaggi affidabile',
      departure,
      arrival
    },
    limitations:[
      'Soste: cercate solo nel corridoio della rotta; nessuna deviazione viene marcata valida.',
      'Pedaggi automatici non calcolati senza API commerciale o fonte ufficiale interrogabile stabilmente.',
      'Prezzo carburante: usare dato MIMIT/import o valore manuale aggiornato; non simulato.'
    ]
  };
}

const server=http.createServer(async (req,res)=>{
  try{
    const url=q(req.url);
    if(req.method==='GET' && url.pathname.startsWith('/api/suggest')) return send(res,200, await geocode(url.searchParams.get('q')||''));
    if(req.method==='GET' && url.pathname==='/api/garage') return send(res,200, await readJson('garage.json'));
    if(req.method==='POST' && url.pathname==='/api/garage'){
      const b=await parseBody(req); const arr=await readJson('garage.json');
      const item={id:Date.now().toString(36),...b}; arr.push(item); await writeJson('garage.json',arr); return send(res,200,item);
    }
    if(req.method==='POST' && url.pathname==='/api/plan') return send(res,200, await plan(await parseBody(req)));
    if(req.method==='POST' && url.pathname==='/api/trips'){
      const b=await parseBody(req); const arr=await readJson('trips.json');
      const item={id:Date.now().toString(36),createdAt:new Date().toISOString(),...b}; arr.push(item); await writeJson('trips.json',arr); return send(res,200,item);
    }
    let file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    file=path.normalize(file).replace(/^\.\.(\/|\\|$)/,'');
    const fp=path.join(PUBLIC,file);
    const ext=path.extname(fp);
    const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json'};
    const data=await fs.readFile(fp);
    return send(res,200,data,types[ext]||'application/octet-stream');
  } catch(e){
    return send(res,500,{error:e.message||String(e)});
  }
});
server.listen(PORT,()=>console.log(`Road Captain online v2 su http://localhost:${PORT}`));
