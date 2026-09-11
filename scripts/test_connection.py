import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db.client import DB_ENABLED, close_pool, health_check  # noqa: E402


async def main():
    if not DB_ENABLED:
        print("DATABASE_URL not set — running in local-only mode, nothing to test.")
        return
    result = await health_check()
    if not result["ok"]:
        raise RuntimeError(result.get("error"))
    print("Connected OK.")
    await close_pool()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as err:  # noqa: BLE001
        print(f"Connection failed: {err}", file=sys.stderr)
        sys.exit(1)
