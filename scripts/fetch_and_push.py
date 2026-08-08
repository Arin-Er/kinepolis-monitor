"""Fetch Kinepolis with a browser TLS fingerprint and forward it to the Worker."""

from __future__ import annotations

import os
import sys
from typing import Any

from curl_cffi import requests


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Ontbrekende omgevingsvariabele: {name}")
    return value


def worker_post(
    session: requests.Session,
    worker_url: str,
    path: str,
    token: str,
    payload: Any,
) -> requests.Response:
    return session.post(
        f"{worker_url.rstrip('/')}{path}",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
        timeout=30,
    )


def report_fetch_failure(
    session: requests.Session, worker_url: str, token: str, error: Exception
) -> None:
    try:
        response = worker_post(
            session,
            worker_url,
            "/report-failure",
            token,
            {"error": str(error)[:400]},
        )
        if not response.ok:
            print(
                f"Waarschuwing: foutmelding kon niet worden geregistreerd "
                f"(HTTP {response.status_code}).",
                file=sys.stderr,
            )
    except Exception as report_error:  # noqa: BLE001 - failure reporting must not hide root cause
        print(
            f"Waarschuwing: foutmelding kon niet worden verstuurd: {report_error}",
            file=sys.stderr,
        )


def main() -> int:
    api_url = required_env("KINEPOLIS_API_URL")
    worker_url = required_env("WORKER_URL")
    token = required_env("MANUAL_RUN_TOKEN")
    trigger_source = (
        os.environ.get("MONITOR_TRIGGER_SOURCE", "unknown").strip() or "unknown"
    )
    session = requests.Session(impersonate="chrome")
    session.headers.update({"X-Monitor-Trigger": trigger_source[:80]})

    try:
        response = session.get(
            api_url,
            headers={
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.8",
                "Origin": "https://kinepolis.be",
                "Referer": "https://kinepolis.be/",
            },
            timeout=30,
        )
        if response.status_code != 200:
            raise RuntimeError(f"Kinepolis API gaf HTTP {response.status_code}.")

        payload = response.json()
        if not isinstance(payload, (list, dict)):
            raise RuntimeError("Kinepolis API gaf geen sessielijst terug.")
    except Exception as error:  # noqa: BLE001 - report any network/JSON failure to the Worker
        report_fetch_failure(session, worker_url, token, error)
        raise

    result = worker_post(session, worker_url, "/ingest", token, payload)
    if not result.ok:
        raise RuntimeError(
            f"Worker weigerde de programmatie (HTTP {result.status_code}): "
            f"{result.text[:400]}"
        )

    print(result.text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
