# The Odyssey – Kinepolis IMAX 70mm-monitor

Deze monitor controleert automatisch de publieke Kinepolis-programmatie voor
**The Odyssey**. Zodra er in **Kinepolis Brussel** een nieuwe, boekbare sessie
na **22 september 2026** verschijnt met zowel `IMAX` als `70mm`, ontvang je een
Telegrammelding met de uren en rechtstreekse boekingslinks.

Rond 12:00 Belgische tijd stuurt de monitor maximaal eenmaal per dag het stille,
knoploze chatbericht `het werkt nog`. Een echte nieuwe datum wordt daarentegen
met een opvallende alarmtekst en boekingsknop gemeld. Als er die dag al een
nieuwe-datummelding of herstelmelding kwam, vervangt die de dagelijkse check-in.

De oplossing gebruikt twee gratis diensten:

- een Cloudflare Cron Trigger geeft iedere vijf minuten het startsein;
- een GitHub Action haalt de programmatie op;
- de Cloudflare Worker filtert de sessies, bewaart de toestand in KV en stuurt
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
npx.cmd wrangler secret put GITHUB_ACTIONS_TOKEN
```

Maak voor `MANUAL_RUN_TOKEN` een willekeurige waarde:

```powershell
$runToken = [guid]::NewGuid().ToString("N")
$runToken
```

Plak die waarde bij de Wrangler-prompt en bewaar haar tijdelijk. Cloudflare kan
de waarde later niet opnieuw tonen.

Gebruik voor `GITHUB_ACTIONS_TOKEN` een fine-grained GitHub personal access
token die alleen toegang heeft tot `Arin-Er/kinepolis-monitor`, met repository-
permission **Actions: Read and write**. De Worker gebruikt dit token uitsluitend
om `monitor.yml` via `workflow_dispatch` te starten.

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

Een publieke repository gebruikt gratis standaard GitHub Actions-runners. De
planning zelf loopt bij Cloudflare; GitHub voert alleen de door Cloudflare
gestarte `workflow_dispatch`-runs uit.

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

Een handmatige programmatiecontrole start je met **Run workflow** op GitHub. De
automatische controles verschijnen met `cloudflare-cron` in hun runnaam en in
de tijdelijke Telegram-debugmelding. Het oude PowerShell-endpoint `POST /run`
haalt zelf niets meer bij Kinepolis op.

## Wat de monitor controleert

- `complexOperator = KBRU`;
- een publieke screening;
- sessiekenmerken met zowel `IMAX` als `70mm`;
- `businessDay > 2026-09-22`;
- `isSoldOut = false`;
- een nog niet eerder gemelde `vistaSessionId`.

De melding bevat de Belgische datum en tijd, het zaalnummer indien beschikbaar
en een rechtstreekse boekingslink.

Het tijdstip van de dagelijkse check-in staat in `wrangler.jsonc` als
`DAILY_HEARTBEAT_HOUR`. De waarde `"12"` betekent de eerste succesvolle controle
vanaf 12:00 in de tijdzone `Europe/Brussels`.

## Frequentie en onderhoud

De planning staat in `wrangler.jsonc`:

```jsonc
"triggers": {
  "crons": ["*/5 * * * *"]
}
```

Cloudflare start hiermee iedere vijf minuten de GitHub-workflow. Een nieuwe of
gewijzigde Cron Trigger kan volgens Cloudflare tot ongeveer 15 minuten nodig
hebben om wereldwijd actief te worden.

Na drie mislukte downloads stuurt de Worker één Telegramwaarschuwing. Zodra een
controle opnieuw slaagt, ontvang je een herstelmelding. Wanneer je tickets hebt,
kun je de workflow via de GitHub Actions-pagina uitschakelen.

`DEBUG_NOTIFY_EVERY_SUCCESS` staat normaal op `"false"`. Daardoor ontvang je
alleen echte nieuwe programmatie en fout/herstelmeldingen. Zet de variabele
tijdelijk op `"true"` en deploy opnieuw wanneer je iedere geslaagde controle met
een Telegrambericht wilt volgen tijdens debugging.

Geheimen horen nooit in broncode, `wrangler.jsonc`, screenshots of commits.

## Documentatie

- Cloudflare Workers: <https://developers.cloudflare.com/workers/>
- Cloudflare KV: <https://developers.cloudflare.com/kv/>
- GitHub workflow dispatch API: <https://docs.github.com/rest/actions/workflows#create-a-workflow-dispatch-event>
- Telegram Bot API: <https://core.telegram.org/bots/api>
