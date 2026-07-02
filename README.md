# 🌻 Kwiatki vs Zombiaki 🧟

Klon klasycznego *Plants vs Zombies* w jednym pliku HTML (canvas + vanilla JS), rozbudowany o autorskie mechaniki, żeby gra nie była nudna.

**Graj:** otwórz `index.html` w przeglądarce. Nic nie trzeba instalować.

## Mechaniki 1:1 z klasyki

- Siatka 5×9, słońce jako waluta (spada z nieba + produkują je słoneczniki)
- Karty roślin z kosztem i czasem odnowienia
- Kosiarki jako ostatnia linia obrony w każdym rzędzie
- Fale zombie o rosnącej trudności, ostatnia fala kończy grę zwycięstwem (10 fal)
- Rośliny: 🌻 Słonecznik · 🫛 Groszek · ❄️ Mrozak (spowalnia) · 🥜 Orzech · 🍒 Wiśnia (eksplozja 3×3)
- Zombie: zwykły · 🔺 ze stożkiem · 🪣 z wiadrem · 💨 biegacz

## Autorskie dodatki

- ⚡ **Tesla** — roślina rażąca łańcuchem błyskawic do 3 zombie naraz (po ulepszeniu 5)
- ⭐ **Ulepszanie roślin** — za 150 ☀️ wzmocnisz dowolną posadzoną roślinę (2× obrażenia / HP / produkcja)
- 🔥 **System combo** — szybkie zabójstwa jedno po drugim dają bonusowe słońce
- 🎁 **Power-upy** — zombie zostawiają czasem 💰 (+75 ☀️), 🧊 (zamrożenie wszystkich) lub 💣 (wybuch całej linii)
- 🎲 **Losowe wydarzenia** — Deszcz słońca ☀️, Szał hordy 🧟, Przeładowanie roślin ⚡ (2× szybkość strzelania)
- 👹 **Bossowie** — co 5 fal potężny boss (kosiarka go tylko rani!), po pokonaniu zrzuca 3 power-upy
- ♾️ **Tryb endless** — po zwycięstwie możesz grać dalej, fale skalują się w nieskończoność

## Sterowanie

- Kliknij kartę rośliny, potem pole na trawie, by ją posadzić
- Klikaj ☀️ i power-upy na planszy, by je zebrać
- 🪏 Łopata usuwa roślinę · ⭐ Ulepsz + klik na roślinę
- **PPM / Esc** — anuluj wybór · **P** — pauza
