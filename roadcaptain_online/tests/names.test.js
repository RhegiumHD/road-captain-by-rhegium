import { normalizeServiceAreaName as title } from "../server.js";

const cases = [
  // [name (marchio Google), address, titolo atteso]
  ["Biondi Antonio & C Snc Via Area Di Servizio La Macchia OVEST", "Via Area Di Servizio La Macchia Ovest, A1, 610, 03012 Anagni FR, Italia", "La Macchia Ovest"],
  ["Esso", "Area di servizio Villa San Giovanni Est, A2 Autostrada del Mediterraneo, 89018 Villa San Giovanni RC, Italia", "Villa San Giovanni Est"],
  ["IP", "Area Servizio Sala Consilina Ovest, A2, 84036 Sala Consilina SA, Italia", "Sala Consilina Ovest"],
  // Google nomina l'area con l'operatore: deve vincere il toponimo dall'indirizzo.
  ["Area Di Servizio Biondi Antonio & C Snc", "Via Area Di Servizio La Macchia Ovest, A1, 610, 03012 Anagni FR, Italia", "La Macchia Ovest"],
  // Aree autostradali senza dicitura "area di servizio": toponimo + Est/Ovest dal nome/indirizzo.
  ["ENI (A1, Arda Est)", "Autostrada del Sole Arda Est, 29017 Fiorenzuola d'Arda PC, Italia", "Arda Est"],
  ["Shop La Macchia Est", "A1, 1, 03012 Anagni FR, Italia", "La Macchia Est"],
  // "Via Nazionale Nord" NON deve diventare un'area (nessun contesto autostradale) -> comune.
  ["2P Carburanti", "Via Nazionale Nord, 2, 40035 Lagaro BO, Italia", "Lagaro"],
  // Stazioni urbane senza area di servizio: ripiego sul comune.
  ["Eni Station", "Via S. Giovanni, 31, 84025 Eboli SA, Italia", "Eboli"],
  ["Distributore Esso", "SCALO CS IT, SS.19, KM.246+234, 87010 Torano Castello CS, Italia", "Torano Castello"],
  ["Indipendente", "SP326 Est, 53045 Montepulciano SI, Italia", "Montepulciano"],
];

for (const [name, address, expected] of cases) {
  const got = title(name, address);
  if (got !== expected) throw new Error(`titolo sosta: atteso "${expected}", ottenuto "${got}" (name="${name}")`);
}
// Il marchio non deve mai diventare il titolo quando c'e' un'alternativa.
if (title("Tamoil", "Via Roma 1, 00100 Roma RM, Italia") === "Tamoil") throw new Error("il marchio non deve essere il titolo");

console.log("names ok");
