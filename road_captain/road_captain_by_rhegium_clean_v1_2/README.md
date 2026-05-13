
# Road Captain by Rhegium

## Deploy Render

Root Directory: vuoto

Build Command:
npm install

Start Command:
node server.js

Environment:
GOOGLE_MAPS_API_KEY=la_tua_chiave_google

## API Google necessarie
- Routes API
- Places API
- Geocoding API
- Maps JavaScript API

## Note tecniche
- Le soste normali durano sempre 20 minuti.
- Le soste vengono cercate lungo la rotta, senza deviazioni deliberate.
- I pedaggi usano Google Routes tollInfo.
- Se Google Routes non restituisce importo pedaggio, l'app mostra un avviso esplicito e non inventa dati.
