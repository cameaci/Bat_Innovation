"""Launch the local API with a token and data directory provided by the desktop shell."""

from __future__ import annotations

import os
import sqlite3
import sys

import uvicorn

from .main import Settings, create_app
from .store import DatabaseSchemaError


def main() -> None:
    settings = Settings.from_environment()
    port = int(os.environ.get("BAT_API_PORT", "8765"))
    if not 1 <= port <= 65535:
        raise ValueError("BAT_API_PORT must be a valid TCP port")
    try:
        application = create_app(settings)
    except DatabaseSchemaError:
        print("BAT_STARTUP_ERROR:database_schema", file=sys.stderr)
        raise SystemExit(1) from None
    except sqlite3.DatabaseError:
        print("BAT_STARTUP_ERROR:database_unreadable", file=sys.stderr)
        raise SystemExit(1) from None
    uvicorn.run(application, host="127.0.0.1", port=port, access_log=False)


if __name__ == "__main__":
    main()
