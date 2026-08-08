import {
  belgianDateForInstant,
  buildNotification,
  escapeHtml,
  extractTargetSessions,
  heartbeatDateIfDue,
  mergeNotifiedSessions,
  seedState,
  unseenBookableSessions
} from "./monitor.js";

const STATE_KEY = "odyssey-monitor-state-v1";
const DISPATCH_STATE_KEY = "odyssey-monitor-dispatch-v1";
const GITHUB_WORKFLOW_DISPATCH_URL =
  "https://api.github.com/repos/Arin-Er/kinepolis-monitor/actions/workflows/monitor.yml/dispatches";

function configuredHeartbeatHour(value) {
  const parsed = Number(value ?? "12");
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : 12;
}

function configFromEnv(env) {
  return {
    moviePageUrl: env.MOVIE_PAGE_URL,
    targetCinema: env.TARGET_CINEMA ?? "KBRU",
    targetFormatTokens: env.TARGET_FORMAT_TOKENS ?? "IMAX,70mm",
    baselineDate: env.BASELINE_DATE ?? "2026-09-22",
    debugNotifyEverySuccess: env.DEBUG_NOTIFY_EVERY_SUCCESS === "true",
    dailyHeartbeatHour: configuredHeartbeatHour(env.DAILY_HEARTBEAT_HOUR)
  };
}

function buildDebugSuccessNotification({
  checkedAt,
  targetSessionCount,
  maxObservedTargetDate,
  baselineDate,
  triggerSource
}) {
  return [
    "✅ <b>Controle geslaagd (debugmodus)</b>",
    "",
    `Tijdstip (UTC): <code>${escapeHtml(checkedAt)}</code>`,
    `Gestart door: <b>${escapeHtml(triggerSource)}</b>`,
    `Gevonden IMAX 70mm-sessies: <b>${targetSessionCount}</b>`,
    `Laatste gevonden datum: <b>${escapeHtml(maxObservedTargetDate ?? "geen")}</b>`,
    `Nieuwe sessies na ${escapeHtml(baselineDate)}: <b>0</b>`,
    "",
    "Er is geen nieuwe boekbare datum, maar de volledige controle is succesvol verwerkt."
  ].join("\n");
}

async function readState(env) {
  return env.STATE.get(STATE_KEY, { type: "json" });
}

async function writeState(env, state) {
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
}

async function readDispatchState(env) {
  return env.STATE.get(DISPATCH_STATE_KEY, { type: "json" });
}

async function writeDispatchState(env, state) {
  await env.STATE.put(DISPATCH_STATE_KEY, JSON.stringify(state));
}

async function sendTelegram(env, text, options = {}) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Telegram secrets ontbreken.");
  }

  const {
    moviePageUrl = env.MOVIE_PAGE_URL,
    buttonText = "Open The Odyssey bij Kinepolis",
    includeButton = true,
    silent = false
  } = options;

  const message = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    disable_notification: silent
  };

  if (includeButton) {
    message.reply_markup = {
      inline_keyboard: [[{ text: buttonText, url: moviePageUrl }]]
    };
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message)
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Telegrammelding mislukt (${response.status}): ${detail.slice(0, 300)}`);
  }
}

async function recordFailure(env, error) {
  const current = (await readState(env)) ?? {
    baselineDate: env.BASELINE_DATE ?? "2026-09-22",
    lastNotifiedDate: env.BASELINE_DATE ?? "2026-09-22",
    notifiedSessionIds: []
  };

  const failures = (current.consecutiveFailures ?? 0) + 1;
  const shouldAlert = failures === 3 && !current.failureAlertSent;
  const next = {
    ...current,
    consecutiveFailures: failures,
    failureAlertSent: current.failureAlertSent || shouldAlert,
    lastErrorAt: new Date().toISOString(),
    lastError: String(error?.message ?? error).slice(0, 500)
  };

  await writeState(env, next);

  if (shouldAlert) {
    await sendTelegram(
      env,
      `⚠️ <b>Kinepolis-monitor heeft een probleem</b>\n\nDrie controles na elkaar zijn mislukt.\n\n${String(error?.message ?? error)}`,
      { moviePageUrl: env.MOVIE_PAGE_URL }
    );
  }
}

export async function processKinepolisPayload(env, payload, metadata = {}) {
  const config = configFromEnv(env);
  const checkedAt = new Date(metadata.checkedAt ?? Date.now()).toISOString();
  const triggerSource = metadata.triggerSource ?? "unknown";

  try {
    const targetSessions = extractTargetSessions(payload, config);
    let state = await readState(env);

    if (!state) {
      state = seedState(targetSessions, config.baselineDate);
      await writeState(env, state);
    }

    const newSessions = unseenBookableSessions(
      targetSessions,
      state,
      config.baselineDate
    );

    const recovered = (state.consecutiveFailures ?? 0) >= 3 && state.failureAlertSent;
    const maxObservedTargetDate = targetSessions.at(-1)?.date ?? null;

    if (newSessions.length > 0) {
      await sendTelegram(env, buildNotification(newSessions), {
        moviePageUrl: config.moviePageUrl,
        buttonText: "🚨 BOEK NU — THE ODYSSEY 🚨"
      });
      state = mergeNotifiedSessions(state, newSessions, checkedAt);
    } else {
      state = {
        ...state,
        lastCheckedAt: checkedAt,
        consecutiveFailures: 0,
        failureAlertSent: false
      };
    }

    state.maxObservedTargetDate = maxObservedTargetDate;
    state.targetSessionCount = targetSessions.length;
    state.lastSource = "github-actions";
    state.lastTrigger = triggerSource;
    state.lastError = null;

    const debugNotificationSent =
      config.debugNotifyEverySuccess && newSessions.length === 0;

    if (debugNotificationSent) {
      await sendTelegram(
        env,
        buildDebugSuccessNotification({
          checkedAt,
          targetSessionCount: targetSessions.length,
          maxObservedTargetDate,
          baselineDate: config.baselineDate,
          triggerSource
        }),
        { moviePageUrl: config.moviePageUrl }
      );
    }

    if (recovered) {
      await sendTelegram(
        env,
        "✅ <b>Kinepolis-monitor werkt opnieuw</b>\n\nDe programmatie kon opnieuw succesvol gecontroleerd worden.",
        { moviePageUrl: config.moviePageUrl }
      );
    }

    const heartbeatDate = heartbeatDateIfDue(
      checkedAt,
      state.lastHeartbeatDate,
      config.dailyHeartbeatHour
    );
    const positiveMessageAlreadySent =
      newSessions.length > 0 || debugNotificationSent || recovered;
    const heartbeatSent = Boolean(heartbeatDate && !positiveMessageAlreadySent);

    if (heartbeatSent) {
      await sendTelegram(env, "het werkt nog", {
        includeButton: false,
        silent: true
      });
    }

    if (positiveMessageAlreadySent || heartbeatSent) {
      state.lastHeartbeatDate = positiveMessageAlreadySent
        ? belgianDateForInstant(checkedAt).date
        : heartbeatDate;
      state.lastHeartbeatAt = checkedAt;
    }

    await writeState(env, state);

    return {
      ok: true,
      checkedAt,
      targetSessionCount: targetSessions.length,
      maxObservedTargetDate,
      newSessionCount: newSessions.length,
      debugNotificationSent,
      heartbeatSent,
      triggerSource
    };
  } catch (error) {
    await recordFailure(env, error);
    throw error;
  }
}

async function tokenDigest(value) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

async function isAuthorized(request, env) {
  const expected = env.MANUAL_RUN_TOKEN;
  const received = request.headers.get("Authorization");
  if (!expected || !received?.startsWith("Bearer ")) return false;

  const [expectedDigest, receivedDigest] = await Promise.all([
    tokenDigest(expected),
    tokenDigest(received.slice("Bearer ".length))
  ]);

  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(expectedDigest, receivedDigest);
  }

  const expectedBytes = new Uint8Array(expectedDigest);
  const receivedBytes = new Uint8Array(receivedDigest);
  let mismatch = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    mismatch |= expectedBytes[index] ^ receivedBytes[index];
  }
  return mismatch === 0;
}

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function requestTriggerSource(request) {
  return (request.headers.get("X-Monitor-Trigger") ?? "unknown").slice(0, 80);
}

async function dispatchGitHubWorkflow(controller, env) {
  if (!env.GITHUB_ACTIONS_TOKEN) {
    throw new Error("Cloudflare-secret GITHUB_ACTIONS_TOKEN ontbreekt.");
  }

  const scheduledTime = new Date(controller.scheduledTime).toISOString();
  const previous = await readDispatchState(env);

  if (previous?.scheduledTime === scheduledTime) {
    controller.noRetry();
    return { ...previous, duplicateSkipped: true };
  }

  const dispatching = {
    ok: false,
    status: "dispatching",
    scheduledTime,
    cron: controller.cron,
    attemptedAt: new Date().toISOString()
  };
  await writeDispatchState(env, dispatching);

  const response = await fetch(GITHUB_WORKFLOW_DISPATCH_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "kinepolis-odyssey-monitor",
      "X-GitHub-Api-Version": "2026-03-10"
    },
    body: JSON.stringify({
      ref: "main",
      inputs: { trigger_source: "cloudflare-cron" }
    })
  });

  const responseText = await response.text();
  if (!response.ok) {
    const failed = {
      ...dispatching,
      status: "failed",
      failedAt: new Date().toISOString(),
      httpStatus: response.status,
      error: responseText.slice(0, 500)
    };
    await writeDispatchState(env, failed);
    throw new Error(
      `GitHub workflow kon niet worden gestart (HTTP ${response.status}): ${responseText.slice(0, 300)}`
    );
  }

  let responseBody = null;
  if (responseText) {
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // Een succesvolle 204 heeft geen body; andere succesvolle bodies zijn optioneel.
    }
  }

  const completed = {
    ok: true,
    status: "dispatched",
    scheduledTime,
    cron: controller.cron,
    dispatchedAt: new Date().toISOString(),
    githubRunId: responseBody?.workflow_run_id ?? null,
    githubRunUrl: responseBody?.html_url ?? null
  };
  await writeDispatchState(env, completed);
  return completed;
}

export default {
  async scheduled(controller, env) {
    try {
      const result = await dispatchGitHubWorkflow(controller, env);
      console.log(JSON.stringify({ event: "github_workflow_dispatch", ...result }));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "github_workflow_dispatch_failed",
          error: String(error?.message ?? error)
        })
      );
      await recordFailure(env, error);
      throw error;
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/status") {
      const [state, dispatcher] = await Promise.all([
        readState(env),
        readDispatchState(env)
      ]);
      return json({
        service: "kinepolis-odyssey-monitor",
        configuredBaseline: env.BASELINE_DATE,
        dailyHeartbeat: {
          hour: configuredHeartbeatHour(env.DAILY_HEARTBEAT_HOUR),
          timeZone: "Europe/Brussels"
        },
        state,
        dispatcher
      });
    }

    if (url.pathname === "/ingest" && request.method === "POST") {
      if (!(await isAuthorized(request, env))) return json({ error: "Unauthorized" }, 401);

      try {
        const payload = await request.json();
        return json(
          await processKinepolisPayload(env, payload, {
            triggerSource: requestTriggerSource(request)
          })
        );
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 502);
      }
    }

    if (url.pathname === "/report-failure" && request.method === "POST") {
      if (!(await isAuthorized(request, env))) return json({ error: "Unauthorized" }, 401);

      try {
        const body = await request.json();
        const detail = typeof body?.error === "string" ? body.error : "Onbekende fetchfout.";
        await recordFailure(env, new Error(`GitHub Actions: ${detail.slice(0, 400)}`));
        return json({ ok: true });
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 502);
      }
    }

    if (url.pathname === "/run" && request.method === "POST") {
      if (!(await isAuthorized(request, env))) return json({ error: "Unauthorized" }, 401);
      return json(
        {
          ok: false,
          error: "De programmatiecontrole wordt nu door GitHub Actions gestart. Gebruik daar 'Run workflow'."
        },
        410
      );
    }

    if (url.pathname === "/test-notification" && request.method === "POST") {
      if (!(await isAuthorized(request, env))) return json({ error: "Unauthorized" }, 401);

      try {
        await sendTelegram(
          env,
          "✅ <b>Testmelding geslaagd</b>\n\nJe Kinepolis-monitor kan meldingen naar deze chat sturen.",
          env.MOVIE_PAGE_URL
        );
        return json({ ok: true });
      } catch (error) {
        return json({ ok: false, error: String(error?.message ?? error) }, 502);
      }
    }

    return json({
      service: "kinepolis-odyssey-monitor",
      endpoints: [
        "GET /status",
        "POST /ingest",
        "POST /report-failure",
        "POST /test-notification"
      ]
    });
  }
};
