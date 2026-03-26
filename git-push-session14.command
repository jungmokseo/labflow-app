#!/bin/bash
# Session #14 — Clerk Auth Integration commit & push
cd "$(dirname "$0")"

echo "=== LabFlow Session #14: Clerk Auth Integration ==="
echo ""

# Stage all changes
git add -A

# Commit
git commit -m "feat: Clerk auth integration — middleware, sign-in/sign-up, mobile auth

Session #14 changes:
- web/src/middleware.ts: Clerk middleware (protected/public routes)
- web/src/app/layout.tsx: ClerkProvider + auth-conditional sidebar
- web/src/app/sign-in: Clerk SignIn component page
- web/src/app/sign-up: Clerk SignUp component page
- web/src/app/Sidebar.tsx: UserButton + dynamic user info from Clerk
- web/src/lib/api.ts: Bearer token auth via Clerk getToken()
- web/src/components/AuthInit.tsx: Clerk token → API client bridge
- server/src/config/env.ts: Updated CORS defaults for Vercel
- server/package.json: Added @clerk/backend dependency
- src/providers/AuthProvider.tsx: expo-secure-store tokenCache
- app/_layout.tsx: Slot-based layout for auth routing
- app/index.tsx: Auth gate (Clerk → sign-in, Dev → tabs)
- src/screens/SignInScreen.tsx: Mobile sign-in/sign-up screen"

# Push
git push origin main

echo ""
echo "=== Done! Press any key to close ==="
read -n 1
