# Architecture

## Decision
Add a dedicated `session-registry` Sails program rather than overloading `margin-vault` or `perp-market`.

## Why
- Session state is cross-cutting and should not be owned by one market.
- The signless lifecycle is separate from collateral and position logic.
- This keeps later voucher and sponsor integration isolated from market math.

## Program Boundary

### `session-registry`
- Stores owner -> active session mapping.
- Stores session key -> owner reverse mapping.
- Validates expiry and permission checks.
- Emits registration and revocation events.

## Public Interface

### Commands
- `RegisterSession(session_key, expires_at, permissions)`
- `RevokeSession(session_key)`

### Queries
- `ActiveSession(owner) -> Option<SessionRecord>`
- `OwnerFor(session_key) -> Option<ActorId>`
- `Validate(owner, session_key, action) -> bool`

## Data Model

### `SessionPermissions`
- `trade: bool`
- `add_margin: bool`
- `withdraw: bool`

### `SessionRecord`
- `owner: ActorId`
- `session_key: ActorId`
- `expires_at: u32`
- `permissions: SessionPermissions`
- `registered_at: u32`

## Message Flow

1. Trader signs `RegisterSession` from the main wallet.
2. Program stores the active session and replaces any older session for that owner.
3. Future frontend or program logic checks `Validate`.
4. Trader can sign `RevokeSession`, or the session naturally expires by block height.

## Integration Path

### Frontend
- Add a first signed “register session” action in Vara mode.
- Persist the returned session key and expiry in client state.
- Keep wallet-signed commands as the current fallback until signless execution lands.

### Future Vault / Market Integration
- Accept session-owned calls.
- Resolve the underlying owner by querying `session-registry`.
- Enforce action-level permission checks before state mutation.

## Guardrails
- No silent infinite sessions.
- No hidden wildcard permissions.
- No multi-owner session key reuse.
