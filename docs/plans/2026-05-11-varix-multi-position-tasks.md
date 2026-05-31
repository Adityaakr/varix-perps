# Task Plan

1. Replace single-slot trader position storage in `contracts/perp-market` with id-keyed hedge-mode storage.
2. Extend market events and queries so the frontend can identify and act on specific positions.
3. Update `gtest` and local-node tests for multi-position open, targeted close, and query behavior.
4. Refresh generated Sails client artifacts and the frontend IDL snapshot.
5. Update the Vara frontend hook and position UI to read lists of positions and close by `position_id`.
6. Run contract tests and web typecheck.
7. Redeploy the updated contracts to Vara testnet and write the new program ids to the testnet env file.
