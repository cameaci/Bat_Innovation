"""PyInstaller entry point: the local API, or one whitelisted disposable worker re-entered with --worker."""

import runpy
import sys


def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] == "--worker":
        from backend.app.workers import MODULES
        if len(sys.argv) < 3 or sys.argv[2] not in MODULES:
            raise SystemExit(2)
        module = sys.argv[2]
        sys.argv = [module, *sys.argv[3:]]
        runpy.run_module(f"backend.app.{module}", run_name="__main__")
        return
    from backend.app.__main__ import main as serve
    serve()


if __name__ == "__main__":
    main()
