# The Odyssey – Kinepolis IMAX 70mm-monitor

Deze monitor controleert automatisch de publieke Kinepolis-programmatie voor
**The Odyssey**. Zodra er in **Kinepolis Brussel** een nieuwe, boekbare sessie
na **22 september 2026** verschijnt met zowel `IMAX` als `70mm`, ontvang je een
Telegrammelding met de uren en rechtstreekse boekingslinks.

De oplossing gebruikt twee gratis onderdelen:

- een GitHub Action haalt ongeveer iedere vijf minuten de programmatie op;
- een Cloudflare Worker filtert de sessies, bewaart de toestand in KV en stuurt
  Telegrammeldingen.

Deze combinatie is nodig omdat de beveiliging voor de Kinepolis-API gewone
serverrequests op basis van hun TLS-profiel met HTTP 403 blokkeert. De GitHub
Action gebruikt daarom `curl_cffi` met een normale browserfingerprint.

Er hoeft geen computer permanent aan te blijven staan.

## Wat je nodig hebt

- een gratis Cloudflare-account;
- een gratis GitHub-account;
- Node.js 20 of nieuwer;
- Telegram op je gsm.

## 1. Project voorbereiden

Open PowerShell in deze projectmap en voer uit:

```powershell
npm.cmd install
npx.cmd wrangler login
```

## 2. Cloudflare KV-opslag maken

Maak één KV-namespace:

```powershell
npx.cmd wrangler kv namespace create KINEPOLIS_STATE
```

Vervang in `wrangler.jsonc` uitsluitend de `id` van de binding `STATE` door de
echte KV-id. Voeg geen tweede binding toe. De configuratie hoort zo te zijn:

```jsonc
"kv_namespaces": [
  {
    "binding": "STATE",
    "id": "<jouw echte KV-id>",
    "remote": true
  }
]
```

## 3. Telegrambot en chat-ID maken

1. Open in Telegram `@BotFather`.
2. Stuur `/newbot` en volg de stappen.
3. Bewaar de token die BotFather teruggeeft.
4. Open de nieuwe bot en stuur `/start` en daarna `Hallo`.
5. Voer in PowerShell uit:

```powershell
$telegramToken = Read-Host "Telegram bot token"
$updates = Invoke-RestMethod "https://api.telegram.org/bot$telegramToken/getUpdates"
$updates.result | ConvertTo-Json -Depth 10
```

De chat-ID staat bij `message.chat.id`. Je kunt de nieuwste rechtstreeks tonen:

```powershell
$updates.result[-1].message.chat.id
```

## 4. Cloudflare-secrets toevoegen

Voer deze opdrachten één voor één uit:

```powershell
npx.cmd wrangler secret put TELEGRAM_BOT_TOKEN
npx.cmd wrangler secret put TELEGRAM_CHAT_ID
npx.cmd wrangler secret put MANUAL_RUN_TOKEN
```

Maak voor `MANUAL_RUN_TOKEN` een willekeurige waarde:

```powershell
$runToken = [guid]::NewGuid().ToString("N")
$runToken
```

Plak die waarde bij de Wrangler-prompt en bewaar haar tijdelijk. Cloudflare kan
de waarde later niet opnieuw tonen.

## 5. Worker testen en deployen

```powershell
npm.cmd test
npx.cmd wrangler deploy
```

Registreer bij de eerste deployment desgevraagd een `workers.dev`-subdomein.
De Worker-URL voor deze installatie is:

```text
https://kinepolis-odyssey-monitor.odyssey-alerts.workers.dev
```

Test de Telegramverbinding:

```powershell
$workerUrl = "https://kinepolis-odyssey-monitor.odyssey-alerts.workers.dev"
$runToken = Read-Host "MANUAL_RUN_TOKEN"
$headers = @{ Authorization = "Bearer $runToken" }
Invoke-RestMethod -Method Post -Uri "$workerUrl/test-notification" -Headers $headers
```

## 6. GitHub Action activeren

1. Maak op GitHub een nieuwe **publieke** repository, bijvoorbeeld
   `kinepolis-odyssey-monitor`.
2. Upload de volledige inhoud van deze projectmap. De map
   `.github/workflows/monitor.yml` moet mee in de repository staan.
3. Open op GitHub **Settings → Secrets and variables → Actions**.
4. Kies **New repository secret**.
5. Gebruik als naam `MANUAL_RUN_TOKEN` en als waarde exact dezelfde token als
   bij Cloudflare.
6. Open **Actions → Kinepolis Odyssey monitor → Run workflow** en start de
   eerste controle.

Alleen de handmatige run-token staat als GitHub-secret. De Telegramtoken en
chat-ID blijven uitsluitend bij Cloudflare.

Een publieke repository gebruikt gratis standaard GitHub Actions-runners. Houd
er rekening mee dat geplande workflows in een openbaar repository na 60 dagen
zonder repositoryactiviteit automatisch kunnen worden uitgeschakeld. Voor deze
monitor valt de doelperiode binnen die termijn; controleer desondanks af en toe
of de Action nog groen draait.

## 7. Eindcontrole

Open na een geslaagde GitHub Action:

```text
https://kinepolis-odyssey-monitor.odyssey-alerts.workers.dev/status
```

Een gezonde toestand bevat onder andere:

```json
{
  "lastSource": "github-actions",
  "consecutiveFailures": 0,
  "lastError": null
}
```

Een handmatige programmatiecontrole start je voortaan met **Run workflow** op
GitHub. Het oude PowerShell-endpoint `POST /run` haalt zelf niets meer bij
Kinepolis op.

## Wat de monitor controleert

- `complexOperator = KBRU`;
- een publieke screening;
- sessiekenmerken met zowel `IMAX` als `70mm`;
- `businessDay > 2026-09-22`;
- `isSoldOut = false`;
- een nog niet eerder gemelde `vistaSessionId`.

De melding bevat de Belgische datum en tijd, het zaalnummer indien beschikbaar
en een rechtstreekse boekingslink.

## Frequentie en onderhoud

De planning staat in `.github/workflows/monitor.yml`:

```yaml
cron: "*/5 * * * *"
```

GitHub probeert hiermee ongeveer iedere vijf minuten te controleren. Geplande
runs kunnen bij drukte enkele minuten vertraging oplopen.

Na drie mislukte downloads stuurt de Worker één Telegramwaarschuwing. Zodra een
controle opnieuw slaagt, ontvang je een herstelmelding. Wanneer je tickets hebt,
kun je de workflow via de GitHub Actions-pagina uitschakelen.

Tijdens de testfase staat `DEBUG_NOTIFY_EVERY_SUCCESS` in `wrangler.jsonc` op
`"true"`. Daardoor stuurt ook iedere geslaagde controle zonder nieuwe datum een
Telegrambericht. Zet dit na de testfase op `"false"` en deploy de Worker opnieuw
om alleen nog echte nieuwe programmatie en fout/herstelmeldingen te ontvangen.

Geheimen horen nooit in broncode, `wrangler.jsonc`, screenshots of commits.

## Documentatie

- Cloudflare Workers: <https://developers.cloudflare.com/workers/>
- Cloudflare KV: <https://developers.cloudflare.com/kv/>
- GitHub Actions schedules: <https://docs.github.com/actions/using-workflows/events-that-trigger-workflows#schedule>
- Telegram Bot API: <https://core.telegram.org/bots/api>
