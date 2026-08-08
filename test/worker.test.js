import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

function rawSession() {
  return {
    documentType: "session",
    complexOperator: "KBRU",
    showtime: "2026-09-22T11:30:00+00:00",
    businessDay: "2026-09-22T04:00:00+00:00",
    hall: 28,
    vistaSessionId: 391453,
    rawSessionAttributes: "2D,70mm,CineK,English,IMAX,IMAX W,Large film,nl",
    isPublicScreening: true,
    isSoldOut: false
  };
}

function testEnv(overrides = {}) {
  const state = new Map();
  return {
    STATE: {
      async get(key) {
        return state.get(key) ?? null;
      },
      async put(key, value) {
        state.set(key, JSON.parse(value));
      }
    },
    MOVIE_PAGE_URL: "https://example.com/the-odyssey",
    TARGET_CINEMA: "KBRU",
    TARGET_FORMAT_TOKENS: "IMAX,70mm",
    BASELINE_DATE: "2026-09-22",
    MANUAL_RUN_TOKEN: "test-secret",
    ...overrides
  };
}

test("geauthenticeerde GitHub-ingest verwerkt de programmatie", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/ingest", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-secret",
        "Content-Type": "application/json"
      },
      body: JSON.stringify([rawSession()])
    }),
    testEnv()
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.targetSessionCount, 1);
  assert.equal(body.maxObservedTargetDate, "2026-09-22");
});

test("ingest weigert een ongeldige token", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/ingest", {
      method: "POST",
      headers: {
        Authorization: "Bearer verkeerd",
        "Content-Type": "application/json"
      },
      body: "[]"
    }),
    testEnv()
  );

  assert.equal(response.status, 401);
});

test("debugmodus stuurt Telegram na een succesvolle controle zonder nieuwe sessie", async () => {
  const originalFetch = globalThis.fetch;
  const telegramRequests = [];

  globalThis.fetch = async (url, options) => {
    telegramRequests.push({ url, options });
    return Response.json({ ok: true });
  };

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/ingest", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-secret",
          "Content-Type": "application/json",
          "X-Monitor-Trigger": "cloudflare-cron"
        },
        body: JSON.stringify([rawSession()])
      }),
      testEnv({
        DEBUG_NOTIFY_EVERY_SUCCESS: "true",
        TELEGRAM_BOT_TOKEN: "test-bot-token",
        TELEGRAM_CHAT_ID: "123"
      })
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.newSessionCount, 0);
    assert.equal(body.debugNotificationSent, true);
    assert.equal(body.triggerSource, "cloudflare-cron");
    assert.equal(telegramRequests.length, 1);

    const telegramBody = JSON.parse(telegramRequests[0].options.body);
    assert.match(telegramBody.text, /Controle geslaagd/);
    assert.match(telegramBody.text, /geen nieuwe boekbare datum/);
    assert.match(telegramBody.text, /cloudflare-cron/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Cloudflare-cron start de GitHub-workflow slechts eenmaal per tijdstip", async () => {
  const originalFetch = globalThis.fetch;
  const githubRequests = [];
  const env = testEnv({ GITHUB_ACTIONS_TOKEN: "github-test-token" });
  let noRetryCalls = 0;
  const controller = {
    scheduledTime: Date.parse("2026-08-08T10:00:00.000Z"),
    cron: "*/5 * * * *",
    noRetry() {
      noRetryCalls += 1;
    }
  };

  globalThis.fetch = async (url, options) => {
    githubRequests.push({ url, options });
    return Response.json({
      workflow_run_id: 123,
      html_url: "https://github.com/Arin-Er/kinepolis-monitor/actions/runs/123"
    });
  };

  try {
    await worker.scheduled(controller, env);
    await worker.scheduled(controller, env);

    assert.equal(githubRequests.length, 1);
    assert.equal(noRetryCalls, 1);
    assert.match(String(githubRequests[0].url), /actions\/workflows\/monitor\.yml\/dispatches$/);
    assert.equal(githubRequests[0].options.method, "POST");
    assert.equal(
      githubRequests[0].options.headers.Authorization,
      "Bearer github-test-token"
    );
    assert.deepEqual(JSON.parse(githubRequests[0].options.body), {
      ref: "main",
      inputs: { trigger_source: "cloudflare-cron" }
    });

    const status = await worker.fetch(
      new Request("https://worker.example/status"),
      env
    );
    const body = await status.json();
    assert.equal(body.dispatcher.ok, true);
    assert.equal(body.dispatcher.scheduledTime, "2026-08-08T10:00:00.000Z");
    assert.equal(body.dispatcher.githubRunId, 123);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
