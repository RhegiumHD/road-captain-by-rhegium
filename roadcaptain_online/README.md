# Road Captain by Rhegium - Online First

Questa versione stravolge l'approccio: niente app locale Windows. Il progetto si pubblica online e poi si usa da browser tramite link privato.

## Avvio locale per test sviluppatore
```bash
npm start
```
Poi aprire http://localhost:8787

## Deploy rapido
Compatibile con Render/Railway/Fly/VPS Node 20+.
Comando start: `npm start`.

## Cosa fa
- geocoding server-side con Nominatim + fallback Photon
- routing OSRM
- ricerca carburante Overpass lungo la polyline
- soste con logica: target 150 km, finestra 150-175, poi ritroso
- zero deviazioni valide
- garage e viaggi salvati in JSON lato server

## Limiti dichiarati
- pedaggi automatici: N/D senza API affidabile/commerciale
- prezzo carburante: campo manuale o futura integrazione MIMIT
- Overpass/OSRM gratuiti possono rallentare o limitare le richieste
