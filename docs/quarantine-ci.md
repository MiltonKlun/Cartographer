# Quarantine lane — CI consumption guide

> How CI routes quarantined tests into a **non-blocking lane** without ever
> editing test source (I5). Cartographer writes `quarantine.json`; CI reads
> it. No `.skip`, no `.fixme`, no source edits — the data file is the lane.

## The contract

`quarantine.json` (repo root by default; `CART_QUARANTINE` to relocate):

```json
{
  "version": 1,
  "entries": [
    {
      "test_id": "tests/login.spec.ts::shows the dashboard after login",
      "ticket": "FLAKE-101",
      "entered_at": "2026-06-11T12:00:00Z",
      "expires_at": "2026-06-18T12:00:00Z",
      "reason": "race on Sign in button"
    }
  ]
}
```

`test_id` matches the format the ingestors and triage emit:
`<file>::<spec title>` (Playwright) or `<classname>::<name>` (JUnit).

## CI wiring (two lanes, one run)

The principle: run **all** tests, but let quarantined failures land in a lane
that does not fail the build. A test is quarantined only while
`now < expires_at`.

### Playwright (grep-based split)

```bash
# 1. extract currently-active quarantined test_ids
QUARANTINED=$(node -e '
  const {loadQuarantine,isQuarantined}=require("cartographer/dist/quarantine.js");
  const f=loadQuarantine("quarantine.json"); const now=()=>new Date();
  for(const e of f.entries) if(isQuarantined(f,e.test_id,now)) console.log(e.test_id);
')

# 2. blocking lane — everything NOT quarantined (gates the merge)
npx playwright test --grep-invert "$(echo "$QUARANTINED" | paste -sd'|')"

# 3. non-blocking lane — quarantined only (reported, never fails the build)
npx playwright test --grep "$(echo "$QUARANTINED" | paste -sd'|')" || true
```

### JUnit / generic runners

Filter your runner's test selection by the same `test_id` list, and mark the
quarantined job `continue-on-error: true` (GitHub Actions) or `allow_failure:
true` (GitLab).

## Lifecycle

1. **Triage** spots a flaky cluster: `cart triage <run>` →
   `TEST BRITTLENESS` cluster with a `cart quarantine add …` suggestion.
2. **Quarantine** (entry + ticket = ACT, receipted, source untouched):
   ```
   cart quarantine add "<test_id>" --ticket FLAKE-101 --reason "…"
   ```
   Default expiry 7 days.
3. **Fix** the flake, then:
   ```
   cart quarantine remove "<test_id>"
   ```
4. **Expiry without resolution escalates** — `cart quarantine list --expired`
   (and, from Phase 7, the morning `cart brief`) surfaces lapsed entries so a
   quarantine can't quietly become permanent.

## Invariants this honors

- **I5** — the lane is a data file; test source is never edited. No `.skip`.
- **I4** — adding an entry is an `ACT` through the autonomy gateway, with a
  receipt whose `revert` is `cart quarantine remove <test_id>`.
- **CG-6.3** — 7-day default expiry; expired entries escalate, never silently
  persist.
