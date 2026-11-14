# Öppna frågor – Orka

## Innehåll
- [ ] Vilka set och reps gäller för de sex övningar som saknar det (enbensknäböj, säteslyft, töjning, knäböj mot boll, utfallskliv, kamelen)? Går att fylla i under Övningar.
- [ ] Ska appen varna när löpningen ökar för mycket från en vecka till nästa, och vilken gräns har sjukgymnasten i så fall gett? I dag visas bara minuter per vecka och skillnaden mot förra veckan.
- [x] Ska töjningen rotera med de andra eller göras efter varje pass? → **Svar:** Den roterar med de andra (2026-11-14)
- [x] Ska appen ha en intervalltimer för löpningen? → **Svar:** Nej, bara totalt antal minuter loggas (2026-11-14)

## Funktioner
- [x] Påminnelse morgon och kväll om att fylla i smärtan? → **Svar:** Ja, byggt som pushnotiser via en Cloudflare Worker (`push/`), tider ställs in under Övningar, standard 07:30 och 21:30 (2026-11-14)
- [x] Ska påminnelsen utebli om smärtan redan är ifylld för morgonen eller kvällen? → **Svar:** Ja, appen meddelar servern datumet när morgon eller kväll fylls i (2026-11-14)
- [ ] Räcker 0–10 för smärtan, eller behövs en fritextanteckning per dag?
- [ ] Ska en lista kunna skrivas ut eller delas med sjukgymnasten inför återbesök?

## Lagring
- [ ] Ska data säkerhetskopieras till Firebase? I dag ligger allt lokalt i telefonen, med manuell säkerhetskopia till fil under Övningar.
