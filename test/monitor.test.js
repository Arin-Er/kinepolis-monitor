import test from "node:test";
import assert from "node:assert/strict";

import {
  buildNotification,
  extractTargetSessions,
  seedState,
  unseenBookableSessions
} from "../src/monitor.js";

const config = {
  targetCinema: "KBRU",
  targetFormatTokens: "IMAX,70mm"
};

function rawSession(overrides = {}) {
  return {
    documentType: "session",
    complexOperator: "KBRU",
    showtime: "2026-09-22T11:30:00+00:00",
    businessDay: "2026-09-22T04:00:00+00:00",
    hall: 28,
    vistaSessionId: 391453,
    rawSessionAttributes: "2D,70mm,CineK,English,IMAX,IMAX W,Large film,nl",
    isPublicScreening: true,
    isSoldOut: false,
    ...overrides
  };
}

test("selecteert alleen publieke IMAX 70mm-sessies in Brussel", () => {
  const payload = [
    rawSession(),
    rawSession({ vistaSessionId: 2, rawSessionAttributes: "2D,IMAX" }),
    rawSession({ vistaSessionId: 3, complexOperator: "METRO" }),
    rawSession({ vistaSessionId: 4, isPublicScreening: false })
  ];

  const result = extractTargetSessions(payload, config);
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, "391453");
  assert.equal(result[0].date, "2026-09-22");
  assert.equal(result[0].time, "13:30");
});

test("eerste run negeert de bestaande programmatie tot en met 22 september", () => {
  const sessions = extractTargetSessions([rawSession()], config);
  const state = seedState(sessions, "2026-09-22");

  assert.deepEqual(state.notifiedSessionIds, ["391453"]);
  assert.deepEqual(unseenBookableSessions(sessions, state, "2026-09-22"), []);
});

test("vindt een nieuwe boekbare sessie na de grensdatum", () => {
  const sessions = extractTargetSessions(
    [
      rawSession(),
      rawSession({
        businessDay: "2026-09-23T04:00:00+00:00",
        showtime: "2026-09-23T19:00:00+00:00",
        vistaSessionId: 500001
      }),
      rawSession({
        businessDay: "2026-09-24T04:00:00+00:00",
        vistaSessionId: 500002,
        isSoldOut: true
      })
    ],
    config
  );
  const state = seedState(sessions, "2026-09-22");
  const newSessions = unseenBookableSessions(sessions, state, "2026-09-22");

  assert.deepEqual(newSessions.map((session) => session.sessionId), ["500001"]);
});

test("melding bevat datum, uur en directe boekingslink", () => {
  const sessions = extractTargetSessions(
    [
      rawSession({
        businessDay: "2026-09-23T04:00:00+00:00",
        showtime: "2026-09-23T19:00:00+00:00",
        vistaSessionId: 500001
      })
    ],
    config
  );
  const message = buildNotification(sessions);

  assert.match(message, /23 september 2026/);
  assert.match(message, /21:00/);
  assert.match(message, /direct-vista-redirect\/500001/);
});
