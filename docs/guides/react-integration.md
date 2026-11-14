---
id: react-integration
title: React Integration Guide
sidebar_label: React Integration
sidebar_position: 1
---

# Full React Integration Guide

Build a complete wallet sign-in, DID profile, and verifiable credential flow in React 18/19 or Next.js (App Router) using `stellar-id-frontend` and `stellar-id-client`.

> **Network status — Stellar testnet only (`v0.x`).** Every example in this guide targets the deployed Soroban testnet contract (`CB2ZHW3TBCVXQ22CLWUTIOJVCIS4CLGFX4WHLZQ663XSGKVYKFUBLZAT`, RPC `https://soroban-testnet.stellar.org`, passphrase `Test SDF Network ; September 2015`). Never pass mainnet secrets or real funds.
>
> **Wallet support note.** The end-to-end flow is tested live on testnet using `KeypairSigner` with a Friendbot-funded throwaway keypair (as in the [hosted demo](https://stellar-ids.github.io/frontend/)). `WalletsKitSigner` is unit-tested against a mock wallet kit; real browser-extension wallets (Freighter, xBull, Albedo, LOBSTR) have not yet been verified live, and message-signing support varies across wallets.

---

## 1. How the Pieces Fit Together

`stellar-id-frontend` wraps `stellar-id-client` in React state and accessible UI components, while keeping session tokens and authorization under your backend's control:

```text
1. First-time DID onboarding (once per Stellar testnet address)
   React App ──► resolveIdentity("did:stellar:testnet:G...") ──► Soroban RPC
             ◄── DidNotFoundError ──────────────────────────────
   React App ──► createIdentity({ signer, keys: [key-1] }) ────► Wallet signs tx ──► Soroban RPC

2. Client-side UI session (SessionProvider + IdentityLogin)
   User clicks "Sign in" ──► createChallenge({ domain, address })
                         ──► signer.signMessage(challengeBytes(challenge))
                         ──► verifyChallengeResponse(...) against DID's authentication keys
                         ──► Session status = "authenticated"

3. Production access control (Server-verified session)
   React App ──► POST /api/auth/challenge ──► Backend issues Challenge (Persistent NonceStore)
   Wallet    ──► signMessage(challengeBytes(challenge))
   React App ──► POST /api/auth/verify ─────► Backend runs verifyChallengeResponse(...)
                                          ──► Backend sets HttpOnly / Secure session cookie
```

---

## 2. Project Setup

### Install published packages

Install the React package, the TypeScript SDK, the matching `@stellar/stellar-sdk` range, and `buffer` (needed in browser bundlers that do not polyfill Node's `Buffer`):

```bash
pnpm add stellar-id-frontend stellar-id-client @stellar/stellar-sdk@^16.4.1 buffer
```

`stellar-id-frontend` declares `react` and `react-dom` (`^18.0.0 || ^19.0.0`) as peer dependencies.

### Import the stylesheet and polyfill `Buffer`

Import `stellar-id-frontend/styles.css` once at the root of your client tree so the `--sid-*` design tokens and component styles load. In browser entrypoints, attach `Buffer` to `globalThis` before invoking SDK helpers that decode keys:

```tsx
// app/providers.tsx
"use client";

import "stellar-id-frontend/styles.css";
import { Buffer } from "buffer";
import type { ReactNode } from "react";
import { SessionProvider } from "stellar-id-frontend";
import type { Signer } from "stellar-id-client";

if (typeof globalThis.Buffer === "undefined") {
  (globalThis as Record<string, unknown>)["Buffer"] = Buffer;
}

export function AppSessionProvider({
  children,
  createSigner,
}: {
  children: ReactNode;
  createSigner: () => Signer | Promise<Signer>;
}) {
  return (
    <SessionProvider
      config={{
        createSigner,
        // Optional: defaults to testnetConfig()
        // network: testnetConfig(),
        // Optional: defaults to window.location.hostname in browsers
        // domain: "app.example.com",
      }}
    >
      {children}
    </SessionProvider>
  );
}
```

### Next.js App Router & SSR notes

- Every interactive module in `stellar-id-frontend` begins with `"use client"` and avoids reading `window` at module import time.
- Wrap your client providers in a `"use client"` boundary (such as `app/providers.tsx`) and render that wrapper inside your Server Component `app/layout.tsx`.

---

## 3. Registering a DID Before Sign-In

Sign-in verifies the wallet's Ed25519 signature against a key listed in the account's **on-chain `authentication` relationship**. If the Stellar account has not registered a `did:stellar` record yet, sign-in fails with `DidNotFoundError`.

Check whether the connected account already owns a DID and register one if needed:

```ts
// lib/ensure-did.ts
import { StrKey } from "@stellar/stellar-sdk";
import {
  DidNotFoundError,
  createIdentity,
  resolveIdentity,
  testnetConfig,
} from "stellar-id-client";
import type { NetworkConfig, Signer } from "stellar-id-client";

/**
 * Ensure the signer's Stellar address has an active on-chain DID.
 * Registers `key-1` (added to both `authentication` and `assertionMethod`)
 * when no DID exists yet.
 */
export async function ensureDidRegistered(
  signer: Signer,
  network: NetworkConfig = testnetConfig(),
): Promise<string> {
  const address = await signer.publicKey();
  const did = `did:stellar:${network.network}:${address}`;

  try {
    await resolveIdentity(did, { network });
    return did;
  } catch (err) {
    if (!(err instanceof DidNotFoundError)) {
      throw err;
    }
  }

  // Decode the G... public key into raw 32-byte Ed25519 hex (64 hex chars).
  const publicKeyHex = StrKey.decodeEd25519PublicKey(address).toString("hex");
  const created = await createIdentity({
    signer,
    network,
    keys: [{ id: "key-1", publicKeyHex }],
  });
  return created.did;
}
```

### Choosing a `Signer` during development vs. browser wallets

- **Local testnet development & E2E tests (verified live):** Generate a throwaway keypair, fund it via Friendbot, wrap it in `KeypairSigner.fromSecret(pair.secret())`, and run `ensureDidRegistered(signer)` before mounting your sign-in flow:

  ```ts
  import { Keypair } from "@stellar/stellar-sdk";
  import { KeypairSigner } from "stellar-id-client";
  import { ensureDidRegistered } from "./ensure-did";

  export async function createFundedThrowawaySigner(): Promise<KeypairSigner> {
    const pair = Keypair.random();
    const res = await fetch(`https://friendbot.stellar.org?addr=${pair.publicKey()}`);
    if (!res.ok) {
      throw new Error(`Friendbot failed with HTTP ${res.status}`);
    }
    const signer = KeypairSigner.fromSecret(pair.secret());
    await ensureDidRegistered(signer);
    return signer;
  }
  ```

- **Browser wallet adapter (`WalletsKitSigner`):** Pass an initialized `@creit.tech/stellar-wallets-kit` instance to `new WalletsKitSigner(kit)`. Never bundle secret seeds (`S...`) in production client code.

---

## 4. `SessionProvider` and `IdentityLogin`

### Drop-in sign-in with `IdentityLogin`

`IdentityLogin` drives `SessionProvider` through `disconnected → connecting → connected → authenticating → authenticated` (or `error`), narrates status changes via `aria-live="polite"`, and renders a **Sign out** button once authenticated:

```tsx
// components/AuthBar.tsx
"use client";

import { IdentityLogin } from "stellar-id-frontend";

export function AuthBar({ onSignedIn }: { onSignedIn?: (did: string) => void }) {
  return (
    <header>
      <IdentityLogin
        label="Sign in with Stellar"
        onAuthenticated={(did) => {
          onSignedIn?.(did);
        }}
      />
    </header>
  );
}
```

`onAuthenticated(did)` fires once per sign-in transition when `status` reaches `"authenticated"`.

### Custom sign-in controls with session hooks

When you need custom markup instead of `IdentityLogin`, combine the four session hooks:

| Hook | Return shape | When to use |
|---|---|---|
| `useSession()` | `{ status, address, did, error }` | Inspect full lifecycle state and typed `StellarIdError` failures |
| `useSessionActions()` | `{ connect, signIn, disconnect }` | Trigger wallet connection, challenge sign-in, or sign-out |
| `useIdentity()` | `{ did, address, status }` | Read the authenticated DID and Stellar `G...` address |
| `useIdentityStatus()` | `{ status, isConnected, isAuthenticated }` | Lightweight boolean checks for conditional rendering |

```tsx
// components/CustomWalletButton.tsx
"use client";

import {
  useIdentity,
  useIdentityStatus,
  useSession,
  useSessionActions,
} from "stellar-id-frontend";

export function CustomWalletButton() {
  const { error } = useSession();
  const { did, address } = useIdentity();
  const { status, isConnected, isAuthenticated } = useIdentityStatus();
  const { connect, signIn, disconnect } = useSessionActions();

  if (isAuthenticated && did !== null) {
    return (
      <div>
        <span>Signed in: {did}</span>
        <button type="button" onClick={disconnect}>
          Disconnect
        </button>
      </div>
    );
  }

  const busy = status === "connecting" || status === "authenticating";

  return (
    <div>
      {!isConnected ? (
        <button type="button" onClick={() => void connect()} disabled={busy}>
          {status === "connecting" ? "Connecting wallet…" : "1. Connect Wallet"}
        </button>
      ) : (
        <button type="button" onClick={() => void signIn()} disabled={busy}>
          {status === "authenticating"
            ? "Waiting for signature…"
            : `2. Sign in (${address?.slice(0, 6)}…)`}
        </button>
      )}
      {status === "error" && error !== null && (
        <p role="alert">{error.message}</p>
      )}
    </div>
  );
}
```

---

## 5. Resolving DIDs and Verifying Credentials

### `IdentityProfile` and `useDidDocument`

- `<IdentityProfile />` reads the active session DID from `SessionProvider` (or an explicit `did` prop override) and renders its verification methods and service endpoints.
- `useDidDocument(did, opts?)` gives you direct access to `{ data, error, status, refetch }` with in-memory caching and in-flight request deduplication. Pass `null` to keep the hook `"idle"`:

```tsx
// components/DidInspector.tsx
"use client";

import { useDidDocument, useIdentity } from "stellar-id-frontend";

export function DidInspector() {
  const { did } = useIdentity();
  const { data, error, status, refetch } = useDidDocument(did);

  if (status === "idle") {
    return <p>Sign in to inspect your DID document.</p>;
  }
  if (status === "loading") {
    return <p role="status">Resolving DID from Soroban testnet…</p>;
  }
  if (status === "error" || data === null) {
    return (
      <div role="alert">
        <p>Resolution failed: {error?.message}</p>
        <button type="button" onClick={refetch}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <section aria-label="DID metadata">
      <p>Version: {data.didDocumentMetadata?.versionId ?? 1}</p>
      <p>Keys registered: {data.didDocument?.verificationMethod.length ?? 0}</p>
      <button type="button" onClick={refetch}>
        Refresh from chain
      </button>
    </section>
  );
}
```

### `CredentialBadge` and `useCredential`

`<CredentialBadge credential={vc} refreshToken={nonce} />` verifies an off-chain W3C `VerifiableCredential` (local Ed25519 proof check plus on-chain anchor/revocation/expiry lookup) and announces **Valid credential**, **Revoked credential**, **Expired credential**, or **Unknown credential** as visible text.

When your app revokes a credential on-chain with `revokeCredential(hash, { issuerSigner })`, increment `refreshToken` (on `CredentialBadge`) or `cacheSuffix` (on `useCredential`) to bypass the signature cache and re-read on-chain status:

```tsx
// components/CredentialCard.tsx
"use client";

import { useState } from "react";
import { CredentialBadge } from "stellar-id-frontend";
import { revokeCredential } from "stellar-id-client";
import type { Signer, VerifiableCredential } from "stellar-id-client";

export function CredentialCard({
  credential,
  hashHex,
  issuerSigner,
}: {
  credential: VerifiableCredential;
  hashHex: string;
  issuerSigner: Signer;
}) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [revoking, setRevoking] = useState(false);

  const handleRevoke = async () => {
    setRevoking(true);
    try {
      await revokeCredential(hashHex, { issuerSigner });
      setRefreshToken((n) => n + 1);
    } finally {
      setRevoking(false);
    }
  };

  return (
    <article>
      <CredentialBadge credential={credential} refreshToken={refreshToken} />
      <button type="button" onClick={() => void handleRevoke()} disabled={revoking}>
        {revoking ? "Revoking…" : "Revoke credential"}
      </button>
    </article>
  );
}
```

---

## 6. Route Gating (`withAuth`) vs. Server-Side Sessions

### Client-side UX gating with `withAuth`

`withAuth` wraps a component so unauthenticated visitors see a fallback instead of an empty or broken view:

```tsx
// components/ProtectedSettings.tsx
"use client";

import { IdentityLogin, IdentityProfile, withAuth } from "stellar-id-frontend";

function SettingsBody() {
  return <IdentityProfile />;
}

export const ProtectedSettings = withAuth(SettingsBody, {
  fallback: (
    <section>
      <p>Sign in with your Stellar identity to view settings.</p>
      <IdentityLogin />
    </section>
  ),
});
```

> **Security boundary — `withAuth` and `SessionProvider` are client-side UX only.** `SessionProvider` verifies challenges in the browser using an in-memory `InMemoryNonceStore`. Any user controls their own browser memory and can call your backend endpoints directly. Never authorize API writes, private data reads, or session cookies solely from client-side state.

### Server-side challenge verification

To issue a real backend session (cookie or JWT), run `createChallenge` and `verifyChallengeResponse` from `stellar-id-client` **on your server** with a persistent `NonceStore` (for example Redis or PostgreSQL so nonces cannot be replayed across server instances or restarts):

```ts
// server/auth.ts (Node.js / Next.js Route Handler)
import {
  createChallenge,
  testnetConfig,
  verifyChallengeResponse,
} from "stellar-id-client";
import type { Challenge, ChallengeResponse, NonceStore } from "stellar-id-client";

/**
 * Replace this backing store with Redis (`EXISTS` / `SET ... EX 300`) or a
 * database table with a unique constraint in multi-instance deployments.
 */
class PersistentNonceStoreAdapter implements NonceStore {
  private readonly seen = new Set<string>();

  async has(nonce: string): Promise<boolean> {
    return this.seen.has(nonce);
  }

  async add(nonce: string): Promise<void> {
    this.seen.add(nonce);
  }
}

const nonceStore = new PersistentNonceStoreAdapter();
const APP_DOMAIN = "app.example.com";

export function issueLoginChallenge(address: string): Challenge {
  return createChallenge({
    domain: APP_DOMAIN,
    address,
    ttlSeconds: 300,
  });
}

export async function verifyLoginSubmission(response: ChallengeResponse) {
  // Resolves `did:stellar:testnet:<address>`, verifies the Ed25519 signature
  // against an `authentication` key, checks domain + expiry, and consumes nonce.
  const authenticated = await verifyChallengeResponse(
    { ...response, domain: APP_DOMAIN },
    { network: testnetConfig(), nonceStore },
  );

  // Issue your own HttpOnly, Secure, SameSite=Lax session cookie keyed to `authenticated.did`.
  return authenticated; // { did, address }
}
```

On the client, request the challenge from your backend, sign `challengeBytes(challenge)` with `signer.signMessage`, convert the `Uint8Array` signature with `toHex(signature)` from `stellar-id-frontend`, and `POST` `{ challenge, address, signatureHex, domain }` to your verification endpoint.

---

## 7. Error Handling: Mapping SDK Errors to UI

`stellar-id-frontend` re-exports `StellarIdError` and every typed subclass from `stellar-id-client` so your UI can branch with `instanceof` from a single import.

| Error class | `error.code` | Typical cause | Retryable? | Recommended UI response |
|---|---|---|---|---|
| `WalletError` | `"WALLET"` | Wallet locked, user rejected prompt, or wallet lacks `signMessage` | Yes (user action) | Prompt the user to unlock their wallet or approve the signature request, or switch to a wallet supporting message signing. |
| `DidNotFoundError` | `"DID_NOT_FOUND"` | Stellar address has not registered an on-chain DID yet | After onboarding | Guide the user through a one-time "Register Stellar ID" step calling `createIdentity`. |
| `DidDeactivatedError` | `"DID_DEACTIVATED"` | DID was permanently deactivated (`deactivate_did`) | No | Explain that this identity was deactivated and ask the user to connect a different Stellar account. |
| `DidParseError` | `"DID_PARSE"` | Malformed DID string or invalid Stellar `G...` strkey | No | Show inline field validation (`did:stellar:testnet:G...`). |
| `InvalidProofError` | `"INVALID_PROOF"` | Expired/replayed challenge, domain mismatch, or key missing from `authentication` | Fresh challenge | Offer a "Try signing in again" button that requests a fresh challenge; verify `config.domain` matches your hostname. |
| `CredentialRevokedError` | `"CREDENTIAL_REVOKED"` | Issuer revoked the credential hash on-chain | No | Render a clear revoked state (`CredentialBadge` handles this automatically). |
| `CredentialExpiredError` | `"CREDENTIAL_EXPIRED"` | Credential `expirationDate` or on-chain `expires_at` has passed | No | Prompt the user to request a renewed credential from the issuer. |
| `SimulationError` | `"SIMULATION"` | Soroban simulation rejected a write (`AlreadyExists`, `LimitExceeded`, unauthorized signer) | No (fix input) | Surface the rejection reason without re-submitting; never ask the user to sign a failing transaction. |
| `NetworkError` | `"NETWORK"` | Testnet RPC timeout, HTTP 5xx, or offline browser | Yes | Show a non-destructive retry banner (`refetch()` or retry button). |

### Reusable UI error mapper

```ts
// lib/error-messages.ts
import {
  CredentialExpiredError,
  CredentialRevokedError,
  DidDeactivatedError,
  DidNotFoundError,
  DidParseError,
  InvalidProofError,
  NetworkError,
  SimulationError,
  StellarIdError,
  WalletError,
} from "stellar-id-frontend";

export interface UiErrorNotice {
  title: string;
  detail: string;
  retryable: boolean;
}

export function mapStellarIdError(err: unknown): UiErrorNotice {
  if (err instanceof WalletError) {
    return {
      title: "Wallet action required",
      detail: "Unlock your Stellar wallet and approve the request, then try again.",
      retryable: true,
    };
  }
  if (err instanceof DidNotFoundError) {
    return {
      title: "No Stellar ID found for this account",
      detail: "Register an on-chain DID for your testnet address before signing in.",
      retryable: false,
    };
  }
  if (err instanceof DidDeactivatedError) {
    return {
      title: "Identity deactivated",
      detail: "This DID has been permanently deactivated and cannot sign in.",
      retryable: false,
    };
  }
  if (err instanceof DidParseError) {
    return {
      title: "Invalid DID format",
      detail: err.message,
      retryable: false,
    };
  }
  if (err instanceof InvalidProofError) {
    return {
      title: "Sign-in verification failed",
      detail: "The sign-in challenge expired or the signing key is not authorized for authentication.",
      retryable: true,
    };
  }
  if (err instanceof CredentialRevokedError) {
    return {
      title: "Credential revoked",
      detail: "The issuer has permanently revoked this credential.",
      retryable: false,
    };
  }
  if (err instanceof CredentialExpiredError) {
    return {
      title: "Credential expired",
      detail: "This credential is past its expiration timestamp.",
      retryable: false,
    };
  }
  if (err instanceof SimulationError) {
    return {
      title: "Contract rejected transaction",
      detail: err.message,
      retryable: false,
    };
  }
  if (err instanceof NetworkError) {
    return {
      title: "Stellar testnet RPC unreachable",
      detail: "Check your connection and retry in a few seconds.",
      retryable: true,
    };
  }
  if (err instanceof StellarIdError) {
    return {
      title: `Identity error (${err.code})`,
      detail: err.message,
      retryable: false,
    };
  }
  return {
    title: "Unexpected error",
    detail: err instanceof Error ? err.message : String(err),
    retryable: false,
  };
}
```

---

## 8. Theming and Hermetic Component Testing

### Dark mode and CSS custom properties

Components never hardcode hex colors; override `--sid-*` variables in your stylesheet and toggle dark mode by setting `data-sid-theme="dark"` on `<html>` or any container element:

```css
:root {
  --sid-color-primary: #0f766e;
  --sid-radius: 0.375rem;
}
```

### Testing components without hitting Soroban RPC

Both `IdentityProfileView` and `CredentialBadge` accept injectable async readers (`resolve` and `verify`), keeping Vitest / Jest / Storybook suites fast and offline. Because `useDidDocument` caches by DID and `useCredential` caches by `proof.signatureHex`, use a distinct DID or signature per test case:

```tsx
import { render, screen } from "@testing-library/react";
import { IdentityProfileView } from "stellar-id-frontend";

it("renders a resolved DID document offline", async () => {
  const did = "did:stellar:testnet:GTESTEXAMPLE";
  render(
    <IdentityProfileView
      did={did}
      resolve={async () => ({
        did,
        didDocument: {
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: did,
          verificationMethod: [],
          authentication: [],
          assertionMethod: [],
          service: [],
        },
        didResolutionMetadata: { contentType: "application/did+ld+json" },
        didDocumentMetadata: {
          created: 1,
          updated: 1,
          versionId: 1,
          method: { stellarAccount: "GTESTEXAMPLE" },
        },
      })}
    />,
  );

  expect(await screen.findByText(did)).toBeInTheDocument();
});
```

---

**Next:** [Frontend API Reference](../api/frontend.md) · [Security Basics](../security/basics.md) · [Migration from Password/OAuth](../migration/from-auth.md)
