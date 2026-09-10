// Real coin transfer, mirroring eaze-checkin's own
// backend/app/services/coin_transfer.py exactly — same request shape (a CSV
// upload) against the same EAZE_COINS_API_URL, so a claim from either app is
// indistinguishable to the payments side once it's submitted.
//
// Mock mode (no auth key configured) never calls the real API — this is what
// keeps the flow testable locally without a real credential.
export async function transferCoins(eazeUserId, amount) {
  const authKey = process.env.EAZE_COINS_AUTH_KEY;
  const apiUrl = process.env.EAZE_COINS_API_URL || 'https://api.eazeapp.com/payments/free-coins/upload/';

  if (!authKey) {
    return { status: 'mock_success', providerRef: 'mock', notes: 'Mock transfer — EAZE_COINS_AUTH_KEY not configured.' };
  }

  const csvContent = `user_id,coins\n${eazeUserId},${amount}\n`;
  const form = new FormData();
  form.append('file', new Blob([csvContent], { type: 'text/csv' }), 'transfer.csv');
  form.append('name', 'EazeScore Claim');

  let response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'x-n8n-auth-key': authKey },
      body: form,
    });
  } catch (err) {
    throw new Error(`Eaze Coins API request failed: ${err.message}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Eaze Coins API returned ${response.status}: ${text}`);
  }

  const notes = await response.text().catch(() => null);
  return { status: 'submitted', providerRef: eazeUserId, notes };
}
