# cron-pinger

A tiny self-hosted scheduler with a web GUI + analytics. It POSTs a target URL
on a cron schedule and records every run (status, duration, parsed response).

Built to drive TalkEZY's delivery pump:
`POST https://talkezy.in/api/automations/cron` every minute with the
`x-cron-secret` header — which resumes paused broadcasts, drains stalled ones,
processes automations, resumes waits and sweeps flows.

## Config (env)

| Var | Required | Default | Notes |
|---|---|---|---|
| `TARGET_URL` | yes | — | e.g. `https://talkezy.in/api/automations/cron` |
| `CRON_SECRET` | yes | — | sent as `x-cron-secret`; never shown in the GUI |
| `SCHEDULE` | no | `* * * * *` | standard cron (every minute) |
| `PORT` | no | `3000` | |
| `GUI_TOKEN` | no | — | if set, the dashboard/API need `?token=` or `Authorization: Bearer` |
| `HISTORY_MAX` | no | `500` | runs kept |
| `TIMEOUT_MS` | no | `55000` | per-request timeout |
| `DATA_DIR` | no | `/data` → cwd | where `cron-history.json` is persisted |

## Endpoints

- `GET /` — dashboard (success rate, 24h runs, history, **Run now**).
- `GET /healthz` — `{ ok: true }` for container health checks.
- `GET /api/stats` — stats + last 100 runs (auth-gated if `GUI_TOKEN` set).
- `POST /api/run` — trigger a run immediately.

## Run locally

```bash
pnpm install
TARGET_URL=https://talkezy.in/api/automations/cron CRON_SECRET=xxx pnpm start
# open http://localhost:3000
```

## Deploy (Dokploy)

Build from this folder's `Dockerfile`, set the env vars above, expose port
`3000`, and attach the domain (e.g. `cron.samsite.in.net`) with HTTPS. Mount a
volume at `/data` to keep run history across redeploys.
