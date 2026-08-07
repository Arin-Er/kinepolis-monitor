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

function testEnv() {
  let state = null;
  return {
    STATE: {
      async get() {
        return state;
      },
      async put(_key, value) {
        state = JSON.parse(value);
      }
    },
    MOVIE_PAGE_URL: "https://example.com/the-odyssey",
    TARGET_CINEMA: "KBRU",
    TARGET_FORMAT_TOKENS: "IMAX,70mm",
    BASELINE_DATE: "2026-09-22",
    MANUAL_RUN_TOKEN: "test-secret"
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
