# Orka

Rehabdagbok som webbapp för iPhone. Föreslår styrkeövningar ur en roterande lista, tar emot löpning och annan träning, och frågar morgon och kväll hur ont det gör, så att smärtan kan jämföras med vad som gjordes dagarna innan.

Live: https://tom-airaksinen.github.io/orka/

## Så funkar den

- **Idag:** veckan som ett rutnät, smärta 0–10 morgon och kväll, fyra föreslagna styrkeövningar att bocka av, samt löpning (minuter), annan träning och stillasittande dag. Tryck på en dag i rutnätet för att fylla i den i efterhand.
- **Mönster:** smärta över fyra veckor med träningen markerad under, snittsmärta morgonen efter och två morgnar efter varje slags aktivitet, löpminuter per vecka och en dagbok.
- **Övningar:** ändra, lägg till och pausa övningar. Påminnelser morgon och kväll med valfria tider. Säkerhetskopia till fil.

Rotationen är en viktad slump: ju längre sedan en övning gjordes, desto oftare föreslås den (`foresla()` i `app.js`).

## Teknik

Ren HTML, CSS och JavaScript utan byggsteg. All data ligger i `localStorage` (nyckel `orka-v1`) i telefonen, ingen inloggning och ingen server.

- `index.html` – markup och CSS
- `app.js` – logik överst, rendering nederst
- `sw.js` – offline-cache, nätverket först för appens filer
- `test/kor.mjs` – `node test/kor.mjs`

## Påminnelser

En webbapp kan inte väcka sig själv på en iPhone, så notiserna skickas av en Cloudflare Worker i `push/` (`orka-push`). Den körs varje minut, jämför klockan med prenumerationernas två tider och skickar en krypterad pushnotis. Är morgonens eller kvällens smärta redan ifylld uteblir notisen. Den lagrar telefonens pushadress, klockslagen och vilket datum morgon respektive kväll senast fylldes i, men inga värden ur dagboken.

Driftsättning, från `push/`:

```
npx wrangler deploy
npx wrangler secret put VAPID_JWK < .vapid.jwk
```

`.vapid.jwk` är den privata nyckeln och ligger utanför git. Den publika halvan står i `push/wrangler.toml` (`VAPID_PUBLIC`) och i `app.js` (`PUSH_NYCKEL`) och måste vara samma på båda ställena.

## Deploy

Push till `main`, GitHub Pages bygger. Vid ändring: höj `APP_VERSION` i `app.js` och `CACHE` i `sw.js` till samma nummer. Det är det ändrade cachenamnet i `sw.js` som gör att telefonen upptäcker den nya versionen: appen frågar efter ny `sw.js` varje gång den kommer i förgrunden och laddar om sig själv när den nya tagit över, så länge inget formulär är öppet.

Öppna frågor finns i `docs/oppna-fragor.md`.
