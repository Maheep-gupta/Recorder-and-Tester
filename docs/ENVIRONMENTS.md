# Replayr environments: record on production, replay on localhost

A test remembers **where it was recorded**. When you run it, you can pick **any** environment, and
the recorded steps follow you there.

```
Record on   Production   https://app.example.com/studio
Replay on   Localhost    http://localhost:4201
            {{baseUrl}}/orders?tab=open  →  http://localhost:4201/orders?tab=open
```

## What an environment is

| Field | Meaning |
|---|---|
| `key` | Short id, `a-z 0-9 -`, e.g. `prod-web`. Stored in a test as `target.app`. |
| `label` | What the UI shows. |
| `baseUrl` | Root of the app in that environment, including any path prefix (`https://app.example.com/studio`). |
| `kind` | `production`, `staging`, `development` or `local`. Drives colour and safety. |
| `protected` | When true, a replay needs an explicit confirmation. Always true for `production`. |
| `auth` | Whether the automated login runs before recording/replay. |
| `application` | Free-text group, e.g. `Billing web`. Environments of one application are shown together, and the test detail suggests a local environment of the same application as the replay target. |

Environments come from three places:

1. **Built-in** — `src/config.js` (`ui-shell`, `qa1`, `concierge`), URLs overridable through
   `recorder.local.env`. They cannot be deleted from the UI.
2. **Yours** — added on the **Applications & Environments** screen, stored in `local-tests/environments.json`
   (git-ignored, with the rest of `local-tests/`).
3. **Typed** — any `http(s)://` URL typed on the Record screen. A typed URL on `localhost`,
   `127.0.0.1`, `[::1]` or `*.localhost` is treated as `local`; **anything else is treated as
   `production`** until you say otherwise by adding it as an environment.

## How URLs are rewritten on replay

1. At record time every URL under the recording environment's `baseUrl` is stored as
   `{{baseUrl}}/…`, so it is portable by construction.
2. At replay time `{{baseUrl}}` becomes the target environment's `baseUrl`. Path and query string
   are preserved.
3. An absolute URL that still points at the **recorded** environment (an imported or hand-edited
   step) is rewritten as well — first by base path, otherwise origin-only. Every rewrite is listed
   in the run report under **URL rewrites**.
4. A cross-environment replay **refuses** to navigate to the origin of any protected environment.
   A replay against localhost can never wander onto production.

URLs on other hosts (a third-party payment page, an SSO host) are left alone.

## Logins are per environment and never travel

- Each environment has its own saved browser session (`.auth/<key>.json`) and, optionally, its
  own username/password (`credentials.local.env` for built-ins, `custom-credentials.local.json`
  for typed URLs). Passwords typed in Replayr live in the OS keyring (Windows Credential
  Manager, macOS Keychain, Linux Secret Service) and sessions are encrypted with a key held there.
  With no keyring, saving a login is refused rather than written in plaintext.
  `credentials.local.env` and the shared `.auth/ui-shell.json` remain plaintext, so treat the
  folder as sensitive (see [SECURITY_AUDIT.md](SECURITY_AUDIT.md)).
- A production session or password is **never** used for another environment, never written
  into a test, and never included in an export.
- Recorded password-like fields (password inputs, `autocomplete` password/OTP/card fields, and
  names such as `token`, `secret`, `cvv`, `api_key`) are stored as **redacted**. On replay they
  are left empty, so the target environment's own saved session must cover sign-in.

## Safety when the target is production

- The target environment, with its kind badge, is always shown next to **Execute**.
- Running against a protected environment requires a confirmation. The server enforces this
  (`428 confirm-protected`), not just the UI.
- Native dialogs (`confirm()`, `alert()`) are handled deliberately — accepted by default, or as
  set on the step — and every one is listed in the run report.

## Reading a result

| Status | Meaning |
|---|---|
| **Passed** | Every step ran **and** at least one assertion verified the expected behaviour. |
| **Inconclusive** | The steps completed but nothing verified the outcome (no assertion), or a step was skipped. This is *not* proof the bug is fixed — add an assertion. |
| **Failed** | An assertion failed (the bug still reproduces), or an element could not be found / was ambiguous, or an action failed. |
| **Blocked** | The run never started: app unreachable or login failed. |
| **Error** | Infrastructure problem mid-run: app went away, browser crashed, run timed out, or the service stopped while it ran. |
| **Cancelled** | You cancelled it. Remaining steps are shown as *not run*. |

The **reason** under the status tells you which of these it was.
