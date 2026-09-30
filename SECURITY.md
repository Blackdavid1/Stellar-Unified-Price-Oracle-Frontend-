# Security

## Session and token hygiene (auth layer)

This document specifies how authentication tokens are issued, stored, rotated, and
invalidated. The rules below are normative: any change to `src/auth` must keep them
true, and the accompanying tests enforce the storage rule.

### Storage location

- **Access tokens are held in memory only.** They live in a module-scoped variable
  inside the auth layer and are never written to `localStorage`, `sessionStorage`,
  IndexedDB, or any other persistent browser storage.
- **Refresh tokens are held in an `httpOnly`, `Secure`, `SameSite=Strict` cookie**
  set by the server. JavaScript must never read or write the refresh token.
- A test asserts that no token value is ever passed to `localStorage.setItem` or
  `sessionStorage.setItem`. This test is the enforcement mechanism for the rule
  above; do not weaken or skip it.

### Token lifetime

| Token         | Lifetime | Notes                                              |
| ------------- | -------- | -------------------------------------------------- |
| Access token  | 15 min   | Short-lived; re-minted from the refresh token.     |
| Refresh token | 30 days  | Rotated on every use (see below).                  |

Access tokens are treated as opaque and are discarded on expiry; the client
requests a new one via the refresh flow rather than extending the old token.

### Refresh and rotation

- Every successful refresh **rotates** the refresh token: the server issues a new
  refresh token and invalidates the one that was presented.
- Rotation is single-use. A refresh token may be redeemed exactly once.
- The new refresh token is delivered in the same `httpOnly` cookie; the client
  never handles it directly.

### Reuse detection

- If a refresh token that has already been rotated (i.e. already redeemed) is
  presented again, this is treated as **token reuse**.
- On detected reuse the server invalidates the entire token family for that
  session, forcing re-authentication, and clears all client session state.
- Reuse detection is covered by tests.

### Logout

- **Logout** clears all in-memory session state (access token, user/session
  metadata) and asks the server to invalidate the current refresh token.
- **Logout everywhere** invalidates every refresh token issued to the user across
  all devices/sessions, not just the current one. After it completes, no existing
  refresh token for that user can be redeemed.
- Both logout paths are covered by tests, including verification that the refresh
  token is rejected after logout.

### Tests

The auth layer ships tests covering:

1. **Storage** — tokens are never written to persistent browser storage.
2. **Expiry** — an expired access token is rejected and triggers refresh.
3. **Rotation** — a refresh token is single-use and a new one is issued.
4. **Reuse detection** — replaying a rotated refresh token invalidates the family.
5. **Logout** — logout clears session state and invalidates the refresh token.
6. **Logout everywhere** — all refresh tokens for the user are invalidated.
