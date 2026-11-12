// Función programada de Netlify: cada mañana pide a Claude un cripto nuevo,
// lo comprueba con código y lo deja en Firestore como propuesta pendiente
// (colección "pending") para que el administrador lo apruebe desde la web.
//
// Variables de entorno necesarias (Netlify → Site configuration → Environment variables):
//   ANTHROPIC_API_KEY      clave de la API de Claude
//   FIREBASE_PROJECT_ID    encryptado
//   FIREBASE_CLIENT_EMAIL  "client_email" del archivo .json de la cuenta de servicio
//   FIREBASE_PRIVATE_KEY   "private_key" del mismo archivo (todo, con BEGIN y END)

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export const config = { schedule: "17 6 * * *" }; // 06:17 UTC = 07:17 en Madrid (invierno)

const MODEL = "claude-sonnet-5-5";
const MAX_PENDING = 14;
const SERIES = ["PIRATA","PERO","CASTOR","CREO","ALMA","LOCURA","ANIMAL","BARCO","TIO","CORSETE","VACA","NADA","SOL","OCASO","GATO","CASA","PIEDRA","COMIDA","LIMA","RATA","ROMA","CAPITAL","OLA","PAYASO","TOMATE","PERA","LUNA","ZORRA","BANCO","SOLDADO","CAMPANA","CARACOL"];
const MECHS = ["anagrama","palabra oculta","lectura al revés","contenedor","letras alternas","iniciales","charada","homófono","eliminación de letras","doble definición"];
const LEVELS = ["Fácil","Mediano","Difícil"];

const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const LT = s => norm(s).replace(/[^A-Z]/g, "");
const sortedL = s => [...s].sort().join("");
const frags = s => String(s || "").split("/").map(x => x.trim()).filter(Boolean);
const pick = a => a[Math.floor(Math.random() * a.length)];

function db() {
  if (!getApps().length) {
    initializeApp({ credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }) });
  }
  return getFirestore();
}

/* Igual que en la web: marca la frase con {d|…} {i|…} {m|…} y detecta errores */
function buildClue(f) {
  const errors = [];
  const clue = String(f.clue || "").replace(/[{}|]/g, "").replace(/\s+/g, " ").trim().replace(/\s*\(\d+\)\s*$/, "");
  const L = LT(f.a).length;
  if (!clue) errors.push("sin frase");
  if (!L) errors.push("sin respuesta");
  const defs = frags(f.d), inds = frags(f.i), mats = frags(f.m);
  if (!defs.length) errors.push("sin definición");
  const lc = clue.toLowerCase(), ranges = [];
  const place = (frag, t) => {
    const fl = frag.toLowerCase(); let from = 0;
    for (;;) {
      const i = lc.indexOf(fl, from);
      if (i < 0) { errors.push(`«${frag}» no está en la frase`); return; }
      const j = i + fl.length;
      if (!ranges.some(r => i < r[1] && j > r[0])) { ranges.push([i, j, t]); return; }
      from = i + 1;
    }
  };
  defs.forEach(x => place(x, "d")); inds.forEach(x => place(x, "i")); mats.forEach(x => place(x, "m"));
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "", p = 0;
  for (const [i, j, t] of ranges) { out += clue.slice(p, i) + `{${t}|${clue.slice(i, j)}}`; p = j; }
  out += clue.slice(p);
  return { markup: `${out} (${L})`, errors };
}

/* Igual que en la web: comprueba el mecanismo cuando se puede */
function verify(o) {
  const A = LT(o.a), x = LT(o.letras), mech = norm(o.mecanismo).toLowerCase(), frag = LT(o.m);
  if (mech.includes("anagrama")) return x && sortedL(x) === sortedL(A) ? "ok" : "bad";
  if (mech.includes("oculta")) return frag.includes(A) ? "ok" : "bad";
  if (mech.includes("reves")) return x && [...x].reverse().join("") === A ? "ok" : "bad";
  if (mech.includes("inicial")) { const ini = String(o.m || "").split(/[\s\/,;:.]+/).map(w => LT(w)[0] || "").join(""); return ini === A ? "ok" : "bad"; }
  if (mech.includes("altern")) { const p = [0, 1].map(r => [...frag].filter((_, i) => i % 2 === r).join("")); return p.includes(A) ? "ok" : "bad"; }
  if (mech.includes("charada")) return x === A ? "ok" : "bad";
  if (mech.includes("contenedor")) return x && sortedL(x) === sortedL(A) ? "ok" : "bad";
  return "manual";
}

function prompt(mech, lvl, avoid) {
  return `Eres un autor experto de crucigramas crípticos en español de España. Inventa UNA pista críptica nueva y original.

Reglas:
- La pista es una frase natural con una lectura superficial engañosa. Esconde a la vez una DEFINICIÓN (sinónimo exacto de la respuesta, al principio o al final de la frase) y un JUEGO DE PALABRAS que construye la misma respuesta.
- El juego de palabras usa un INDICADOR (palabra o expresión que avisa del truco: «revuelto», «al revés», «oculto en», «al principio», «se oye»…) y un RELLENO (el material). La doble definición y la charada pueden no tener indicador.
- Mecanismo obligatorio: ${mech}. Dificultad: ${lvl}.
- Respuesta: una sola palabra común del español, de 3 a 9 letras. No uses ninguna de estas: ${avoid.join(", ")}.
- Definición, indicador y relleno deben ser fragmentos copiados LITERALMENTE de la frase y no pueden solaparse. Si el relleno son varios trozos, sepáralos con " / ".
- "letras": la cadena exacta de letras (mayúsculas, sin tildes) que manipula el mecanismo. Ejemplos: anagrama de «cortas» → CORTAS; lectura al revés de «amarrar» (= ATAR) → ATAR; charada TOMA + TE → TOMATE; contenedor PAN dentro de CAMA → CAMAPAN.
- Antes de responder, comprueba letra a letra que el mecanismo da exactamente la respuesta.

Responde SOLO con este JSON:
{"clue":"frase sin el número de letras","a":"RESPUESTA","d":"definición","i":"indicador o cadena vacía","m":"relleno","mecanismo":"${mech}","letras":"LETRAS","ex":"Explicación breve, p. ej.: Anagrama. «Mal» indica que las letras de CORTAS están desordenadas: dan CASTOR, un roedor."}`;
}

async function askClaude(text) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: "user", content: text }] }),
  });
  if (!r.ok) throw new Error(`API de Claude: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const out = (data.content || []).map(c => c.text || "").join("");
  return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
}

const ymd = d => d.toISOString().slice(0, 10);

export default async () => {
  const t0 = Date.now();
  const fs = db();
  const [cr, pe] = await Promise.all([fs.collection("cryptics").get(), fs.collection("pending").get()]);
  if (pe.size >= MAX_PENDING) { console.log(`Hay ${pe.size} propuestas sin revisar: hoy no genero más.`); return; }

  const avoid = [...new Set([...SERIES, ...cr.docs.map(d => LT(d.get("a"))), ...pe.docs.map(d => LT(d.get("a")))])].filter(Boolean);
  const used = new Set([...cr.docs.map(d => d.get("date")), ...pe.docs.map(d => d.get("suggestedDate"))]);
  const day = new Date(); day.setUTCDate(day.getUTCDate() + 1);
  while (used.has(ymd(day))) day.setUTCDate(day.getUTCDate() + 1);

  // Dos intentos como máximo (las funciones programadas tienen 30 s)
  for (let attempt = 0; attempt < 2 && Date.now() - t0 < 13000; attempt++) {
    const mech = pick(MECHS), lvl = pick(LEVELS);
    try {
      const o = await askClaude(prompt(mech, lvl, avoid));
      const built = buildClue(o), chk = verify({ ...o, mecanismo: o.mecanismo || mech });
      if (built.errors.length || chk === "bad" || avoid.includes(LT(o.a))) {
        console.log("Descartado:", o.a, built.errors.join("; "), chk); continue;
      }
      await fs.collection("pending").add({
        clue: built.markup, a: LT(o.a), lvl, ex: String(o.ex || ""),
        mecanismo: o.mecanismo || mech, letras: LT(o.letras),
        suggestedDate: ymd(day), createdAt: Date.now(),
      });
      console.log(`Guardado ${LT(o.a)} (${mech}) para el ${ymd(day)}`);
      return;
    } catch (e) { console.log("Error:", e.message); }
  }
  console.log("Hoy no salió ninguna propuesta válida.");
};
