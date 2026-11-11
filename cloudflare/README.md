# ThreadShelf on Cloudflare — tshelf.mirador.cc

**ID:** `DEPLOY/TSHELF-CLOUDFLARE/20261111`  
**Updated:** 2026-11-11  
**Repository:** `oovac/threadshelf` (fork of `ChrystianSchutz/ThreadShelf`, MIT)  
**Status:** deployed edge adapter v0.1; Cloudflare bindings and private domain confirmed; authenticated browser E2E is **not verified**.

## What is deployed

The upstream ThreadShelf Node.js/Express/LanceDB app remains intact and is **not** running in Cloudflare Workers. This deployment is an independent, minimal adapter under `cloudflare/`:

- `cloudflare/core.mjs` — ChatGPT (full `mapping` DAG), Claude and OpenRouter JSON normalization, local chunker.
- `cloudflare/ui.mjs` — owner-only web UI for JSON import, threads, exact/semantic search, reader, download.
- `cloudflare/worker.mjs` — D1/R2/Workers AI/Vectorize HTTP API.
- `test/cloudflare-core.test.js` — parser tests: `node --test test/cloudflare-core.test.js`.

**Current limitations:** import request <=1.4MB, <=100 conversations / <=250 messages; AI index processes 8 messages per click; no background indexing, no original local llama.cpp generator, no original MCP stdio or Obsidian tooling, no provider exports beyond ChatGPT/Claude/OpenRouter on the edge adapter. The rest of ThreadShelf upstream remains in the fork.

## Infrastructure

| Component | Identifier |
| --- | --- |
| Cloudflare account | Amida Software |
| Worker | `tshelf` |
| Hostname | `https://tshelf.mirador.cc` |
| D1 database | `tshelf-archive` (EU jurisdiction) |
| D1 ID | `286c052b-71af-49ee-a996-7c1141070ead` |
| R2 bucket | `tshelf-originals` (WEUR) |
| Vectorize | `tshelf-semantic`, 1024 dims / cosine |
| Workers AI | `@cf/baai/bge-m3` |
| Cloudflare Access | `ThreadShelf · private archive`, allow owner email |
| Anthill registry | project `TSHELF`, ID `r_50385311ddbed7ff977aab002b057e74` |

Worker bindings: `DB` (D1), `ORIGINALS` (R2), `VECTOR` (Vectorize), `AI` (Workers AI).

## Security and use

All endpoints are behind Cloudflare Access (browser login required). The original worker is explicitly restricted to the `tshelf.mirador.cc` hostname. Its `workers.dev` hostname and previews are disabled. Do not remove Access without adding equivalent authentication and rate/abuse protection.

Do not import confidential conversation archives until an authenticated import/readback/delete/search E2E test is performed. Original JSON is stored separately in R2 under `imports/<id>.json`; normalized messages in D1 are a retrieval projection. Cloudflare Access authentication is presently tied to the owner's identity. The source fork is public; no real exports are included.

## Verification evidence (2026-11-11)

- Cloudflare Worker upload API: success, `tshelf`, `fetch` handler, compatibility date `2026-11-11`.
- Worker custom domain and DNS: `tshelf.mirador.cc`, enabled; DNS AAAA record proxied.
- Cloudflare Access app/policy: read-back confirms allow-only owner email.
- Anonymous external GET to `/` and `/api/health`: `login_required` (expected).
- D1 migration and `SELECT count(*) FROM threads`: succeeded, **0** threads.
- Vectorize index metadata: 1024 dims, **0** vectors.
- Pure parser/chunker checks: 5/5 passed. GitHub Actions CI suite not executed.
- Authenticated browser screenshot and end-to-end import/index/search tests: **not yet verified**.
- Railway deploy attempt blocked by expired trial; no paid resources provisioned through Railway.

## Deploy workflow

The current Worker was deployed through the Cloudflare API (multipart module upload), **not** by Anthill's static publication adapter or by an auto-deploy GitHub action. A commit to GitHub does not automatically redeploy this Worker. Use the Cloudflare Worker module upload path or a future GitHub Actions workflow with appropriately scoped credentials. Reconfirm bindings, hostname, Access, and HTTP after every deployment.

**Do not confuse this custom Cloudflare Worker with a native ChatGPT Sites project ID.** Anthill tracks it as an externally hosted Cloudflare application.
