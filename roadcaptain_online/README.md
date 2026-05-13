# Road Captain by Rhegium - Google V3.1.1

Versione correttiva basata sulla V3.1, senza redesign invasivo.

Render:
Root Directory: roadcaptain_online
Build Command: npm install
Start Command: node server.js
Environment: GOOGLE_MAPS_API_KEY=<chiave>

Note:
- /api/fuel funziona anche senza chiave Google.
- /api/suggest usa Google se la chiave esiste, altrimenti fallback Nominatim.
- /api/plan richiede GOOGLE_MAPS_API_KEY.
