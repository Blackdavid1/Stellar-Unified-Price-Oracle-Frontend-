# Developer Portal SSO (#501)

The frontend implements the client side of an OAuth 2.0 / OIDC Authorization
Code + PKCE flow for GitHub and Google sign-in, gating developer features
(currently: webhook configuration in the notification-channels panel) behind
a verified session. See `src/auth/`.

## Why PKCE, and why no token in the browser

This is a public client (a static SPA) — it cannot hold a client secret. PKCE
(RFC 7636) makes the authorization-code exchange safe without one: the client
generates a random `code_verifier`, sends only its SHA-256 hash
(`code_challenge`) with the authorize request, and later proves it holds the
matching verifier when exchanging the code.

The access/refresh token never reaches the browser. Code exchange and session
issuance happen on the backend, which sets the session as an `httpOnly`,
`Secure`, `SameSite=Lax` cookie. The frontend only ever holds the PKCE
`verifier`/`state` (single-use, non-credential nonces, cleared immediately
after use) in `sessionStorage` — never in `localStorage`, and never the token
itself.

## Token lifetime, rotation, and storage

| Token | Lifetime | Storage | Rotation |
|---|---|---|---|
| Access token | 15 min | `httpOnly` `Secure` `SameSite=Lax` cookie | Reissued on every refresh |
| Refresh token | 30 days (sliding) | `httpOnly` `Secure` `SameSite=Lax` cookie | Rotated on every use; the previous token is invalidated |
| PKCE `verifier`/`state` | Single use | `sessionStorage`, cleared immediately after the callback | n/a |

Rules enforced by the auth layer:

- **Never persistent browser storage.** Tokens are never written to
  `localStorage` or `sessionStorage`; only the non-credential PKCE nonces use
  `sessionStorage`. This is enforced by a test (see below).
- **Refresh/rotation.** When the access token expires, the frontend calls
  `POST /auth/refresh`; the backend issues a new access token and a new refresh
  token, invalidating the one that was presented. Refresh tokens are
  single-use.
- **Reuse detection.** Presenting an already-rotated (used) refresh token is
  treated as theft: the backend revokes the entire session family for that
  user, and the frontend clears all session state and returns to the
  unauthenticated state.
- **Logout everywhere.** `POST /auth/signout-all` revokes every refresh token
  and session for the user server-side, so no other device can refresh; the
  frontend clears all session state on success.

## Flow

1. `useAuth().signIn('github' | 'google')` generates a PKCE verifier/challenge
   and OAuth `state`, stashes them in `sessionStorage`, and redirects to the
   provider's authorize URL.
2. The provider redirects back to `/auth/callback` with `code` and `state`.
3. `AuthCallback` (`src/pages/AuthCallback.tsx`) verifies `state`, then POSTs
   `{ code, codeVerifier, redirectUri }` to `POST /auth/callback/:provider`.
4. The backend exchanges the code with the provider, creates a session, and
   responds with `Set-Cookie` (httpOnly) + `{ user }`.
5. The frontend re-checks `GET /auth/session` on mount and on an interval
   (`config.auth.sessionCheckIntervalMs`, default 5 min) so an expired or
   remotely-revoked session (`POST /auth/signout-all`, "sign out everywhere")
   is reflected without a manual reload.

## Backend contract expected by `src/auth/authApi.ts`

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/auth/session` | — | `200 { user }` or `401` |
| `POST` | `/auth/callback/:provider` | `{ code, codeVerifier, redirectUri }` | `200 { user }`, sets session cookie |
| `POST` | `/auth/refresh` | — (refresh cookie) | `200 { user }`, rotates access + refresh cookies; `401` on reuse/expiry |
| `POST` | `/auth/signout` | — | `204`, clears session cookie |
| `POST` | `/auth/signout-all` | — | `204`, revokes every session and refresh token for the user |

## Configuration

| Env var | Purpose |
|---|---|
| `VITE_OAUTH_GITHUB_CLIENT_ID` | Public OAuth client ID for GitHub |
| `VITE_OAUTH_GOOGLE_CLIENT_ID` | Public OAuth client ID for Google |

A provider's sign-in button is disabled (with a tooltip) when its client ID is unset.

## Gating a developer feature

Wrap it in `<DeveloperAuthGate feature="…">`, which renders the SSO buttons
until `useAuth()` reports `status === 'authenticated'`.

## Tests

`src/auth/__tests__/` covers the hygiene guarantees above:

- **No persistent storage** — asserts that no token value is ever written to
  `localStorage`/`sessionStorage` during sign-in, refresh, or logout.
- **Expiry** — an expired access token triggers a refresh and the request is
  retried once.
- **Rotation** — a refresh response replaces the stored session and the old
  refresh token is no longer accepted.
- **Reuse detection** — a `401` from `/auth/refresh` clears all session state
  and drops the user to the unauthenticated state.
- **Logout everywhere** — `signOutEverywhere()` calls `/auth/signout-all` and
  clears all session state.
