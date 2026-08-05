"""
8_smartapi_auth.py
==================
Session manager for the **Angel One SmartAPI** (https://smartapi.angelbroking.com).

Angel One requires a fresh 2FA login every trading day - sessions expire and
the JWT/refresh/feed tokens from the previous day stop working. This module
owns that whole lifecycle so the other scripts (9_smartapi_fetch.py,
10_smartapi_live.py) and the dashboard never have to know the details:

* Credentials (api_key, client_id, pin, totp_secret) live in
  ``smartapi_config.json`` (never committed - it is your private file).
* Live tokens are cached in ``smartapi_tokens.json`` together with the date
  they were minted, so the dashboard knows *when* a new morning login is due.
* ``login()`` performs the TOTP 2FA handshake and caches the tokens.
* ``get_client()`` hands out a ready-to-use ``SmartConnect`` for the rest of
  the day; it raises ``SessionExpired`` once the cached login is stale.

CLI::

    python 8_smartapi_auth.py --status
    python 8_smartapi_auth.py --login --totp 123456
    python 8_smartapi_auth.py --login            # prompts for the TOTP
    python 8_smartapi_auth.py --logout

The interactive login also *saves* whatever credentials you type into
``smartapi_config.json`` (if the ``--save`` flag is used), so the dashboard
login form can pre-fill them for the rest of the day.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent

CONFIG_FILE = BASE_DIR / "smartapi_config.json"
TOKEN_FILE = BASE_DIR / "smartapi_tokens.json"

# SmartAPI REST API base (production endpoint, verified in the installed
# smartapi-python source).
API_BASE = "https://apiconnect.angelone.in"

# The smartapi-python SDK logs full request headers - including the
# ``Authorization: Bearer <jwt>`` header and the X-PrivateKey - on every
# failed call. Install the scrubbing filter from kronos_common.py so those
# secrets never reach *.log files. This module is imported by every process
# that talks to Angel One (dashboard, Live AI, Kronos View server, backfill,
# refresh_today), so one install point covers them all.
try:
    from kronos_common import install_secret_redaction
    install_secret_redaction()
except Exception:
    pass  # never break login over a logging nicety


class SmartAPIError(Exception):
    """Base class for all SmartAPI session errors."""


class ConfigError(SmartAPIError):
    """Raised when the credential file is missing/incomplete."""


class LoginError(SmartAPIError):
    """Raised when Angel One rejects the credentials / TOTP."""


class SessionExpired(SmartAPIError):
    """Raised when the cached login is from a previous day (or missing)."""


def _today() -> str:
    return date.today().isoformat()


def _read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _strip_bearer(token: str | None) -> str:
    """Return the raw JWT without any ``Bearer `` prefix.

    smartapi-python's ``generateSession()`` returns ``data['jwtToken']``
    already prefixed with ``"Bearer "``, while its ``_request()`` adds the
    prefix again when building the Authorization header. Storing the token
    verbatim therefore produced ``Authorization: Bearer Bearer <jwt>`` and
    Angel One rejected *every* authenticated call with
    ``AG8001 Invalid Token``. Always strip before caching or handing the
    token to the library.
    """
    return (token or "").removeprefix("Bearer ").strip()


class SmartAPISession:
    """Owns the SmartAPI credential/config files and the daily login cycle."""

    def __init__(
        self,
        config_file: str | Path = CONFIG_FILE,
        token_file: str | Path = TOKEN_FILE,
    ) -> None:
        self.config_file = Path(config_file)
        self.token_file = Path(token_file)

    # ------------------------------------------------------------------ config
    def load_config(self) -> dict:
        return _read_json(self.config_file)

    def save_config(self, config: dict) -> None:
        """Merge ``config`` into the credential file (never removes keys)."""
        merged = {**self.load_config(), **{k: v for k, v in config.items() if v}}
        _write_json(self.config_file, merged)

    def is_configured(self) -> bool:
        cfg = self.load_config()
        return bool(cfg.get("api_key") and cfg.get("client_id") and cfg.get("pin"))

    def has_totp_secret(self) -> bool:
        return bool(self.load_config().get("totp_secret"))

    # ------------------------------------------------------------------- tokens
    def load_tokens(self) -> dict:
        return _read_json(self.token_file)

    def save_tokens(self, tokens: dict) -> None:
        _write_json(self.token_file, tokens)

    def clear_tokens(self) -> None:
        try:
            self.token_file.unlink()
        except FileNotFoundError:
            pass

    def is_logged_in(self) -> bool:
        tokens = self.load_tokens()
        return bool(tokens.get("jwt")) and tokens.get("login_date") == _today()

    def status(self) -> dict[str, Any]:
        tokens = self.load_tokens()
        return {
            "configured": self.is_configured(),
            "has_totp_secret": self.has_totp_secret(),
            "logged_in": self.is_logged_in(),
            "login_date": tokens.get("login_date"),
            "client_id": tokens.get("client_id"),
            "api_key": tokens.get("api_key"),
        }

    # -------------------------------------------------------------------- login
    def login(
        self,
        totp: str | None = None,
        api_key: str | None = None,
        client_id: str | None = None,
        pin: str | None = None,
        save: bool = False,
    ):
        """Perform the TOTP 2FA login and cache the session tokens.

        Values passed explicitly override the config file. When ``save`` is
        True the (non-TOTP) credentials are written back to
        ``smartapi_config.json`` so the dashboard can pre-fill them later.
        Returns the authenticated ``SmartConnect`` client.
        """
        from SmartApi.smartConnect import SmartConnect

        cfg = self.load_config()
        api_key = api_key or cfg.get("api_key", "")
        client_id = client_id or cfg.get("client_id", "")
        pin = pin or cfg.get("pin", "")

        missing = [name for name, val in (("api_key", api_key), ("client_id", client_id), ("pin", pin)) if not val]
        if missing:
            raise ConfigError(
                f"Missing SmartAPI credential(s): {', '.join(missing)}. "
                f"Edit {self.config_file.name} or pass them to login()."
            )

        if not totp:
            secret = cfg.get("totp_secret", "")
            if secret:
                import pyotp
                totp = pyotp.TOTP(secret).now()
            else:
                raise ConfigError(
                    "A TOTP code is required (Angel One 2FA). Either pass it to "
                    "login() or store 'totp_secret' in smartapi_config.json so it "
                    "can be generated automatically."
                )

        totp_str = str(totp).strip() if totp else ""
        if totp_str.startswith("4/") or len(totp_str) > 10:
            raise LoginError(
                "Invalid 2FA TOTP code. Enter the 6-digit numeric code from your authenticator app "
                "(Google Authenticator / Authy), NOT a Google OAuth authorization code."
            )
        if totp_str and not totp_str.isdigit():
            raise LoginError(
                "TOTP code must be a 6-digit number (e.g. 123456) from your authenticator app."
            )

        client = SmartConnect(api_key=api_key)
        response = client.generateSession(client_id, pin, totp_str)

        if not isinstance(response, dict) or not response.get("status"):
            message = response.get("message", "Login failed") if isinstance(response, dict) else "Login failed"
            raise LoginError(f"Angel One rejected the login: {message}")

        data = response.get("data", {})
        jwt = _strip_bearer(data.get("jwtToken"))
        refresh = data.get("refreshToken")
        feed = client.getfeedToken()
        if not jwt or not refresh or not feed:
            raise LoginError("Angel One response was missing token fields.")

        client.setAccessToken(jwt)
        client.setFeedToken(feed)

        self.save_tokens({
            "api_key": api_key,
            "client_id": client_id,
            "jwt": jwt,
            "refresh": refresh,
            "feed": feed,
            "login_date": _today(),
        })
        if save:
            self.save_config({"api_key": api_key, "client_id": client_id, "pin": pin})
        return client

    # -------------------------------------------------------------------- client
    def get_client(self):
        """Return a ready-to-use ``SmartConnect`` for today's session.

        Raises :class:`SessionExpired` when the cached login is stale - the
        caller should then prompt the user for a fresh TOTP login.
        """
        from SmartApi.smartConnect import SmartConnect

        tokens = self.load_tokens()
        if not tokens.get("jwt") or tokens.get("login_date") != _today():
            raise SessionExpired(
                "SmartAPI session expired. A fresh daily login is required "
                "(Angel One sessions only last until the end of the day)."
            )
        client = SmartConnect(api_key=tokens.get("api_key", ""))
        # Defensive strip: tokens cached by older versions of this script may
        # still carry the library's ``Bearer `` prefix.
        client.setAccessToken(_strip_bearer(tokens.get("jwt")))
        client.setFeedToken(tokens.get("feed"))
        client.setUserId(tokens.get("client_id", ""))
        return client

    def logout(self) -> None:
        """Terminate the Angel One session (if any) and delete the token cache."""
        try:
            client = self.get_client()
        except SessionExpired:
            pass
        else:
            try:
                client.terminateSession(self.load_tokens().get("client_id", ""))
            except Exception:
                pass  # terminating an already-dead session is fine
        self.clear_tokens()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _cli() -> int:
    parser = argparse.ArgumentParser(
        description="Angel One SmartAPI session manager.",
    )
    parser.add_argument("--status", action="store_true", help="Show login status.")
    parser.add_argument("--login", action="store_true", help="Log in with a TOTP code.")
    parser.add_argument("--totp", type=str, default=None, help="6-digit TOTP (skips the prompt).")
    parser.add_argument("--api-key", type=str, default=None, help="Override api key.")
    parser.add_argument("--client-id", type=str, default=None, help="Override client ID.")
    parser.add_argument("--pin", type=str, default=None, help="Override PIN.")
    parser.add_argument("--save", action="store_true",
                        help="Save typed credentials to smartapi_config.json.")
    parser.add_argument("--logout", action="store_true", help="Log out and clear tokens.")
    args = parser.parse_args()

    session = SmartAPISession()

    if args.status:
        st = session.status()
        print(f"configured:     {st['configured']}")
        print(f"totp secret:    {st['has_totp_secret']}")
        print(f"logged in:      {st['logged_in']}  (login date: {st['login_date']})")
        print(f"client id:      {st['client_id']}")
        print(f"api key:        {'****' + st['api_key'][-4:] if st['api_key'] else '(none)'}")
        return 0

    if args.logout:
        session.logout()
        print("Logged out; token cache cleared.")
        return 0

    if args.login:
        totp = args.totp
        if not totp:
            totp = input("Enter the 6-digit TOTP from your authenticator app: ").strip()
        try:
            client = session.login(
                totp=totp,
                api_key=args.api_key,
                client_id=args.client_id,
                pin=args.pin,
                save=args.save,
            )
        except (ConfigError, LoginError) as exc:
            print(f"Login failed: {exc}", file=sys.stderr)
            return 1
        print("Login successful - tokens cached for today.")
        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
