# Real coin transfer, mirroring eaze-checkin's own
# backend/app/services/coin_transfer.py exactly — same request shape (a CSV
# upload) against the same EAZE_COINS_API_URL, so a claim from either app is
# indistinguishable to the payments side once it's submitted.
#
# Mock mode (no auth key configured) never calls the real API — this is what
# keeps the flow testable locally without a real credential.
import os

import httpx

DEFAULT_API_URL = "https://api.eazeapp.com/payments/free-coins/upload/"


async def transfer_coins(eaze_user_id: str, amount: int) -> dict:
    auth_key = os.environ.get("EAZE_COINS_AUTH_KEY")
    api_url = os.environ.get("EAZE_COINS_API_URL", DEFAULT_API_URL)

    if not auth_key:
        return {
            "status": "mock_success",
            "providerRef": "mock",
            "notes": "Mock transfer — EAZE_COINS_AUTH_KEY not configured.",
        }

    csv_content = f"user_id,coins\n{eaze_user_id},{amount}\n"

    try:
        async with httpx.AsyncClient(timeout=30) as http_client:
            response = await http_client.post(
                api_url,
                headers={"x-n8n-auth-key": auth_key},
                files={"file": ("transfer.csv", csv_content, "text/csv")},
                data={"name": "EazeScore Claim"},
            )
    except httpx.HTTPError as err:
        raise RuntimeError(f"Eaze Coins API request failed: {err}") from err

    if response.status_code >= 400:
        raise RuntimeError(f"Eaze Coins API returned {response.status_code}: {response.text}")

    return {"status": "submitted", "providerRef": eaze_user_id, "notes": response.text}
