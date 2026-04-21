# Feature Spec

## Problem
Varix still lacks a real on-chain session primitive for the first signed wallet action that enables later signless or voucher-backed trading.

## User Goal
Let a trader register a temporary session key on Vara with bounded expiry and explicit permissions, so follow-up UX can move from repeated wallet signing toward a Hyperliquid-like trading flow.

## In Scope
- A dedicated Sails `session-registry` program.
- One active session per trader.
- Explicit action permissions for `trade`, `add_margin`, and `withdraw`.
- Query routes that future programs and frontends can use to validate an active session.
- gtest coverage for register, replace, revoke, and expiry behavior.

## Out Of Scope
- Voucher issuance.
- Backend sponsor service.
- Direct integration of session validation into `margin-vault` or `perp-market` in this slice.
- Replay nonce handling for follow-up messages.

## Actors
- Trader
- Session key
- Sponsor backend
- Market / vault programs

## State Changes
- Register a new active session for an owner.
- Replace a prior active session for that same owner.
- Revoke a session.
- Treat expired sessions as inactive in queries.

## Messages And Replies
- `RegisterSession`
- `RevokeSession`
- `ActiveSession`
- `OwnerFor`
- `Validate`

## Events
- `SessionRegistered`
- `SessionRevoked`

## Invariants
- One active session per owner.
- A session key cannot be actively bound to two owners.
- Expired sessions must fail validation.
- Session permissions are explicit and opt-in.

## Edge Cases
- Replacing an existing owner session.
- Reusing a session key already bound to another owner.
- Expiry exactly at the current block height.
- Revocation after the session is already expired.

## Acceptance Criteria
`session-registry` compiles as a standard Sails app, emits an IDL, and has green gtests proving:
- register + validate works
- replace removes the old active mapping
- revoke clears the session
- expired sessions query as inactive
