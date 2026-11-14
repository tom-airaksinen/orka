'use strict';
/* Orka – rehabdagbok. All data ligger i localStorage på telefonen.

   Filen har två halvor: ren logik överst (testas i test/kor.mjs utan webbläsare)
   och rendering nederst (körs bara när det finns ett document). */

const APP_VERSION = 5;
// Påminnelserna skickas av en Cloudflare Worker (se push/). Nyckeln är den publika halvan av
// VAPID-paret och ska vara samma som VAPID_PUBLIC i push/wrangler.toml.
const PUSH_URL = 'https://orka-push.tomairaksinen.workers.dev';
const PUSH_NYCKEL = 'BCIT3SHhWYrCyyyKmGxjCyqwNieh5C0iVsic5Rs-Jcnvl9jbp-LA4uq9dwzKsavnaPP77qnwPyuYGZVa7Sd1zsA';
const KEY = 'orka-v1';
const MAL_PASS = 3;        // styrkepass per vecka, enligt sjukgymnastens kort
const FORESLA = 4;         // övningar som föreslås per pass

const SEED = [
  ['musslan',   'Sidoliggande musslan med band ovan knä', '3 × 10'],
  ['sidled',    'Sidledsgång med band vid fotled (spänt band)', '15–20 steg × 4–6'],
  ['benlyft',   'Sidoliggande rakt benlyft, häl i vägg', '2 × 10'],
  ['maglyft',   'Magliggande benlyft ut åt sidan, båda ben', '2 × 10'],
  ['enben',     'Enbensknäböj, tryck andra sidan mot vägg', ''],
  ['sateslyft', 'Säteslyft med en fot på höjd', ''],
  ['tojning',   'Töjning: ryggliggande, höger fot på vänster knä, dra knät mot magen', ''],
  ['knaboj',    'Knäböj med rygg mot boll eller vägg (alt. smithmaskin)', ''],
  ['utfall',    'Utfallskliv bakåt med vikt (alt. smithmaskin)', ''],
  ['kamelen',   'Kamelen med vikt och gummiband', '']
];
const ANNAT_TYPER = ['Mountainbike', 'Gym', 'Karate', 'Cykling', 'Promenad', 'Vattenlöpning'];

function nyttLage() {
  return {
    v: 1,
    exercises: SEED.map(([id, name, dose]) => ({ id, name, dose, active: true })),
    days: {},
    types: ANNAT_TYPER.slice(),
    push: { on: false, morgon: '07:30', kvall: '21:30' }
  };
}

/* ---------- datum (lokala, som 'ÅÅÅÅ-MM-DD') ---------- */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / 864e5);
const monday = s => addDays(s, -((parse(s).getDay() + 6) % 7));
function weekNo(s) {
  const d = parse(s);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));       // torsdagen i samma vecka
  const jan4 = new Date(d.getFullYear(), 0, 4, 12);
  return 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

/* ---------- dagens innehåll ---------- */
const tomDag = () => ({ pm: null, pe: null, done: [], sug: null, entries: [] });
const dag = (st, date) => st.days[date] || tomDag();
function skrivDag(st, date, fn) {
  const d = st.days[date] || tomDag();
  fn(d);
  const tom = d.pm == null && d.pe == null && !d.done.length && !d.entries.length && !d.sug;
  if (tom) delete st.days[date]; else st.days[date] = d;
}
const minuter = (d, type) => d.entries.filter(e => e.type === type).reduce((s, e) => s + (e.min || 0), 0);
const har = (d, type) => d.entries.some(e => e.type === type);
const harStyrka = d => d.done.length > 0;
const arVila = d => !harStyrka(d) && !har(d, 'run') && !har(d, 'other') && !har(d, 'sit');

/* ---------- rotation ---------- */
function senastGjord(st, exId, fore) {
  let b = null;
  for (const k in st.days) if (k < fore && st.days[k].done.includes(exId) && (!b || k > b)) b = k;
  return b;
}
/* Slumpar n övningar, viktat så att det som gjordes längst sedan kommer oftare.
   Vikten är dagar sedan senast upphöjt till 1,5 – gårdagens övningar kan komma
   igen men gör det sällan. Aldrig gjorda räknas som 30 dagar. */
function foresla(st, date, n, uteslut = [], rnd = Math.random) {
  const pool = st.exercises.filter(e => e.active && !uteslut.includes(e.id)).map(e => {
    const s = senastGjord(st, e.id, date);
    const dagar = s ? Math.max(1, diffDays(date, s)) : 30;
    return { id: e.id, w: Math.pow(dagar, 1.5) };
  });
  const ut = [];
  while (ut.length < n && pool.length) {
    let r = rnd() * pool.reduce((s, p) => s + p.w, 0), i = 0;
    while (i < pool.length - 1 && (r -= pool[i].w) > 0) i++;
    ut.push(pool.splice(i, 1)[0].id);
  }
  return ut;
}
function passIVeckan(st, date) {
  const m = monday(date); let n = 0;
  for (let i = 0; i < 7; i++) if (harStyrka(dag(st, addDays(m, i)))) n++;
  return n;
}
function senastePass(st, fore) {
  let b = null;
  for (const k in st.days) if (k < fore && harStyrka(st.days[k]) && (!b || k > b)) b = k;
  return b;
}

/* ---------- mönster ---------- */
const snitt = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
/* Morgonsmärtan en respektive två dagar efter alla dagar som uppfyller villkoret. */
function efter(st, villkor) {
  const en = [], tva = [];
  for (const k in st.days) {
    if (!villkor(st.days[k], k)) continue;
    const a = dag(st, addDays(k, 1)).pm, b = dag(st, addDays(k, 2)).pm;
    if (a != null) en.push(a);
    if (b != null) tva.push(b);
  }
  return { en: snitt(en), nEn: en.length, tva: snitt(tva), nTva: tva.length };
}
function monster(st) {
  const rader = [
    ['Styrkepass', harStyrka],
    ['Löpning', d => har(d, 'run')],
    ['Stillasittande dag', d => har(d, 'sit')]
  ];
  const typer = new Set();
  for (const k in st.days) st.days[k].entries.forEach(e => { if (e.type === 'other') typer.add(e.label); });
  [...typer].sort().forEach(t => rader.push([t, d => d.entries.some(e => e.type === 'other' && e.label === t)]));
  // En vilodag räknas bara om något alls är ifyllt runt den, annars är varje tom dag "vila"
  rader.push(['Vilodag', (d, k) => arVila(d) && (d.pm != null || d.pe != null)]);
  return rader.map(([namn, v]) => ({ namn, ...efter(st, v) })).filter(r => r.nEn || r.nTva);
}
function perOvning(st) {
  return st.exercises.map(e => ({ namn: e.name, ...efter(st, d => d.done.includes(e.id)) }))
    .filter(r => r.nEn >= 3).sort((a, b) => b.en - a.en);
}
function lopVeckor(st, date, antal) {
  const ut = []; const m = monday(date);
  for (let w = antal - 1; w >= 0; w--) {
    const start = addDays(m, -7 * w); let min = 0, pass = 0;
    for (let i = 0; i < 7; i++) {
      const d = dag(st, addDays(start, i));
      min += minuter(d, 'run'); pass += d.entries.filter(e => e.type === 'run').length;
    }
    ut.push({ start, vecka: weekNo(start), min, pass });
  }
  return ut;
}

const Orka = { nyttLage, iso, parse, addDays, diffDays, monday, weekNo, dag, skrivDag, foresla,
  senastGjord, passIVeckan, senastePass, efter, monster, perOvning, lopVeckor, minuter, har, harStyrka };
if (typeof globalThis !== 'undefined') globalThis.Orka = Orka;

/* =====================================================================
   Rendering
   ===================================================================== */
if (typeof document !== 'undefined') (function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAGAR = ['mån', 'tis', 'ons', 'tors', 'fre', 'lör', 'sön'];
  const DAGAR_LANG = ['måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag', 'söndag'];
  const MAN = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
  const MAN_KORT = ['jan', 'feb', 'mars', 'apr', 'maj', 'juni', 'juli', 'aug', 'sep', 'okt', 'nov', 'dec'];
  const vd = s => (parse(s).getDay() + 6) % 7;
  const idag = () => iso(new Date());
  const tal = x => x.toFixed(1).replace('.', ',');

  let st = ladda();
  const ui = { vy: ({ '#monster': 'monster', '#ovningar': 'ovningar' })[location.hash] || 'idag', date: idag(), form: null, annatTyp: null, redigera: null, monsterSlut: null };

  function ladda() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.exercises && s.days) { s.push = s.push || nyttLage().push; return s; }
    } catch (e) { /* trasig eller tom lagring: börja om från fröet */ }
    return nyttLage();
  }
  function spara() {
    try { localStorage.setItem(KEY, JSON.stringify(st)); }
    catch (e) { alert('Det gick inte att spara. Telefonens lagring kan vara full.'); }
  }
  const ex = id => st.exercises.find(e => e.id === id);

  /* Smärtskalans färg: grön vid 0, gul vid 5, röd vid 10 */
  function smartFarg(n) {
    const steg = [[79, 157, 107], [217, 167, 46], [200, 71, 47]];
    const t = n / 5, a = steg[n < 5 ? 0 : 1], b = steg[n < 5 ? 1 : 2], f = n < 5 ? t : t - 1;
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(',')})`;
  }
  const smartStil = n => `background:${smartFarg(n)};color:${n >= 8 ? '#fff' : '#14201A'}`;

  /* ---------- Idag ---------- */
  function datumText(s) {
    const d = parse(s);
    return `${DAGAR_LANG[vd(s)]} ${d.getDate()} ${MAN[d.getMonth()]}`;
  }
  function relativ(s, ref) {
    const n = diffDays(ref, s);
    return n === 0 ? 'i dag' : n === 1 ? 'i går' : n === 2 ? 'i förrgår' : `för ${n} dagar sedan`;
  }

  function veckoRutnat() {
    const m = monday(ui.date), t = idag();
    const dgr = [...Array(7)].map((_, i) => addDays(m, i));
    const cell = (d, inne, extra = '') =>
      `<td class="${d === ui.date ? 'vald' : ''} ${d > t ? 'sen' : ''} ${extra}" ${d > t ? '' : `data-act="dag" data-d="${d}"`}>${inne}</td>`;
    const rad = (namn, fn) => `<tr><th scope="row">${namn}</th>${dgr.map(d => cell(d, fn(dag(st, d)))).join('')}</tr>`;
    const smarta = v => v == null ? '' : `<span class="sm" style="${smartStil(v)}">${v}</span>`;
    return `
    <div class="veckohuvud">
      <button class="pil" data-act="vecka" data-n="-1" aria-label="Föregående vecka">‹</button>
      <span>Vecka ${weekNo(m)}${ui.date === t ? '' : ` <button class="lank tillidag" data-act="dag" data-d="${t}">Till i dag</button>`}</span>
      <button class="pil" data-act="vecka" data-n="1" aria-label="Nästa vecka" ${m >= monday(t) ? 'disabled' : ''}>›</button>
    </div>
    <table class="kort">
      <thead><tr><th></th>${dgr.map(d => `<th scope="col" class="${d === ui.date ? 'vald' : ''} ${d === t ? 'nu' : ''} ${d > t ? 'sen' : ''}" ${d > t ? '' : `data-act="dag" data-d="${d}"`}>
        <span class="vd">${DAGAR[vd(d)][0].toUpperCase()}</span><span class="dn">${parse(d).getDate()}</span></th>`).join('')}</tr></thead>
      <tbody>
        ${rad('Styrka', d => d.done.length || '')}
        ${rad('Löpning', d => minuter(d, 'run') || (har(d, 'run') ? '×' : ''))}
        ${rad('Annat', d => har(d, 'other') ? '×' : '')}
        ${rad('Stilla', d => har(d, 'sit') ? '×' : '')}
        ${rad('Morgon', d => smarta(d.pm))}
        ${rad('Kväll', d => smarta(d.pe))}
      </tbody>
    </table>
    <p class="fot">Styrka visar antal övningar, löpning minuter. Tryck på en dag för att fylla i den.</p>`;
  }

  function smartRad(falt, etikett) {
    const v = dag(st, ui.date)[falt];
    return `<div class="smartrad"><span class="etikett">${etikett}</span><div class="skala" role="group" aria-label="${etikett}, 0 till 10">
      ${[...Array(11)].map((_, n) => `<button data-act="smarta" data-f="${falt}" data-n="${n}" aria-pressed="${v === n}"
        ${v === n ? `class="pa" style="${smartStil(n)}"` : ''}>${n}</button>`).join('')}</div></div>`;
  }

  function styrkeDel() {
    const t = idag(), arIdag = ui.date === t, d = dag(st, ui.date);
    let ids;
    if (arIdag) ids = [...new Set([...(d.sug || []), ...d.done])];
    else ids = st.exercises.filter(e => e.active || d.done.includes(e.id)).map(e => e.id);
    ids = ids.filter(ex);
    const n = passIVeckan(st, ui.date), sen = senastePass(st, ui.date);
    const lage = `${n} av ${MAL_PASS} pass den här veckan` + (sen ? `, senaste ${relativ(sen, ui.date)}` : '');
    const rader = ids.map(id => {
      const e = ex(id), gjord = d.done.includes(id), s = senastGjord(st, id, ui.date);
      return `<li class="${gjord ? 'gjord' : ''}">
        <button class="bock" data-act="bocka" data-id="${id}" aria-pressed="${gjord}" aria-label="${gjord ? 'Ångra' : 'Klar med'} ${esc(e.name)}"></button>
        <div class="ovn"><span class="namn">${esc(e.name)}</span>
          <span class="dos">${[e.dose && esc(e.dose), gjord ? '' : s ? 'senast ' + relativ(s, ui.date) : 'inte gjord tidigare'].filter(Boolean).join(', ')}</span></div>
        ${arIdag && !gjord ? `<button class="lank" data-act="byt" data-id="${id}">Byt</button>` : ''}
      </li>`;
    }).join('');
    return `<section>
      <h2>${arIdag ? 'Dagens styrka' : 'Styrka'}</h2>
      <p class="lage">${lage}</p>
      <ul class="ovningar">${rader}</ul>
      ${arIdag ? `<div class="knapprad"><button class="lank" data-act="slumpa">Slumpa nya</button>
        <button class="lank" data-act="entill">En övning till</button></div>` : ''}
    </section>`;
  }

  function annatDel() {
    const d = dag(st, ui.date);
    const lista = d.entries.map((e, i) => {
      const text = e.type === 'run' ? `Löpning${e.min ? `, ${e.min} min` : ''}`
        : e.type === 'sit' ? 'Mycket stillasittande'
        : `${esc(e.label)}${e.min ? `, ${e.min} min` : ''}`;
      return `<li><span>${text}</span><button class="lank" data-act="tabort" data-i="${i}">Ta bort</button></li>`;
    }).join('');
    const minChips = [10, 15, 20, 25, 30, 40].map(m => `<button class="chip" data-act="min" data-n="${m}">${m}</button>`).join('');
    let form = '';
    if (ui.form === 'run') form = `<div class="form">
        <label for="min">Hur många minuter totalt?</label>
        <div class="chips">${minChips}</div>
        <div class="inrad"><input id="min" type="number" inputmode="numeric" min="1" max="600" placeholder="min">
        <button class="primar" data-act="spararun">Spara löpning</button></div></div>`;
    if (ui.form === 'other') form = `<div class="form">
        <span class="etikett">Vad gjorde du?</span>
        <div class="chips">${st.types.map(t => `<button class="chip ${ui.annatTyp === t ? 'pa' : ''}" data-act="typ" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <input id="egen" type="text" placeholder="Eller skriv något annat" autocapitalize="sentences">
        <div class="inrad"><input id="min" type="number" inputmode="numeric" min="1" max="600" placeholder="min (valfritt)">
        <button class="primar" data-act="sparaannat">Spara</button></div></div>`;
    return `<section>
      <h2>${ui.date === idag() ? 'Annat i dag' : 'Annat den här dagen'}</h2>
      ${lista ? `<ul class="poster">${lista}</ul>` : ''}
      <div class="laggtill">
        <button class="sek ${ui.form === 'run' ? 'pa' : ''}" data-act="form" data-f="run">Löpning</button>
        <button class="sek ${ui.form === 'other' ? 'pa' : ''}" data-act="form" data-f="other">Annan träning</button>
        <button class="sek ${har(d, 'sit') ? 'pa' : ''}" data-act="sit" aria-pressed="${har(d, 'sit')}">Stillasittande dag</button>
      </div>${form}
    </section>`;
  }

  function vyIdag() {
    const t = idag(), arIdag = ui.date === t;
    return `
    <header class="topp"><h1>Orka</h1>
      <p class="datum">${datumText(ui.date)}</p></header>
    ${veckoRutnat()}
    <section>
      <h2>Hur ont gör höften?</h2>
      ${smartRad('pm', arIdag ? 'I morse' : 'Morgon')}
      ${smartRad('pe', arIdag ? 'I kväll' : 'Kväll')}
      <p class="fot">0 är ingen smärta, 10 är värsta tänkbara. Tryck på samma siffra igen för att ta bort.</p>
    </section>
    ${styrkeDel()}
    ${annatDel()}`;
  }

  /* ---------- Mönster ---------- */
  function diagram() {
    const N = 28, slut = ui.monsterSlut || idag(), start = addDays(slut, -(N - 1));
    const W = 340, V = 26, cw = (W - V - 4) / N, H = 110, top = 8;
    const x = i => V + cw * (i + .5), y = v => top + H - v / 10 * H;
    const rader = [['S', harStyrka], ['L', d => har(d, 'run')], ['A', d => har(d, 'other')], ['St', d => har(d, 'sit')]];
    let rutnat = '', linje = [], prickar = '', marken = '', datum = '';
    [0, 5, 10].forEach(v => rutnat += `<line class="r" x1="${V}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${V - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
    for (let i = 0; i < N; i++) {
      const k = addDays(start, i), d = dag(st, k);
      if (vd(k) === 0) {
        rutnat += `<line class="r" x1="${V + cw * i}" x2="${V + cw * i}" y1="${top}" y2="${top + H + 62}"/>`;
        datum += `<text class="ax" x="${V + cw * i + 2}" y="${top + H + 76}">${parse(k).getDate()} ${MAN_KORT[parse(k).getMonth()]}</text>`;
      }
      if (d.pm != null) { linje.push([x(i) - cw * .2, y(d.pm)]); prickar += `<circle class="pm" cx="${x(i) - cw * .2}" cy="${y(d.pm)}" r="3.2"/>`; }
      if (d.pe != null) { linje.push([x(i) + cw * .2, y(d.pe)]); prickar += `<circle class="pe" cx="${x(i) + cw * .2}" cy="${y(d.pe)}" r="3"/>`; }
      rader.forEach(([, fn], r) => { if (fn(d)) marken += `<rect class="m m${r}" x="${x(i) - cw * .34}" y="${top + H + 10 + r * 13}" width="${cw * .68}" height="8" rx="2"/>`; });
    }
    rader.forEach(([n], r) => rutnat += `<text class="ax" x="${V - 6}" y="${top + H + 18 + r * 13}" text-anchor="end">${n}</text>`);
    const nasta = addDays(slut, N) > idag() ? idag() : addDays(slut, N);
    return `<div class="veckohuvud">
        <button class="pil" data-act="period" data-d="${addDays(slut, -N)}" aria-label="Fyra veckor bakåt">‹</button>
        <span>${parse(start).getDate()} ${MAN_KORT[parse(start).getMonth()]} till ${parse(slut).getDate()} ${MAN_KORT[parse(slut).getMonth()]}</span>
        <button class="pil" data-act="period" data-d="${nasta}" aria-label="Fyra veckor framåt" ${slut >= idag() ? 'disabled' : ''}>›</button></div>
      <svg class="diagram" viewBox="0 0 ${W} ${top + H + 82}" role="img" aria-label="Smärta morgon och kväll de senaste fyra veckorna, med träning markerad under">
        ${rutnat}${linje.length > 1 ? `<polyline class="l" points="${linje.map(p => p.join(',')).join(' ')}"/>` : ''}${prickar}${marken}${datum}</svg>
      <p class="fot forkl"><span><i class="p pm"></i>morgon</span><span><i class="p pe"></i>kväll</span>
        <span>S styrka</span><span>L löpning</span><span>A annat</span><span>St stillasittande</span></p>`;
  }

  function vyMonster() {
    const harData = Object.keys(st.days).length > 0;
    if (!harData) return `<header class="topp"><h1>Mönster</h1></header>
      <p class="tomt">Här visas smärtan över tid bredvid det du har gjort. Fyll i hur höften känns morgon och kväll under Idag, så växer bilden fram.</p>`;
    const m = monster(st), po = perOvning(st), lv = lopVeckor(st, idag(), 8);
    const v = (x, n) => x == null ? '<span class="svag">–</span>' : `${tal(x)} <span class="svag">(${n})</span>`;
    const tabell = m.length ? `<table class="efter"><thead><tr><th></th><th>Morgonen efter</th><th>Två morgnar efter</th></tr></thead><tbody>
        ${m.map(r => `<tr><th scope="row">${esc(r.namn)}</th><td>${v(r.en, r.nEn)}</td><td>${v(r.tva, r.nTva)}</td></tr>`).join('')}</tbody></table>
        <p class="fot">Snittsmärta på morgonen, antal dagar inom parentes. Få dagar ger ett osäkert snitt, och flera saker samma dag går inte att skilja åt.</p>`
      : `<p class="tomt">Kommer när du har fyllt i morgonsmärta dagen efter något du loggat.</p>`;
    const maxMin = Math.max(1, ...lv.map(w => w.min));
    const lop = lv.some(w => w.min || w.pass) ? `<div class="staplar">${lv.map(w => `<div class="stapel"><span class="varde">${w.min || ''}</span>
        <div class="stolpe" style="height:${Math.round(w.min / maxMin * 72)}px"></div><span class="vnr">v${w.vecka}</span></div>`).join('')}</div>
        ${(() => { const a = lv[lv.length - 1], b = lv[lv.length - 2], skillnad = a.min - b.min;
          return `<p class="fot">Den här veckan ${a.min} min, förra ${b.min} min${b.min ? ` (${skillnad >= 0 ? '+' : '−'}${Math.abs(skillnad)} min)` : ''}.</p>`; })()}`
      : `<p class="tomt">Ingen löpning loggad de senaste åtta veckorna.</p>`;
    const dagbok = Object.keys(st.days).sort().reverse().slice(0, 21).map(k => {
      const d = st.days[k], bitar = [];
      if (d.done.length) bitar.push(`Styrka: ${d.done.map(id => ex(id) ? esc(ex(id).name) : '').filter(Boolean).join('; ')}`);
      d.entries.forEach(e => bitar.push(e.type === 'run' ? `Löpning${e.min ? ` ${e.min} min` : ''}` : e.type === 'sit' ? 'Mycket stillasittande' : `${esc(e.label)}${e.min ? ` ${e.min} min` : ''}`));
      if (!bitar.length && d.pm == null && d.pe == null) return '';
      const s = n => n == null ? '<span class="sm tom">–</span>' : `<span class="sm" style="${smartStil(n)}">${n}</span>`;
      return `<li><div class="dbhuvud"><button class="lank" data-act="oppna" data-d="${k}">${DAGAR[vd(k)]} ${parse(k).getDate()} ${MAN_KORT[parse(k).getMonth()]}</button>
        <span class="dbsm">${s(d.pm)}${s(d.pe)}</span></div>${bitar.length ? `<p>${bitar.join('. ')}.</p>` : ''}</li>`;
    }).join('');
    return `<header class="topp"><h1>Mönster</h1></header>
      <section><h2>Smärta och träning</h2>${diagram()}</section>
      <section><h2>Hur känns det efteråt?</h2>${tabell}</section>
      ${po.length ? `<section><h2>Per övning</h2><table class="efter"><thead><tr><th></th><th>Morgonen efter</th></tr></thead><tbody>
        ${po.map(r => `<tr><th scope="row">${esc(r.namn)}</th><td>${v(r.en, r.nEn)}</td></tr>`).join('')}</tbody></table></section>` : ''}
      <section><h2>Löpning per vecka</h2>${lop}</section>
      <section><h2>Dagbok</h2><ul class="dagbok">${dagbok}</ul></section>`;
  }

  /* ---------- Övningar ---------- */
  function vyOvningar() {
    const t = idag();
    const rad = e => {
      if (ui.redigera === e.id) return `<li class="redigerar"><div class="form">
        <label for="rn">Övning</label><textarea id="rn" rows="2">${esc(e.name)}</textarea>
        <label for="rd">Set och reps (valfritt)</label><input id="rd" type="text" value="${esc(e.dose)}" placeholder="t.ex. 3 × 10">
        <label class="kryss"><input id="ra" type="checkbox" ${e.active ? 'checked' : ''}> Med i rotationen</label>
        <div class="inrad"><button class="primar" data-act="sparaovn" data-id="${e.id}">Spara</button>
          <button class="lank" data-act="avbryt">Avbryt</button>
          <button class="lank fara" data-act="raderaovn" data-id="${e.id}">Ta bort</button></div></div></li>`;
      const s = senastGjord(st, e.id, addDays(t, 1));
      return `<li class="${e.active ? '' : 'pausad'}"><button class="ovnrad" data-act="redigera" data-id="${e.id}">
        <span class="namn">${esc(e.name)}</span>
        <span class="dos">${[e.dose && esc(e.dose), e.active ? '' : 'pausad', s ? 'senast ' + relativ(s, t) : 'inte gjord tidigare'].filter(Boolean).join(', ')}</span></button></li>`;
    };
    return `<header class="topp"><h1>Övningar</h1></header>
      <p class="lage">Appen föreslår ${FORESLA} av de här varje pass, oftast dem du inte gjort på ett tag. Tryck på en övning för att ändra den.</p>
      <ul class="ovnlista">${st.exercises.map(rad).join('')}</ul>
      ${ui.redigera === 'ny' ? `<div class="form">
        <label for="rn">Ny övning</label><textarea id="rn" rows="2"></textarea>
        <label for="rd">Set och reps (valfritt)</label><input id="rd" type="text" placeholder="t.ex. 3 × 10">
        <div class="inrad"><button class="primar" data-act="sparaovn" data-id="ny">Lägg till</button><button class="lank" data-act="avbryt">Avbryt</button></div></div>`
        : `<button class="sek" data-act="redigera" data-id="ny">Lägg till övning</button>`}
      <section><h2>Påminnelser</h2>
        <p class="lage">En notis morgon och kväll som frågar hur höften känns. Har du redan fyllt i kommer ingen notis.</p>
        <label class="kryss"><input type="checkbox" role="switch" class="vaxel" id="pushpa" ${st.push.on ? 'checked' : ''}> Påminn mig morgon och kväll</label>
        <div class="tider">
          <label>Morgon<input type="time" id="tid-morgon" value="${st.push.morgon}"></label>
          <label>Kväll<input type="time" id="tid-kvall" value="${st.push.kvall}"></label>
        </div>
        ${st.push.on ? `<button class="lank" data-act="pushtest">Skicka en testnotis</button>` : ''}
        ${ui.pushMsg ? `<p class="fot" role="status">${esc(ui.pushMsg)}</p>` : ''}
      </section>
      <section><h2>Säkerhetskopia</h2>
        <p class="lage">Allt sparas bara i den här telefonen. Spara en kopia då och då, så finns dagboken kvar om telefonen byts eller webbläsardata rensas.</p>
        <div class="laggtill"><button class="sek" data-act="export">Spara kopia</button>
          <label class="sek filknapp">Läs in kopia<input type="file" id="importfil" accept="application/json,.json" hidden></label></div>
      </section>
      <p class="fot version">Orka version ${APP_VERSION}</p>`;
  }

  /* ---------- ram ---------- */
  function rita() {
    $('#vy').innerHTML = ui.vy === 'idag' ? vyIdag() : ui.vy === 'monster' ? vyMonster() : vyOvningar();
    document.querySelectorAll('nav button').forEach(b => b.setAttribute('aria-current', b.dataset.vy === ui.vy ? 'page' : 'false'));
  }
  function sakraForslag() {
    const t = idag();
    if (!dag(st, t).sug) { skrivDag(st, t, d => { d.sug = foresla(st, t, FORESLA, d.done); }); spara(); }
  }
  const minVarde = () => { const v = parseInt(($('#min') || {}).value, 10); return v > 0 && v <= 600 ? v : null; };

  /* ---------- påminnelser ---------- */
  const nyckelBytes = () => Uint8Array.from(atob(PUSH_NYCKEL.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  async function pushPost(vag, kropp) {
    const r = await fetch(PUSH_URL + vag, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(kropp) })
      .catch(() => { throw new Error('Det gick inte att nå påminnelsetjänsten. Kontrollera att telefonen har nät och försök igen.'); });
    if (!r.ok) throw new Error('Påminnelsetjänsten svarade inte som väntat. Försök igen om en stund.');
    return r.json();
  }
  async function pushReg() {
    // ready löser aldrig ut om service workern saknas, så vänta inte för evigt
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(r, 6000))]);
    if (!reg) throw new Error('Appen är inte färdigladdad. Stäng den, öppna den igen och försök en gång till.');
    return reg;
  }
  async function pushSynka() {
    const reg = await pushReg();
    const sub = await reg.pushManager.getSubscription()
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: nyckelBytes() });
    await pushPost('/prenumerera', { sub: sub.toJSON(), morgon: st.push.morgon, kvall: st.push.kvall,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    return sub;
  }
  async function pushPa() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
      throw new Error('Notiser fungerar bara när Orka ligger på hemskärmen. Öppna sidan i Safari, tryck på dela-knappen, välj "Lägg till på hemskärmen" och öppna appen därifrån.');
    // Måste anropas direkt i tryckningen, annars visar iOS aldrig frågan
    if (await Notification.requestPermission() !== 'granted')
      throw new Error('Notiser är avstängda för Orka. Slå på dem i telefonens Inställningar under Notiser och Orka, och försök igen.');
    await pushSynka();
  }
  async function pushAv() {
    const reg = await pushReg(), sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await pushPost('/avsluta', { endpoint: sub.endpoint }).catch(() => {});   // telefonen slutar ta emot även om servern inte nås
    await sub.unsubscribe();
  }
  const pushKlar = msg => { ui.pushMsg = msg; spara(); rita(); };

  const AKT = {
    pushtest() {
      pushSynka().then(sub => pushPost('/test', { endpoint: sub.endpoint }))
        .then(r => pushKlar(r.ok ? 'Testnotisen är skickad och bör dyka upp inom några sekunder.' : `Telefonens pushtjänst tog inte emot notisen (svar ${r.status}). Slå av och på påminnelserna och försök igen.`))
        .catch(e => pushKlar(e.message));
      return false;
    },
    dag(b) { ui.date = b.dataset.d; ui.form = null; },
    oppna(b) { ui.date = b.dataset.d; ui.vy = 'idag'; ui.form = null; scrollTo(0, 0); },
    vecka(b) {
      const d = addDays(ui.date, 7 * b.dataset.n), t = idag();
      ui.date = d > t ? t : d; ui.form = null;
    },
    period(b) { ui.monsterSlut = b.dataset.d >= idag() ? null : b.dataset.d; },
    smarta(b) {
      const n = +b.dataset.n, f = b.dataset.f;
      skrivDag(st, ui.date, d => { d[f] = d[f] === n ? null : n; });
      // Säg till påminnelsetjänsten, så att dagens notis uteblir när frågan redan är besvarad.
      // Misslyckas det (inget nät) kommer notisen ändå, vilket är det ofarliga felet.
      if (st.push.on && ui.date === idag()) {
        const datum = dag(st, ui.date)[f] == null ? null : ui.date;
        pushReg().then(r => r.pushManager.getSubscription())
          .then(s => s && pushPost('/ifyllt', { endpoint: s.endpoint, slot: f === 'pm' ? 'morgon' : 'kvall', datum })).catch(() => {});
      }
    },
    bocka(b) {
      const id = b.dataset.id;
      skrivDag(st, ui.date, d => { d.done = d.done.includes(id) ? d.done.filter(x => x !== id) : [...d.done, id]; });
    },
    byt(b) {
      const id = b.dataset.id;
      skrivDag(st, ui.date, d => {
        const ny = foresla(st, ui.date, 1, [...(d.sug || []), ...d.done]);
        if (ny.length) d.sug = d.sug.map(x => x === id ? ny[0] : x);
      });
    },
    slumpa() {
      skrivDag(st, ui.date, d => {
        const kvar = Math.max(0, FORESLA - d.done.length);
        // Hellre helt nya än de som just visades, men finns det för få får de gamla komma igen
        let nya = foresla(st, ui.date, kvar, [...d.done, ...(d.sug || [])]);
        if (nya.length < kvar) nya = nya.concat(foresla(st, ui.date, kvar - nya.length, [...d.done, ...nya]));
        d.sug = [...d.done, ...nya];
      });
    },
    entill() { skrivDag(st, ui.date, d => { d.sug = [...(d.sug || []), ...foresla(st, ui.date, 1, [...(d.sug || []), ...d.done])]; }); },
    form(b) { ui.form = ui.form === b.dataset.f ? null : b.dataset.f; ui.annatTyp = null; },
    min(b) { $('#min').value = b.dataset.n; return false; },
    typ(b) { ui.annatTyp = ui.annatTyp === b.dataset.t ? null : b.dataset.t; const e = $('#egen'); if (e) e.value = ''; },
    spararun() {
      const m = minVarde();
      if (!m) { $('#min').focus(); return false; }
      skrivDag(st, ui.date, d => d.entries.push({ type: 'run', min: m })); ui.form = null;
    },
    sparaannat() {
      const egen = $('#egen').value.trim(), label = egen || ui.annatTyp;
      if (!label) { $('#egen').focus(); return false; }
      if (egen && !st.types.some(t => t.toLowerCase() === egen.toLowerCase())) st.types.push(egen);
      const m = minVarde();
      skrivDag(st, ui.date, d => d.entries.push({ type: 'other', label, min: m })); ui.form = null; ui.annatTyp = null;
    },
    sit() {
      skrivDag(st, ui.date, d => { d.entries = har(d, 'sit') ? d.entries.filter(e => e.type !== 'sit') : [...d.entries, { type: 'sit' }]; });
    },
    tabort(b) { skrivDag(st, ui.date, d => d.entries.splice(+b.dataset.i, 1)); },
    redigera(b) { ui.redigera = b.dataset.id; },
    avbryt() { ui.redigera = null; },
    sparaovn(b) {
      const name = $('#rn').value.trim().replace(/\s+/g, ' '), dose = $('#rd').value.trim();
      if (!name) { $('#rn').focus(); return false; }
      if (b.dataset.id === 'ny') st.exercises.push({ id: 'x' + Date.now().toString(36), name, dose, active: true });
      else Object.assign(ex(b.dataset.id), { name, dose, active: $('#ra').checked });
      ui.redigera = null;
    },
    raderaovn(b) {
      const e = ex(b.dataset.id);
      const anvand = Object.values(st.days).some(d => d.done.includes(e.id));
      // En övning som finns i dagboken pausas i stället, annars tappar gamla pass sitt innehåll
      if (anvand) { if (!confirm(`"${e.name}" finns i dagboken och pausas därför i stället för att tas bort. Pausa?`)) return false; e.active = false; }
      else { if (!confirm(`Ta bort "${e.name}"?`)) return false; st.exercises = st.exercises.filter(x => x !== e); }
      for (const k in st.days) if (st.days[k].sug) st.days[k].sug = st.days[k].sug.filter(id => id !== e.id || st.days[k].done.includes(id));
      ui.redigera = null;
    },
    export() {
      const namn = `orka-${idag()}.json`, text = JSON.stringify(st, null, 1);
      const fil = new File([text], namn, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [fil] })) navigator.share({ files: [fil] }).catch(() => {});
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(fil); a.download = namn; a.click(); }
      return false;
    }
  };

  document.addEventListener('click', ev => {
    const nav = ev.target.closest('nav button');
    if (nav) { ui.vy = nav.dataset.vy; ui.form = null; ui.redigera = null; ui.pushMsg = null; if (ui.vy === 'idag') sakraForslag(); rita(); scrollTo(0, 0); return; }
    const b = ev.target.closest('[data-act]');
    if (!b || b.disabled) return;
    if (AKT[b.dataset.act](b) === false) return;
    spara(); rita();
  });
  document.addEventListener('change', ev => {
    const el = ev.target;
    if (el.id === 'pushpa') {
      const pa = el.checked;
      (pa ? pushPa() : pushAv()).then(() => { st.push.on = pa; pushKlar(pa ? `Påminnelser på: ${st.push.morgon} och ${st.push.kvall}.` : 'Påminnelserna är avstängda.'); })
        .catch(e => { st.push.on = pa ? false : st.push.on; pushKlar(e.message); });
      return;
    }
    if (el.id === 'tid-morgon' || el.id === 'tid-kvall') {
      if (!/^\d\d:\d\d$/.test(el.value)) return;
      st.push[el.id === 'tid-morgon' ? 'morgon' : 'kvall'] = el.value; spara();
      if (st.push.on) pushSynka().then(() => pushKlar(`Påminnelser på: ${st.push.morgon} och ${st.push.kvall}.`)).catch(e => pushKlar(e.message));
      return;
    }
    if (ev.target.id !== 'importfil' || !ev.target.files[0]) return;
    ev.target.files[0].text().then(t => {
      const ny = JSON.parse(t);
      if (!ny || !Array.isArray(ny.exercises) || typeof ny.days !== 'object') throw new Error('fel format');
      if (!confirm(`Kopian innehåller ${Object.keys(ny.days).length} dagar. Den ersätter allt som finns i appen nu. Läs in?`)) return;
      ny.push = st.push; st = ny; st.types = st.types || ANNAT_TYPER.slice(); spara(); rita();   // påminnelserna hör till telefonen, inte till kopian
    }).catch(() => alert('Filen gick inte att läsa. Välj en kopia som sparats från Orka.'));
  });
  // Appen ligger ofta öppen över natten: byt till rätt dag när den tas fram igen
  let settDag = idag();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || idag() === settDag) return;
    settDag = idag(); ui.date = settDag; ui.form = null; sakraForslag(); rita();
  });

  // Tryck på en påminnelse: service workern ber appen visa dagens datum i Idag-vyn
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', ev => {
    if (!ev.data || ev.data.typ !== 'idag') return;
    settDag = idag(); ui.vy = 'idag'; ui.date = settDag; ui.form = null; ui.redigera = null;
    sakraForslag(); rita(); scrollTo(0, 0);
  });

  sakraForslag();
  rita();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
})();
