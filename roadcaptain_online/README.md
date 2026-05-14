# Road Captain by Rhegium - Google V3.1.7

Versione con:
- fix fuso orario Europe/Rome;
- prezzo carburante da MIMIT con fallback locale;
- autonomia calcolata automaticamente da capienza serbatoio e consumo;
- fix campo data mobile;
- calcolo pedaggi tramite Google Routes `extraComputations: TOLLS` quando disponibile;
- totale stimato carburante + pedaggio.

Nota pedaggi: non esiste un dataset pubblico unico tipo MIMIT per i pedaggi italiani. Con chiave Google Maps attiva l'app usa `routes.travelAdvisory.tollInfo.estimatedPrice`. In fallback gratuito non inventa importi.
