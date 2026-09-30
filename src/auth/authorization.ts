/**
 * Centralized authorization model for gated routes and actions.
 *
 * Authentication answers "is someone logged in?". Authorization answers
 * "is this authenticated user allowed to perform this action?". Every gated
 * route/action must be registered here with the scope(s) it requires so that
 * guards can enforce authz (not just authn) and CI can detect unregistered
 * gated routes.
 */

export type AuthScope =
  | "wallet:read"
  | "wallet:write"
  | "developer:read"
  | "developer:write"
  | "admin:read"
  | "admin:write";

export interface AuthzEntry {
  /** Stable identifier for the gated route or action. */
  id: string;
  /** Route path or action name as referenced by the guard. */
  target: string;
  /** Scopes required to access the target. All must be satisfied. */
  requiredScopes: AuthScope[];
  /** Human-readable description of what the target does. */
  description: string;
}

/**
 * Single source of truth mapping every gated route/action to its required
 * scope(s). Guards and tests read from this map; adding a gated route without
 * an entry here fails CI (see scripts/check-authz-coverage.mjs).
 */
export const AUTHZ_MAP: Record<string, AuthzEntry> = {
  "route:/wallet": {
    id: "route:/wallet",
    target: "/wallet",
    requiredScopes: ["wallet:read"],
    description: "View wallet balances and activity",
  },
  "route:/wallet/send": {
    id: "route:/wallet/send",
    target: "/wallet/send",
    requiredScopes: ["wallet:write"],
    description: "Send funds from the connected wallet",
  },
  "route:/developer": {
    id: "route:/developer",
    target: "/developer",
    requiredScopes: ["developer:read"],
    description: "Developer dashboard read access",
  },
  "route:/developer/settings": {
    id: "route:/developer/settings",
    target: "/developer/settings",
    requiredScopes: ["developer:write"],
    description: "Modify developer settings",
  },
  "route:/admin": {
    id: "route:/admin",
    target: "/admin",
    requiredScopes: ["admin:read"],
    description: "Admin console read access",
  },
  "action:admin.updateConfig": {
    id: "action:admin.updateConfig",
    target: "admin.updateConfig",
    requiredScopes: ["admin:write"],
    description: "Update global configuration",
  },
};

/**
 * Resolve the authorization entry for a gated route or action.
 * Returns undefined when the target is not registered, which callers must
 * treat as a denial (fail closed).
 */
export function getAuthzEntry(target: string): AuthzEntry | undefined {
  return AUTHZ_MAP[target];
}

/**
 * Check whether the granted scopes satisfy the required scopes for a target.
 * Fails closed: unknown targets and missing scopes are denied.
 */
export function isAuthorized(
  target: string,
  grantedScopes: readonly AuthScope[],
): boolean {
  const entry = getAuthzEntry(target);
  if (!entry) {
    return false;
  }
  return entry.requiredScopes.every((scope) => grantedScopes.includes(scope));
}

/**
 * Assert that a target is registered. Guards should call this so that a gated
 * route without an authz entry fails loudly instead of silently allowing
 * access.
 */
export function assertRegistered(target: string): AuthzEntry {
  const entry = getAuthzEntry(target);
  if (!entry) {
    throw new Error(
      `Authorization entry missing for gated target "${target}". ` +
        "Register it in AUTHZ_MAP (src/auth/authorization.ts).",
    );
  }
  return entry;
}
