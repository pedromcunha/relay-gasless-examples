/**
 * Relay API helpers — fetch wrapper and status polling.
 */

const RELAY_API = process.env.RELAY_API_URL || "https://api.relay.link";
const RELAY_API_KEY = process.env.RELAY_API_KEY!;

export async function relayFetch(path: string, body: object) {
  const res = await fetch(`${RELAY_API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(path === "/execute"
        ? { "x-api-key": RELAY_API_KEY }
        : { Authorization: `Bearer ${RELAY_API_KEY}` }),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`${path} failed (${res.status}): ${error}`);
  }
  return res.json();
}

export async function pollStatus(requestId: string) {
  console.log(`\nPolling request ${requestId}...`);
  for (let i = 0; i < 60; i++) {
    const res = await fetch(
      `${RELAY_API}/intents/status/v3?requestId=${requestId}`
    );
    const status = await res.json();
    console.log(`  [${i + 1}] ${status.status}`);

    if (status.status === "success") {
      console.log(`  Tx: ${status.txHashes?.[0] ?? "N/A"}`);
      return;
    }
    if (status.status === "failure" || status.status === "refund") {
      throw new Error(`Relay failed: ${status.status}`);
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error("Polling timed out");
}
