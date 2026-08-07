const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function sessionsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;

  for (const key of ["sessions", "items", "documents", "results", "data"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }

  throw new Error("Onbekende Kinepolis-response: er werd geen sessielijst gevonden.");
}

function isoDate(value) {
  const candidate = typeof value === "string" ? value.slice(0, 10) : "";
  return DATE_PATTERN.test(candidate) ? candidate : null;
}

function sessionTime(showtime) {
  const parsed = new Date(showtime);
  if (Number.isNaN(parsed.getTime())) return "onbekend uur";

  return new Intl.DateTimeFormat("nl-BE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Brussels"
  }).format(parsed);
}

function hasEveryToken(value, tokens) {
  const normalized = String(value ?? "").toLocaleLowerCase("en-US");
  return tokens.every((token) => normalized.includes(token.toLocaleLowerCase("en-US")));
}

export function extractTargetSessions(payload, config) {
  const sessions = sessionsFromPayload(payload);
  const tokens = config.targetFormatTokens
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  return sessions
    .filter((session) => session?.documentType === "session")
    .filter((session) => session?.complexOperator === config.targetCinema)
    .filter((session) => session?.isPublicScreening !== false)
    .filter((session) => hasEveryToken(session?.rawSessionAttributes, tokens))
    .map((session) => {
      const date = isoDate(session.businessDay) ?? isoDate(session.showtime);
      const sessionId = String(session.vistaSessionId ?? "").trim();

      if (!date || !sessionId) return null;

      return {
        date,
        time: sessionTime(session.showtime),
        sessionId,
        soldOut: session.isSoldOut === true,
        hall: session.hall ?? null,
        rawSessionAttributes: session.rawSessionAttributes ?? "",
        bookingUrl: `https://kinepolis.be/nl/direct-vista-redirect/${encodeURIComponent(sessionId)}/0/${encodeURIComponent(config.targetCinema)}/0`
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const byDate = left.date.localeCompare(right.date);
      return byDate || left.time.localeCompare(right.time);
    });
}

export function unseenBookableSessions(sessions, state, baselineDate) {
  const notified = new Set(state.notifiedSessionIds ?? []);

  return sessions.filter(
    (session) =>
      session.date > baselineDate &&
      !session.soldOut &&
      !notified.has(session.sessionId)
  );
}

export function seedState(sessions, baselineDate) {
  return {
    baselineDate,
    lastNotifiedDate: baselineDate,
    notifiedSessionIds: sessions
      .filter((session) => session.date <= baselineDate)
      .map((session) => session.sessionId),
    maxObservedTargetDate: sessions.at(-1)?.date ?? null,
    lastCheckedAt: null,
    consecutiveFailures: 0,
    failureAlertSent: false
  };
}

export function mergeNotifiedSessions(state, sessions, checkedAt) {
  const notified = new Set(state.notifiedSessionIds ?? []);
  for (const session of sessions) notified.add(session.sessionId);

  const latestNewDate = sessions.reduce(
    (latest, session) => (session.date > latest ? session.date : latest),
    state.lastNotifiedDate
  );

  return {
    ...state,
    lastNotifiedDate: latestNewDate,
    notifiedSessionIds: [...notified].slice(-500),
    lastCheckedAt: checkedAt,
    consecutiveFailures: 0,
    failureAlertSent: false
  };
}

export function formatDate(date) {
  return new Intl.DateTimeFormat("nl-BE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Brussels"
  }).format(new Date(`${date}T12:00:00Z`));
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function buildNotification(sessions) {
  const grouped = new Map();

  for (const session of sessions) {
    const items = grouped.get(session.date) ?? [];
    items.push(session);
    grouped.set(session.date, items);
  }

  const sections = [...grouped.entries()].map(([date, items]) => {
    const links = items
      .map(
        (session) =>
          `• <a href="${escapeHtml(session.bookingUrl)}">${escapeHtml(session.time)}</a>` +
          (session.hall ? ` — zaal ${escapeHtml(session.hall)}` : "")
      )
      .join("\n");

    return `<b>${escapeHtml(formatDate(date))}</b>\n${links}`;
  });

  return [
    "🚨 <b>Nieuwe IMAX 70mm-programmatie!</b>",
    "",
    "The Odyssey — Kinepolis Brussel",
    "",
    ...sections,
    "",
    "Boek zo snel mogelijk; beschikbaarheid kan snel veranderen."
  ].join("\n");
}
