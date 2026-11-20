# Authentication & Security Report

## Accounts

* Provisioned **only** for authorized owner numbers (`lib/ownerNumbers.js`:
  `916033352400`, `916033271400`, plus `data/owner.json` and `OWNER_NUMBER` /
  `SECONDARY_OWNERS`). A non-owner number is refused before any account exists.
* Provisioning happens automatically after a successful pairing of an owner number.
  Pairing the number is proof of control over that WhatsApp account.
* A reset (re-pairing or "Reset password" in the dashboard) replaces the hash and
  revokes every existing session.

## Passwords

| Property | Implementation |
| --- | --- |
| Hashing | `crypto.scryptSync`, N=16384, r=8, p=1, 64-byte key, 16-byte random salt |
| Comparison | `crypto.timingSafeEqual` |
| Format | `scrypt$N$r$p$salt$hash` in `data/webAccounts.json` |
| Password policy | ≥ 10 characters, must contain a letter and a digit |
| Temporary password | `crypto.randomBytes(9)` → `XXXX-XXXX-XXXX`, generated in memory |
| Delivery | one WhatsApp message over the freshly authenticated connection |
| Storage | only the hash is persisted; the plaintext is never logged or returned |
| Forced change | `mustChangePassword` is shown as a dashboard banner and cleared only by a real change |

Node's `scrypt` was chosen over `bcrypt`/`argon2` because it ships with Node — this
project intentionally keeps the web layer dependency-free, and scrypt is a memory-hard,
OWASP-recommended KDF.

## Sessions

* 32 random bytes, hex; the cookie holds the token, the server stores `sha256(token)`.
* Cookie: `HttpOnly`, `SameSite=Lax` (or `None; Secure` for a cross-origin frontend),
  `Path=/`, `Max-Age` from `SESSION_TTL_HOURS` (default 12).
* Changing a password or resetting an account revokes all sessions for that number.
* Individual sessions can be revoked from **Security** / **Owner management**.

## CSRF

Every dashboard mutation (settings, AI, auto-reply, commands, owners, sessions,
password, logout) requires `X-Lily-CSRF` to equal the session's token. A missing or
wrong token returns `403` and changes nothing (verified in tests).

## Brute force

5 failed attempts per number **or** per IP within 15 minutes locks that key for 15
minutes; a locked login returns `429`. Successful login clears the counters. Every
attempt is written to `data/webAudit.log` (`login.ok`, `login.failed`, `login.locked`).

## Authorization

`requireOwner()` is the only way a dashboard route runs. It checks the session,
re-reads the account from disk (so a disabled or deleted account loses access
immediately) and the owner role. The browser is never trusted for permissions —
the frontend merely hides controls it will not be allowed to use.

## Secret handling

* API keys are read server-side from `data/aiAutoReply.json` or `.env` only.
* `GET /api/dash/settings` returns `keyConfigured` and a masked value
  (`sk-or-v1…c48145`); tests assert the full key never appears in the response.
* No session token, password hash or WhatsApp credential is returned by any route.
* `data/webAccounts.json`, `data/webSessions.json` and `data/webAudit.log` are
  gitignored and not reachable over HTTP (tested).

## Known limits

* Rate limiting and lockout state is in memory: a restart clears it. The audit log
  keeps the history.
* There is no password-reset email/token flow — reset is delivered over WhatsApp,
  which is the account's own verified channel.
