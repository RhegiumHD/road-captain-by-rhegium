const $ = id => document.getElementById(id);
const log = m => $('log').textContent = m;
$('garageBtn').onclick=()=> $('garage').classList.remove('hidden');
$('closeGarage').onclick=()=> $('garage').classList.add('hidden');

const today = new Date();
$('date').value = new Date(today.getTime() - today.getTimezoneOffset()*60000).toISOString().slice(0,10);

function normalizeDateFromText(text){
  const months={gennaio:'01',febbraio:'02',marzo:'03',aprile:'04',maggio:'05',giugno:'06',luglio:'07',agosto:'08',settembre:'09',ottobre:'10',novembre:'11',dicembre:'12'};
  const m=text.toLowerCase().match(/(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})/);
  if(m) return `${m[3]}-${months[m[2]]}-${String(m[1]).padStart(2,'0')}`;
  const d=text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if(d) return `${d[3]}-${String(d[2]).padStart(2,'0')}-${String(d[1]).padStart(2,'0')}`;
  return null;
}

function parseTripText(){
  const t=$('tripText').value.trim();
  if(!t){ log('Scrivi prima una richiesta di viaggio.'); return; }
  const lower=t.toLowerCase();
  const from=t.match(/(?:partire|parto|partenza)\s+(?:da|dall'|dalla|dal)\s+(.+?)(?:\s+(?:ed?|e)\s+(?:arrivare|arrivo|arriva)|\s+arrivare|\s+fino|\s+devo arrivare|$)/i);
  const to=t.match(/(?:arrivare|arrivo|arriva|destinazione|fino)\s+(?:a|al|allo|alla|all')\s+(.+?)(?:\.|,?\s+(?:pianifica|voglio|considera|calcola|autonomia|consumo|partenza|il giorno|giorno)|$)/i);
  if(from) $('start').value=from[1].trim().replace(/[,.]$/,'');
  if(to) $('end').value=to[1].trim().replace(/[,.]$/,'');
  const date=normalizeDateFromText(t); if(date) $('date').value=date;
  const time=t.match(/(?:alle ore|alle|ore)\s*(\d{1,2})[:\.](\d{2})/i); if(time) $('time').value=`${String(time[1]).padStart(2,'0')}:${time[2]}`;
  if(lower.includes('arriv')) $('scheduleMode').value='arrival';
  const aut=t.match(/autonomia\s*(?:è|e'|di)?\s*(\d+)\s*km/i); if(aut) $('maxAutonomyKm').value=aut[1];
  const stop=t.match(/(?:sosta|pieno).*?ogni\s*(\d+)\s*km/i); if(stop) $('stopEveryKm').value=stop[1];
  const cons=t.match(/(?:consumo medio|consumo).*?(\d+(?:[,.]\d+)?)\s*km\s*\/\s*l/i); if(cons) $('consumptionKmL').value=cons[1].replace('.',',');
  if(lower.includes('gasolio')||lower.includes('diesel')) $('fuelType').value='Gasolio';
  if(lower.includes('benzina')) $('fuelType').value='Benzina';
  log('Testo analizzato. Controlla i campi prima di calcolare.');
  refreshFuelPrice();
}
$('parseTrip').onclick=parseTripText;

async function refreshFuelPrice(){
  try{
    log('Aggiorno prezzo medio MIMIT...');
    const r=await fetch('/api/fuel-price?fuel='+encodeURIComponent($('fuelType').value));
    const data=await r.json();
    if(!r.ok) throw new Error(data.error||'Prezzo non disponibile');
    $('fuelPrice').value=String(data.price).replace('.',',');
    $('fuelSource').value=data.source;
    log(`Prezzo ${data.fuel}: € ${data.price}/l - ${data.source}`);
  }catch(e){
    $('fuelSource').value='Manuale: MIMIT non raggiungibile';
    if(!$('fuelPrice').value) $('fuelPrice').value = $('fuelType').value==='Gasolio' ? '1,90' : '1,95';
    log('Prezzo MIMIT non recuperato: '+e.message+'. Puoi inserire il prezzo manualmente.');
  }
}
$('refreshFuel').onclick=refreshFuelPrice;
$('fuelType').onchange=refreshFuelPrice;

async function plan(){
  $('calc').disabled=true; log('Calcolo con Google Routes + Places...');
  try{
    const body={};
    ['start','end','date','time','scheduleMode','maxAutonomyKm','stopEveryKm','forwardWindowKm','consumptionKmL','fuelType','fuelPrice','fuelSource','stopMinutes','maxOffsetMeters'].forEach(id=>body[id]=$(id).value);
    const r=await fetch('/api/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await r.json(); if(!r.ok) throw new Error(data.error||'Errore server');
    $('km').textContent=data.totalKm; $('dur').textContent=data.driveHours+' h'; $('dep').textContent=data.departure; $('arr').textContent=data.arrival;
    $('lit').textContent=data.liters; $('cost').textContent='€ '+data.fuelCost.toFixed(2); $('toll').textContent=data.tolls; $('poi').textContent=data.poiCount;
    $('fuelUsed').textContent=`${data.fuel.fuel} € ${data.fuel.price}/l - ${data.fuel.source}`;
    $('stops').innerHTML=data.stops.map(s=>`<div class="stop"><h3><span class="badge ${s.status}">${s.status}</span> km ${s.km}</h3><b>${s.name||''}</b><p>${s.vicinity||''}</p><p>${s.source||''} | scostamento rotta ${s.offsetMeters??'N/D'} m</p><p>${s.note||''}</p></div>`).join('') || '<p>Nessuna sosta necessaria o nessuna sosta trovata.</p>';
    log(`Motore: ${data.engine}\nOrigine: ${data.origin.address}\nArrivo: ${data.destination.address}\nPOI filtrati sulla rotta: ${data.poiCount}\nOffset massimo: ${data.maxOffsetMeters} m`);
  }catch(e){ log('Errore: '+e.message); }
  finally{$('calc').disabled=false;}
}
$('calc').onclick=plan;
