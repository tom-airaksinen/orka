/* Orka-push: skickar påminnelserna morgon och kväll.

   En webbapp kan inte väcka sig själv på en iPhone, så den här workern körs varje
   minut, tittar vilka prenumerationer som har sin tid just nu och skickar en
   pushnotis till dem. Den vet ingenting om dagboken, bara adressen till telefonens
   pushtjänst, de två klockslagen och vilket datum morgon respektive kväll senast fylldes i
   (så att påminnelsen kan utebli när frågan redan är besvarad).

   Lagring: en enda KV-nyckel "subs" med en lista. Appen har en användare, så en
   lista räcker och håller varje körning på en läsning. */

const MAX_SUBS = 5;
const PUSHVARDAR = ['.push.apple.com', '.googleapis.com', '.mozilla.com', '.notify.windows.com'];
const TID = /^([01]\d|2[0-3]):[0-5]\d$/;

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const utf8 = s => new TextEncoder().encode(s);
const ihop = (...delar) => {
  const ut = new Uint8Array(delar.reduce((n, d) => n + d.length, 0));
  let i = 0; for (const d of delar) { ut.set(d, i); i += d.length; }
  return ut;
};

/* ---------- VAPID: visar för pushtjänsten att det är vi som skickar ---------- */
async function vapid(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_JWK);
  const nyckel = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const huvud = b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const kropp = b64u(utf8(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUB
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, nyckel, utf8(`${huvud}.${kropp}`));
  return `vapid t=${huvud}.${kropp}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
}

/* ---------- Kryptering av innehållet (RFC 8291, aes128gcm) ---------- */
async function hkdf(salt, ikm, info, langd) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, langd * 8));
}
export async function kryptera(keys, text) {
  const mottagare = fromB64u(keys.p256dh), auth = fromB64u(keys.auth);
  const egen = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const egenPub = new Uint8Array(await crypto.subtle.exportKey('raw', egen.publicKey));
  const motNyckel = await crypto.subtle.importKey('raw', mottagare, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const delad = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: motNyckel }, egen.privateKey, 256));
  const ikm = await hkdf(auth, delad, ihop(utf8('WebPush: info\0'), mottagare, egenPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 efter texten markerar sista (och enda) posten
  const chiffer = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, ihop(utf8(text), new Uint8Array([2]))));
  return ihop(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([egenPub.length]), egenPub, chiffer);
}

async function skicka(env, sub, data) {
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapid(env, sub.endpoint),
      TTL: '3600',                       // en påminnelse som är över en timme sen är inte värd att leverera
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream'
    },
    body: await kryptera(sub.keys, JSON.stringify(data))
  });
  return r.status;
}

/* ---------- tid ---------- */
function lokalTid(ms, tz) {
  const d = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  return `${d.find(p => p.type === 'hour').value}:${d.find(p => p.type === 'minute').value}`;
}
const lokalDatum = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const giltigTz = tz => { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch (e) { return false; } };

/* ---------- http ---------- */
const lasSubs = async env => (await env.KV.get('subs', 'json')) || [];
const skrivSubs = (env, subs) => env.KV.put('subs', JSON.stringify(subs));

function giltigSub(s) {
  try {
    const u = new URL(s.endpoint);
    return u.protocol === 'https:' && PUSHVARDAR.some(v => u.hostname.endsWith(v))
      && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';
  } catch (e) { return false; }
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': env.TILLATEN_ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' };
    const svar = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return svar({ fel: 'bara POST' }, 405);
    if (origin !== env.TILLATEN_ORIGIN) return svar({ fel: 'fel avsändare' }, 403);

    let b; try { b = await req.json(); } catch (e) { return svar({ fel: 'ogiltig json' }, 400); }
    const vag = new URL(req.url).pathname;

    if (vag === '/prenumerera') {
      if (!giltigSub(b.sub || {}) || !TID.test(b.morgon) || !TID.test(b.kvall) || !giltigTz(b.tz)) return svar({ fel: 'ogiltiga uppgifter' }, 400);
      const ny = { endpoint: b.sub.endpoint, keys: { p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth }, morgon: b.morgon, kvall: b.kvall, tz: b.tz };
      const alla = await lasSubs(env), gammal = alla.find(s => s.endpoint === ny.endpoint);
      if (gammal && gammal.klar) ny.klar = gammal.klar;      // ändrad tid ska inte glömma att dagens fråga redan är besvarad
      const subs = alla.filter(s => s.endpoint !== ny.endpoint);
      subs.push(ny);
      await skrivSubs(env, subs.slice(-MAX_SUBS));
      return svar({ ok: true });
    }
    if (vag === '/avsluta') {
      const subs = await lasSubs(env);
      await skrivSubs(env, subs.filter(s => s.endpoint !== b.endpoint));
      return svar({ ok: true });
    }
    if (vag === '/ifyllt') {
      // Appen berättar att morgonens eller kvällens smärta är ifylld (eller borttagen igen, datum null).
      // Bara datumet lagras, aldrig själva värdet.
      if (!['morgon', 'kvall'].includes(b.slot) || !(b.datum === null || /^\d{4}-\d\d-\d\d$/.test(b.datum))) return svar({ fel: 'ogiltiga uppgifter' }, 400);
      const subs = await lasSubs(env), sub = subs.find(s => s.endpoint === b.endpoint);
      if (!sub) return svar({ fel: 'okänd prenumeration' }, 404);
      sub.klar = { ...sub.klar, [b.slot]: b.datum };
      await skrivSubs(env, subs);
      return svar({ ok: true });
    }
    if (vag === '/test') {
      // Bara till en prenumeration som redan finns, så att adressen inte kan användas för att skicka vart som helst
      const sub = (await lasSubs(env)).find(s => s.endpoint === b.endpoint);
      if (!sub) return svar({ fel: 'okänd prenumeration' }, 404);
      const status = await skicka(env, sub, { slot: 'test' });
      return svar({ ok: status >= 200 && status < 300, status });
    }
    return svar({ fel: 'okänd väg' }, 404);
  },

  /* Körs varje minut. Jämför mot den minut körningen var PLANERAD till, så att en
     körning som startar några sekunder sent ändå träffar rätt klockslag. Ingen
     "redan skickat"-flagga behövs då: varje minut inträffar en gång. */
  async scheduled(ev, env) {
    const subs = await lasSubs(env);
    const dod = new Set();
    await Promise.all(subs.map(async s => {
      const nu = lokalTid(ev.scheduledTime, s.tz);
      const slot = nu === s.morgon ? 'morgon' : nu === s.kvall ? 'kvall' : null;
      if (!slot) return;
      if (s.klar && s.klar[slot] === lokalDatum(ev.scheduledTime, s.tz)) return;   // redan ifyllt i dag: ingen påminnelse
      const status = await skicka(env, s, { slot }).catch(() => 0);
      if (status === 404 || status === 410) dod.add(s.endpoint);     // telefonen har sagt upp prenumerationen
    }));
    if (dod.size) await skrivSubs(env, subs.filter(s => !dod.has(s.endpoint)));
  }
};
