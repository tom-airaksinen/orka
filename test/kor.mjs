// node test/kor.mjs – testar logiken i app.js utan webbläsare
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const kod = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(kod, ctx);
const O = ctx.Orka;
let n = 0;
const test = (namn, fn) => { fn(); n++; console.log('ok  ' + namn); };
const lcg = seed => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

test('vecka och måndag', () => {
  assert.equal(O.monday('2026-11-14'), '2026-11-09');
  assert.equal(O.weekNo('2026-11-14'), 46);
  assert.equal(O.weekNo('2027-01-01'), 53);
  assert.equal(O.weekNo('2026-01-01'), 1);
  assert.equal(O.addDays('2026-10-25', 1), '2026-10-26');   // sommartidsbytet
});

test('förslaget ger fyra olika aktiva övningar', () => {
  const st = O.nyttLage();
  st.exercises[0].active = false;
  for (let s = 1; s < 200; s++) {
    const f = O.foresla(st, '2026-11-14', 4, [], lcg(s));
    assert.equal(f.length, 4);
    assert.equal(new Set(f).size, 4);
    assert.ok(!f.includes(st.exercises[0].id));
  }
});

test('gårdagens övningar kommer sällan igen', () => {
  const st = O.nyttLage();
  const igar = st.exercises.slice(0, 4).map(e => e.id);
  O.skrivDag(st, '2026-11-13', d => { d.done = igar; });
  let traffar = 0;
  for (let s = 1; s <= 500; s++) traffar += O.foresla(st, '2026-11-14', 4, [], lcg(s)).filter(id => igar.includes(id)).length;
  assert.ok(traffar / 500 < 0.3, `snitt ${traffar / 500} av gårdagens per pass`);
});

test('uteslutna övningar föreslås inte, och poolen kan ta slut', () => {
  const st = O.nyttLage();
  const alla = st.exercises.map(e => e.id);
  assert.deepEqual([...O.foresla(st, '2026-11-14', 1, alla)], []);
  assert.equal(O.foresla(st, '2026-11-14', 4, alla.slice(0, 8)).length, 2);
});

test('pass i veckan räknar dagar, inte övningar', () => {
  const st = O.nyttLage();
  O.skrivDag(st, '2026-11-09', d => { d.done = ['musslan', 'sidled', 'benlyft']; });
  O.skrivDag(st, '2026-11-11', d => { d.done = ['kamelen']; });
  O.skrivDag(st, '2026-11-08', d => { d.done = ['kamelen']; });   // söndagen före
  assert.equal(O.passIVeckan(st, '2026-11-14'), 2);
  assert.equal(O.senastePass(st, '2026-11-14'), '2026-11-11');
});

test('tom dag sparas inte', () => {
  const st = O.nyttLage();
  O.skrivDag(st, '2026-11-14', d => { d.pm = 3; });
  O.skrivDag(st, '2026-11-14', d => { d.pm = null; });
  assert.equal(Object.keys(st.days).length, 0);
  O.skrivDag(st, '2026-11-14', d => { d.pm = 0; });               // 0 är ett svar, inte tomt
  assert.equal(st.days['2026-11-14'].pm, 0);
});

test('mönster: morgonen efter och två morgnar efter', () => {
  const st = O.nyttLage();
  O.skrivDag(st, '2026-11-02', d => { d.entries.push({ type: 'run', min: 15 }); });
  O.skrivDag(st, '2026-11-03', d => { d.pm = 6; });
  O.skrivDag(st, '2026-11-04', d => { d.pm = 4; });
  O.skrivDag(st, '2026-11-05', d => { d.entries.push({ type: 'run', min: 20 }); d.entries.push({ type: 'other', label: 'Gym', min: null }); });
  O.skrivDag(st, '2026-11-06', d => { d.pm = 2; });
  const m = O.monster(st);
  const lop = m.find(r => r.namn === 'Löpning');
  assert.equal(lop.en, 4); assert.equal(lop.nEn, 2);
  assert.equal(lop.tva, 4); assert.equal(lop.nTva, 1);
  assert.equal(m.find(r => r.namn === 'Gym').en, 2);
  assert.ok(!m.find(r => r.namn === 'Styrkepass'));
  // 3 nov och 4 nov är vilodagar med smärta ifylld; morgonen efter dem är 4 resp. inget
  assert.equal(m.find(r => r.namn === 'Vilodag').nEn, 1);
});

test('löpning per vecka', () => {
  const st = O.nyttLage();
  O.skrivDag(st, '2026-11-03', d => { d.entries.push({ type: 'run', min: 10 }); });
  O.skrivDag(st, '2026-11-10', d => { d.entries.push({ type: 'run', min: 15 }); });
  O.skrivDag(st, '2026-11-12', d => { d.entries.push({ type: 'run', min: 15 }); });
  const v = O.lopVeckor(st, '2026-11-14', 3);
  assert.deepEqual([...v.map(x => x.min)], [0, 10, 30]);
  assert.deepEqual([...v.map(x => x.vecka)], [44, 45, 46]);
});

console.log(`\n${n} test gick igenom`);
