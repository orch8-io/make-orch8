# Orch8 for Make

A Make (make.com) custom app for [Orch8](https://orch8.io), the self-hosted durable workflow engine. You can start workflow instances, send signals, answer approval gates, enqueue background jobs, and trigger scenarios when instances finish.

The repository uses the local-workspace layout of the **Make Apps SDK** VS Code extension (`makecomapp.json` plus one folder per component), so it can be deployed straight from VS Code.

## Components

| Component | Type | Engine endpoint (under `/api/v1`) |
|---|---|---|
| Connection `orch8` | basic (API key) | `GET /sequences?limit=1` (validation) |
| Watch Instances | polling trigger (date, desc) | `GET /instances?state=…&sequence_id=…&namespace=…&limit=…` |
| Watch Engine Events (Instant) | instant trigger, dedicated webhook, not attached | none: the engine POSTs to the Make webhook URL |
| Start a Workflow Instance | action (create) | `POST /instances` |
| Get an Instance | action (read) | `GET /instances/{id}` |
| Search Instances | search | `GET /instances` (state, sequence, namespace, `metadata.<key>`) |
| Send a Signal | action (update) | `POST /instances/{id}/signals` |
| Resolve an Approval | action (update) | `POST /instances/{id}/signals` with `{"custom":"human_input:<block_id>"}` |
| Enqueue a Background Job | action (create) | `POST /jobs`: **needs an engine newer than the current release** (404 on older engines) |
| RPC `listSequences` | select options | `GET /sequences?limit=1000` |

Every request sends `x-api-key` and `x-tenant-id` from the connection (see `general/base.iml.json`). API keys are sanitized from logs. Engine errors (`{"error":{"code","message"}}`) are mapped to Make error types: 400/404/409/422 map to DataError, 401/403 to InvalidAccessTokenError, 429 to RateLimitError, and 503 to ConnectionError.

### Wire-format notes

- **Signals.** Built-in signals are sent as bare strings (`"pause"`, `"resume"`, `"cancel"`, `"update_context"`). Custom signals are sent as `{"custom": "<name>"}`. The module uses two conditional requests so each case gets the right shape.
- **Approvals.** The module sends the signal `{"custom": "human_input:<block_id>"}` with payload `{"value": "<choice>", "comment": "…"}`. The value must be one of the gate's choice values. An `approver`-capability API key is enough for this module.
- **Priority.** The engine expects the PascalCase variants `Low`, `Normal`, `High`, `Critical`. The lowercase `"normal"` example in engine `docs/API.md` is wrong.
- **Watch Instances.** `GET /instances` is ordered by `updated_at DESC`, so the trigger uses `type: date` on `updated_at` with `order: desc` and dedupes by `id`. There is no pagination: each poll returns up to *Limit* rows (engine max 1000). Choose a limit above the number of state changes you expect per polling interval.

### Instant trigger: how to connect the webhook

Orch8 has **no webhook subscribe/unsubscribe API**. Outbound webhooks are static engine configuration, so the Make webhook is *dedicated, not attached*: you register its URL by hand.

1. Add **Watch Engine Events (Instant)** to a scenario and create a webhook. Make shows a URL like `https://hook.eu1.make.com/abc…`.
2. Add that URL to the engine configuration and restart the engine:
   ```bash
   ORCH8_WEBHOOK_URLS="https://hook.eu1.make.com/abc…,https://other-subscriber.example.com"
   ```
   You can also set it in `orch8.toml`:
   ```toml
   [engine.webhooks]
   urls = ["https://hook.eu1.make.com/abc…"]
   ```
3. Events arrive as `{event_type, instance_id, timestamp, data}` with `event_type` set to `instance.completed`, `instance.failed` or `instance.sla_breached`. The optional *Event types* filter on the webhook drops everything else.

Every configured URL receives every event for every tenant. If several tenants share one engine, follow the trigger with **Get an Instance** and filter on `tenant_id`. Delivery is at-least-once, so dedupe on `instance_id` + `event_type` + `timestamp`. The app does not verify `X-Orch8-Signature`, because Make's webhook IML has no access to the raw request bytes. Treat the unguessable Make URL as the secret, or use **Watch Instances** (polling) when you need authenticated reads.

## Validate locally

```bash
npm test        # node --test: parses every IML file, checks per-component structure,
                # and checks that every request targets a real engine route
```

No dependencies are needed (Node ≥ 20).

## Import into Make

### Option A: VS Code (Make Apps SDK extension, recommended)

1. Install the **Make Apps Editor** extension in VS Code. Create a Make API token with the `sdk-apps:*` scopes (Profile → API access).
2. In the Make Apps Editor sidebar, add your environment (e.g. `eu1.make.com`) and paste the API token.
3. Create an empty app: right-click *My Apps* → **New app**. Use name `orch8`, label `Orch8`, and theme `#0F172A`. Set the icon from the extension's context menu.
4. In `makecomapp.json`, replace the placeholder in `origins[0]`: set `baseUrl` to your zone (e.g. `https://eu1.make.com/api`), set `appId` to the id Make assigned (e.g. `orch8-a1b2c3`), and save the API token to `.secrets/apikey`. The `.secrets/` folder is git-ignored.
5. Right-click `makecomapp.json` → **Deploy to Make (beta)** and pick the origin. The extension creates the connection, webhook, RPC and modules, then uploads every code file.
6. Open a scenario, add an Orch8 module, create a connection (engine URL, API key, tenant ID), and test.

To pull later edits made in the web editor, right-click `makecomapp.json` → **Pull changes from Make**.

### Option B: web UI (manual)

In Make, go to **Custom apps → Create a new app**. Then create each component and paste the matching file into its tab:

| Web editor tab | File |
|---|---|
| Base | `general/base.iml.json` |
| Connection → Communication / Parameters | `connections/orch8/orch8.communication.iml.json` / `orch8.params.iml.json` |
| Webhook `orch8Events` (type *Web*, no connection) → Communication / Parameters | `webhooks/orch8-events/…` |
| RPC `listSequences` → Communication / Parameters | `rpcs/list-sequences/…` |
| Each module → Communication, Static parameters, Mappable parameters, Interface, Samples (and Epoch for Watch Instances) | `modules/<name>/<name>.<tab>.iml.json` |

Use the module ids and types from `makecomapp.json` (`components.module`), for example `watchInstances` → *Trigger (polling)* and `watchEvents` → *Instant trigger* bound to webhook `orch8Events`.

## Publishing and approval (not done yet, manual)

1. **Private use.** Once deployed, the app works in your own organization. To share it with other organizations, open the app → **Publish** / **Share** and send the invite link. No review is needed.
2. **Public listing (Make App Directory).** Before requesting review, work through Make's *App review* checklist:
   - Module names follow the verb + object pattern, and descriptions and help texts are complete.
   - Samples and interfaces are filled in, and errors are mapped.
   - The instant trigger carries the attach-instructions banner.
   - A test account is ready for reviewers.
3. In the app's settings, click **Request review** (or contact Make partner support through the developer hub form). Include:
   - a reachable engine URL with a test tenant and API key;
   - a short test scenario for each module;
   - for the Jobs module, a note that it needs an engine newer than the current release.
4. After approval, Make locks `common` data and the app becomes installable by every Make user. Future changes go through a new version and another review.

None of these steps have been performed. They are documented for the maintainer.
