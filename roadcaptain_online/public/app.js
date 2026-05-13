
const $ = id => document.getElementById(id);
$("date").value = new Date().toISOString().slice(0,10);

function log(msg){ $("log").textContent = msg || ""; }
async function api(url, opts={}) {
  const r = await fetch(url, opts);
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || "Errore API");
  return data;
}
function setupSuggest(inputId, boxId) {
  const input = $(inputId), box = $(boxId);
  let t = null;
  input.addEventListener("input", () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 3) { box.innerHTML=""; return; }
    t = setTimeout(async () => {
      try {
        const data = await api("/api/suggest?q="+encodeURIComponent(q));
        box.innerHTML = data.items.map(x=>`<button type="button">${x.description}</button>`).join("");
        [...box.querySelectorAll("button")].forEach(b => b.onclick = () => { input.value = b.textContent; box.innerHTML=""; });
      } catch(e) { box.innerHTML=""; log(e.message); }
    }, 300);
  });
}
setupSuggest("origin","originSug"); setupSuggest("destination","destSug");

$("fuelBtn").onclick = async () => {
  try {
    const data = await api("/api/fuel?type="+encodeURIComponent($("fuelType").value));
    $("fuelPrice").value = String(data.price).replace(".", ",");
    log(data.source);
  } catch(e) { log(e.message); }
};

$("parseBtn").onclick = () => {
  const t = $("natural").value;
  const from = t.match(/partire da\s+(.+?)\s+(?:ed|e)\s+arrivare/i);
  const to = t.match(/arrivare (?:al|a|alla)\s+(.+?)(?:\.|,|\s+pianifica|\s+considera|$)/i);
  const time = t.match(/(?:ore|alle)\s+(\d{1,2})[:.](\d{2})/i);
  const date = t.match(/(\d{1,2})\s+maggio\s+(\d{4})/i);
  const cons = t.match(/(\d+(?:[,.]\d+)?)\s*km\/l/i);
  if (from) $("origin").value = from[1].trim();
  if (to) $("destination").value = to[1].trim();
  if (time) $("time").value = `${time[1].padStart(2,"0")}:${time[2]}`;
  if (date) $("date").value = `${date[2]}-05-${date[1].padStart(2,"0")}`;
  if (cons) $("consumptionKmL").value = cons[1].replace(",",".");
  log("Testo analizzato. Controlla i campi prima di calcolare.");
};

$("tripForm").onsubmit = async e => {
  e.preventDefault();
  log("Calcolo in corso...");
  const body = {
    origin:$("origin").value, destination:$("destination").value, date:$("date").value, time:$("time").value, mode:$("mode").value,
    maxAutonomyKm:$("maxAutonomyKm").value, stopEveryKm:$("stopEveryKm").value, forwardWindowKm:$("forwardWindowKm").value,
    stopMinutes:$("stopMinutes").value, fuelType:$("fuelType").value, consumptionKmL:$("consumptionKmL").value, fuelPrice:$("fuelPrice").value
  };
  try {
    const data = await api("/api/plan", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
    $("apiStatus").textContent = "API Google: attiva";
    $("km").textContent = data.route.distanceKm.toFixed(1);
    $("drive").textContent = data.route.durationHours.toFixed(1)+" h";
    $("dep").textContent = data.times.departure;
    $("arr").textContent = data.times.arrival;
    $("liters").textContent = data.fuel.liters.toFixed(1);
    $("cost").textContent = "€ " + data.fuel.cost.toFixed(2);
    $("pois").textContent = data.poisFound;
    $("tolls").textContent = data.route.tollInfo ? "Info pedaggi disponibile" : "N/D";
    $("stops").innerHTML = data.stops.map(s => {
      if (s.status === "CRITICA") return `<div class="stop"><span class="badge CRITICA">CRITICA</span><strong>km ${s.routeKm}</strong><p>${s.message}</p></div>`;
      return `<div class="stop"><span class="badge ${s.status}">${s.status}</span><strong>km ${s.routeKm.toFixed(1)}</strong><h4>${s.name}</h4><p>${s.address || ""}</p><small>${s.source} | scostamento rotta ${s.offsetMeters} m</small></div>`;
    }).join("") || "<p class='muted'>Nessuna sosta necessaria.</p>";
    log("Calcolo completato.");
  } catch(err) {
    $("apiStatus").textContent = "API: errore";
    log("Errore: " + err.message);
  }
};
