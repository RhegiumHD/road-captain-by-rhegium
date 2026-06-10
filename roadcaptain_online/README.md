# Road Captain by Rhegium - v5.1.0

## v5.1.0 — Controllo accessi a codice (multi-codice, log IP, revoca singola)
Protezione opzionale: l'app calcola (e quindi chiama le API a pagamento) solo dopo
l'inserimento di un codice valido. Si attiva impostando le variabili d'ambiente su Render.

Variabili d'ambiente:
- `ACCESS_CODES`  Lista di codici separati da virgola. Formato "etichetta:CODICE" o solo "CODICE".
                  Es: `marco:Rombo2024,lucia:Vento77,chapter:Baca150`
                  - Più codici = un codice per persona.
                  - Revochi un singolo accesso eliminando il suo codice dalla lista (poi salva: Render riavvia).
                  - Se la variabile NON è impostata, l'app resta aperta (nessun blocco).
- `SESSION_SECRET`  Stringa segreta a tua scelta per firmare le sessioni (es. una password lunga).
- `ADMIN_CODE`   (opzionale) Codice per consultare il registro accessi.
- `SESSION_DAYS` (opzionale, default 30) Durata della sessione in giorni.

Registro accessi (IP): `/api/admin/log?key=ADMIN_CODE` mostra gli ultimi accessi
(login riusciti e falliti) con orario, etichetta e IP. NOTA: è un log IN MEMORIA,
si azzera al riavvio/redeploy del server. Per uno storico permanente serve un database.

Promemoria costi: il cancello riduce gli accessi, ma la vera rete di sicurezza sono le
QUOTE basse sulle API Google + un avviso di budget (vedi console Google Cloud).

## Storico recente
- v5.0.x: rivisitazione grafica completa, icone SVG, basemap CARTO; serbatoio/consumo senza default; nomi aree di servizio (toponimo invece dell'operatore).
- v4.x: arrivo entro, soste, MIMIT, pedaggi + evita pedaggi + stima, POI lungo l'itinerario.
