# Security

ChunkSpelunker is an **offensive-security reconnaissance aid**. This document covers safe use, built-in guardrails, and data-handling expectations.

## Authorized use only

You must have explicit authorization to test the target. Unauthorized scanning, credential misuse, or denial-of-service via aggressive crawling/map probing may be illegal.

The CLI help text and README state this requirement. Do not remove those notices in forks intended for public distribution without replacing them with equivalent warnings.

## Trust boundaries

| Component | Trust assumption |
|---|---|
| Target web app | Untrusted; may serve malicious JS / `sourceMappingURL` |
| Playwright page | Runs target JS (as any browser would) |
| AST / regex workers | Parse only — **do not `eval`** reconstructed or minified code |
| Map URLs | May point off-origin (SSRF-like). Default: same-origin only |
| `--state` / `-c` / `-H` | **Secrets** — operator-supplied |
| Output collections | May describe internal APIs; treat as sensitive engagement data |

## Built-in guardrails

### Source map fetch policy

- Default: same-origin maps only.  
- `--allow-external-maps` required for other hosts.  
- App `-H` and hydrated tokens are **not** sent to third-party map hosts.  
- Cross-origin map auth uses `--map-header` + `--map-origin` only.  
- Speculative `.map` GETs are concurrency-limited (`--map-concurrency`) with 429 backoff.

### SSRF note

Following arbitrary `sourceMappingURL` values can cause the tool to request attacker-controlled URLs if a compromised or malicious bundle is analyzed. Keep `--allow-external-maps` off unless required; review map URLs under `--verbose`.

### Crawl safety

- Default exclude heuristics for logout / sign-out / delete-account.  
- Soft stop when navigation lands on login/logout paths during an authenticated run.  
- Caps on navigations and clicks reduce runaway automation.  

These are **best-effort**. They will not prevent all destructive actions in arbitrary UIs. Prefer read-only roles and staging environments.

### Payload & memory

- Network bodies truncated (`--max-body-bytes`).  
- JS stored on disk, not retained as giant string Maps.  
- SSE (`text/event-stream`) bodies never buffered.  

### Secrets in exports

Collections intentionally avoid dumping full `storageState` localStorage. Do not paste live JWTs into tickets. Prefer collection variables filled at runtime.

`--save-sources` and `--keep-tmpdir` may write proprietary or sensitive source — encrypt/delete after use.

## Credential hygiene

| Artifact | Handling |
|---|---|
| `auth.json` / `*.storage.json` | gitignored patterns; local only; delete post-engagement |
| `-H` / `--map-header` on shell history | prefer env files you control; clear history if needed |
| Burp proxy logs | may contain tokens; scope retention |
| Reconstructed trees | customer confidential |

## Map header broadcasting

If you pass multiple `--map-origin` values, the **same** `--map-header` set is sent to each. Mixing unrelated vendors in one run can leak a Sentry token to Datadog (or similar). Use one map host per run when credentials differ.

## Proxying through Burp

```bash
npx chunkspelunker -u https://target \
  --proxy http://127.0.0.1:8080 \
  --insecure \
  --state auth.json
```

This is the preferred way for the operator to retain a full HTTP audit trail. Ensure Burp’s scope matches authorization.

## What ChunkSpelunker is not

- Not an exploit framework  
- Not a CAPTCHA/WAF bypass product  
- Not a GraphQL schema introspector (it records operations it sees)  
- Not a substitute for human review of reconstructed source  

## Reporting issues

If you find a vulnerability **in ChunkSpelunker itself** (e.g. path traversal in `--save-sources`, secret leakage into exports), report it privately to the maintainers before public disclosure.

## Related reading

- [AUTHENTICATION.md](./AUTHENTICATION.md) — how tokens flow  
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — operational failures  
- [../SPEC.md](../SPEC.md) §15 — normative security constraints  
