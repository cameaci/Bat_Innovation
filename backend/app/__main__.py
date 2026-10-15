"""Launch the local API with a token and data directory provided by the desktop shell."""

from __future__ import annotations

import os

import uvicorn

from .main import Settings, create_app


def main() -> None:
    settings = Settings.from_environment()
    port = int(os.environ.get("BAT_API_PORT", "8765"))
    if not 1 <= port <= 65535:
        raise ValueError("BAT_API_PORT must be a valid TCP port")
    uvicorn.run(create_app(settings), host="127.0.0.1", port=port, access_log=False)


if __name__ == "__main__":
    main()
