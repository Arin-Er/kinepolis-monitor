import {
  buildNotification,
  extractTargetSessions,
  mergeNotifiedSessions,
  seedState,
  unseenBookableSessions
} from "./monitor.js";

const STATE_KEY = "odyssey-monitor-state-v1";

function configFromEnv(env) {
  return {
    moviePageUrl: env.MOVIE_PAGE_URL,
    targetCinema: env.TARGET_CINEMA ?? "KBRU",
    targetFormatTokens: env.TARGET_FORMAT_TOKENS ?? "IMAX,70mm",
    baselineDate: env.BASELINE_DATE ?? "2026-09-22"
  };
}

async function readState(env) {
  return env.STATE.get(STATE_KEY, { type: "json" });
}

async function writeState(env, state) {
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
}

async function sendTelegram(env, text, moviePageUrl) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Telegram secrets ontbreken.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[{ text: "Open The Odyssey bij Kinepolis", url: moviePageUrl }]]
        }
      })
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
      env.MOVIE_PAGE_URL
    );
  }
}

export async function processKinepolisPayload(env, payload) {
  const config = configFromEnv(env);
  const checkedAt = new Date().toISOString();

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
      await sendTelegram(env, buildNotification(newSessions), config.moviePageUrl);
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
    state.lastError = null;
    await writeState(env, state);

    if (recovered) {
      await sendTelegram(
        env,
        "✅ <b>Kinepolis-monitor werkt opnieuw</b>\n\nDe programmatie kon opnieuw succesvol gecontroleerd worden.",
        config.moviePageUrl
      );
    }

    return {
      ok: true,
      checkedAt,
      targetSessionCount: targetSessions.length,
      maxObservedTargetDate,
      newSessionCount: newSessions.length
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/status") {
      const state = await readState(env);
      return json({
        service: "kinepolis-odyssey-monitor",
        configuredBaseline: env.BASELINE_DATE,
        state
      });
    }

    if (url.pathname === "/ingest" && request.method === "POST") {
      if (!(await isAuthorized(request, env))) return json({ error: "Unauthorized" }, 401);

      try {
        const payload = await request.json();
        return json(await processKinepolisPayload(env, payload));
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
