# Road Captain by Rhegium - v5.0.0

## v5.0.0 — Rivisitazione grafica completa ("Touring Cockpit")
- Nuovo tema scuro premium, identità bordeaux/cremisi coerente.
- Tipografia da segnaletica: Oswald (titoli) + Manrope (testo).
- Componenti ridisegnati: pannelli, schede metriche, campi, pulsanti, badge sosta,
  banner avvisi, elenco POI, marker della mappa.
- Icone vettoriali SVG coerenti al posto delle emoji (UI, legenda, marker, categorie POI).
- Basemap moderna (CARTO Voyager) al posto delle tile OSM standard.
- Micro-interazioni: comparsa a cascata dei pannelli, hover, focus ring.
- Nessuna logica modificata: tutti gli ID e gli agganci JS invariati; suite test invariata e verde.

## Funzioni principali
- modalità "Arrivo alle ore indicate" / "Partenza alle ore indicate" (fuso Europe/Rome);
- soste carburante automatiche con autonomia reale; sosta lunga agganciata all'orario;
- prezzo carburante MIMIT con fallback; pedaggio totale via Google Routes;
- opzione "Evita i pedaggi" con messaggio di ripiego sul percorso più economico;
- stima pedaggio (classe A, moto) quando Google non fornisce l'importo (marcata con ≈);
- POI distribuiti lungo tutto l'itinerario, ordinati per rilevanza, con icone per categoria;
- titolo sosta = nome area di servizio (o comune), marchio come dettaglio secondario.
