import { type ReactElement, type ReactNode } from 'react'
import { useAuth } from './AuthContext'
import { LoginButtons } from './LoginButtons'
import { requiredScopeFor, type GatedRoute } from './authz'

/**
 * Gates a developer feature (API keys, webhooks, …) behind a verified SSO
 * session (#501, acceptance criterion: "Gate developer features behind a
 * verified session"). Renders sign-in prompts instead of the feature until
 * `useAuth()` reports an authenticated session.
 *
 * Authorization (#686): authentication alone is not enough. Each gated
 * feature declares its `route` so the required scope is looked up in the
 * centralized `authz` mapping. An authenticated-but-unauthorized user is
 * denied here, proving the gate checks authz, not just authn.
 */
export function DeveloperAuthGate({
  children,
  feature = 'this feature',
  route,
}: {
  children: ReactNode
  feature?: string
  route: GatedRoute
}): ReactElement {
  const { status, scopes } = useAuth()

  if (status === 'loading') {
    return <div className="py-6 text-center text-sm text-gray-500">Checking session…</div>
  }

  if (status === 'unauthenticated') {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <p className="text-sm text-gray-400 max-w-xs">
          Sign in to access {feature}. Developer features require a verified session.
        </p>
        <LoginButtons />
      </div>
    )
  }

  const requiredScope = requiredScopeFor(route)
  if (!scopes.includes(requiredScope)) {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <p className="text-sm text-gray-400 max-w-xs">
          You do not have permission to access {feature}. This action requires the{' '}
          <code className="text-gray-300">{requiredScope}</code> scope.
        </p>
      </div>
    )
  }

  return <>{children}</>
}
