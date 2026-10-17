# Two Rooms & a Boom — AD Arcade basic edition

A mobile-web adaptation of the **basic** social deduction game by Alan Gerding and Sean McCoy. Unofficial fan project, no official graphics or rulebook content included. Designed for **6–30 players + a non-playing host**. Real players move between two **physical rooms**. The game itself is **not** a demo: no fake bots, offline multiplayer, or simulated backend fallback.

## Architecture

- `frontend/` — mobile Safari / Chrome responsive static site on GitHub Pages. No framework or remote runtime scripts. MIT-licensed QR code library vendored locally.
- `worker/index.mjs` — Cloudflare Worker + **SQLite-backed Durable Object** per party. Persistent, serializable state; WebSocket hibernation; host-authenticated commands; alarms for server-side round expiry.
- `worker/core.mjs` — isolated rules engine with named, testable functions; card allocation, election, leader succession, sealed hostage picks, physical transfers, and win computation.
- `tests/core.test.mjs` — engine regression tests including 25-seat three-round and four Gambler outcome combinations.

## Deployment (requires one-time setup by GitHub/Cloudflare account owner)

1. Enable Cloudflare Workers with Durable Objects for your account. Free-tier availability and quotas are subject to Cloudflare's current terms.
2. Add `CLOUDFLARE_API_TOKEN` (Worker deploy permissions) and `CLOUDFLARE_ACCOUNT_ID` as GitHub **Actions secrets** in this repository. Do not store credentials in source files.
3. Enable GitHub Pages and select **GitHub Actions** as the source.
4. Push/merge to `main`. `.github/workflows/deploy.yml` runs tests, deploys the Worker, writes its actual workers.dev URL to the Pages config, and deploys the frontend.
5. Open the Pages link on host laptop, create a room, scan the QR on physical phones. Validate the deployed `/api/health` Worker endpoint and test a full game before hosting an event.

If deployment fails, the workflow **fails** and the frontend does not publish a placeholder API URL. If the backend is unreachable, every connected screen shows an explicit connection-error banner and a retry button. No fake success state.

For local static preview: `python3 -m http.server -d frontend 8080` serves the pages, but does not offer multiplayer until `frontend/config.js` points at a running Worker (`npx wrangler dev`). Never label the static preview a playable deployed game.

## How to host

1. Host creates room with the exact player count. Each guest scans QR or joins with the six-character code.
2. Host deals cards; guests move to indicated physical A/B areas and may hold to peek at only their own card.
3. Host starts round 1. The first leader is nominated by another member; usurp requires **strictly more than half** of that room's members. Leaders may abdicate only with the recipient's acceptance. The previous leader cannot immediately be given the role back in that round.
4. Leaders choose the official required number of hostages (not themselves) and lock choices privately. Choices are neither published nor applied before **both lock** and the timer expires. If a leader misses the deadline, the host selects instead. At expiry, leader selections are disabled.
5. The Worker atomically switches rooms and shows movement prompts. Movement window is 25 seconds; next round timer starts automatically. Host may advance early after confirming physical movement.
6. After round 3 exchange, Gambler (if present) locks prediction. The host reveals all cards simultaneously. Final room assignments determine the Red/Blue winner.

| Players | Round 1 | Round 2 | Round 3 |
|---|---:|---:|---:|
| 6–10 | 1 | 1 | 1 |
| 11–21 | 2 | 1 | 1 |
| 22–30 | 3 | 2 | 1 |

## Safety and fairness

Only the individual player's validated socket or state request contains that player's card before reveal. Public rosters never carry card values before the final host reveal, including to the host. A player's browser stores only its own bearer token; refreshed tabs reclaim seat/card/room. Host refresh also re-authenticates from its private browser storage. Never share the host device's browser profile with players.

A host removing a **dropped seat after dealing** invalidates the disconnected participant's token but preserves the original seat and card in the 25-player ledger; otherwise the deal, hostage quotas, or verdict might become inconsistent. This means the absent seat remains in the final reveal. The host should not remove active participants unnecessarily. Before dealing, removal frees the slot.

The rooms are physical: do not text, signal, shout, or show an opponent your room's screen. A person can voluntarily show their own full card, but no feature shows another player's card and there is no card trading.

## Audit commands

`npm run test:all` requires only Node 22, no npm install. `npm run dev` requires `npm install` (wrangler).

### Production release gates

- PASS — Node engine tests for deck sizes 6–30, all hostage tiers, 25-seat state replay, 30 seats, majority, leadership changes, two-phase secrecy, expired timer, forced selection, prediction and final result, refresh token reclaim.
- PENDING — Full deployed Worker WebSocket integration and 25 real concurrent sockets (engine simulation is **not** a socket load test).
- PENDING — Safari iOS and Chrome Android real-device validation, including airplane-mode recovery.
- PENDING — Browser console/network clean report on both platforms.
- PENDING — GitHub Actions successful deployment + Pages link smoke test.

**Do not advertise this version as production-ready until every pending gate passes.**

## Attribution

Two Rooms and a Boom is a game by Alan Gerding and Sean McCoy. This open-source adaptation is not an official release or endorsed by its creators. QRCode for JavaScript by Kazuhiko Arase is MIT licensed (see `frontend/LICENSE-QR.txt`).
