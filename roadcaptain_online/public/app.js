
const $ = id => document.getElementById(id);
$("date").value = new Date().toISOString().slice(0,10);
function log(m){ $("log").textContent = m || ""; }
async function api(url, opts={}) {
  const r = await fetch(url, opts);
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || "Errore");
  return data;
}
function setupSuggest(inputId, boxId){
  const input=$(inputId), box=$(boxId); let timer=null;
  input.addEventListener("input",()=>{
    clearTimeout(timer);
    const q=input.value.trim();
    if(q.length<3){box.innerHTML="";return;}
    timer=setTimeout(async()=>{
      try{
        const d=await api("/api/suggest?q="+encodeURIComponent(q));
        box.innerHTML=d.items.map(x=>`<button type="button">${x.description}</button>`).join("");
        box.querySelectorAll("button").forEach(b=>b.onclick=()=>{input.value=b.textContent;box.innerHTML="";});
      }catch(e){log("Suggerimenti: "+e.message);}
    },350);
  });
}
setupSuggest("origin","originSug"); setupSuggest("destination","destSug");
$("fuelType").addEventListener("change",()=> $("fuelBtn").click());
$("fuelBtn").onclick=async()=>{
  try{
    const d=await api("/api/fuel?type="+encodeURIComponent($("fuelType").value));
    $("fuelPrice").value=String(d.price).replace(".",",");
    log(d.source);
  }catch(e){log("Prezzo carburante: "+e.message);}
};
$("parseBtn").onclick=()=>{
  const t=$("natural").value;
  const from=t.match(/partire da\s+(.+?)\s+(?:ed|e)\s+arrivare/i);
  const to=t.match(/arrivare (?:al|a|alla)\s+(.+?)(?:\.|,|\s+pianifica|\s+considera|$)/i);
  const tm=t.match(/(?:ore|alle)\s+(\d{1,2})[:.](\d{2})/i);
  const date=t.match(/(\d{1,2})\s+maggio\s+(\d{4})/i);
  const cons=t.match(/(\d+(?:[,.]\d+)?)\s*km\/l/i);
  if(from) $("origin").value=from[1].trim();
  if(to) $("destination").value=to[1].trim();
  if(tm) $("time").value=`${tm[1].padStart(2,"0")}:${tm[2]}`;
  if(date) $("date").value=`${date[2]}-05-${date[1].padStart(2,"0")}`;
  if(cons) $("consumptionKmL").value=cons[1].replace(",",".");
  log("Testo analizzato. Controlla gli indirizzi selezionando il suggerimento se compare.");
};
$("calcBtn").onclick=async()=>{
  log("Calcolo in corso...");
  try{
    const body={
      origin:$("origin").value,destination:$("destination").value,date:$("date").value,time:$("time").value,mode:$("mode").value,
      maxAutonomyKm:$("maxAutonomyKm").value,stopEveryKm:$("stopEveryKm").value,forwardWindowKm:$("forwardWindowKm").value,
      consumptionKmL:$("consumptionKmL").value,stopMinutes:$("stopMinutes").value,fuelPrice:$("fuelPrice").value,fuelType:$("fuelType").value
    };
    const d=await api("/api/plan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    $("km").textContent=d.route.distanceKm.toFixed(1);
    $("drive").textContent=d.route.durationHours.toFixed(1)+" h";
    $("dep").textContent=d.times.departure; $("arr").textContent=d.times.arrival;
    $("liters").textContent=d.fuel.liters.toFixed(1); $("cost").textContent="€ "+d.fuel.cost.toFixed(2);
    $("pois").textContent=`${d.stops.filter(s=>s.status!=="CRITICA").length} / ${d.poisFound}`;
    $("tolls").textContent=d.route.tollInfo ? "Info pedaggi disponibile" : "N/D";
    $("stops").innerHTML=d.stops.map(s=>s.status==="CRITICA" ? 
      `<div class="stop"><span class="badge CRITICA">CRITICA</span><strong>km ${s.routeKm}</strong><p>${s.message}</p></div>` :
      `<div class="stop"><span class="badge ${s.status}">${s.status}</span><strong>km ${s.routeKm.toFixed(1)}</strong><h3>${s.name}</h3><p>${s.address}</p><small>${s.source} | scostamento rotta ${s.offsetMeters} m</small></div>`
    ).join("") || "Nessuna sosta necessaria.";
    log("Calcolo completato.");
  }catch(e){log("Errore: "+e.message);}
};
