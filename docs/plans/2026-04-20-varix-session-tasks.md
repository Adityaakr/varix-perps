# Task Plan

1. Add a new `session-registry` Sails workspace with app, client, and test crates.
2. Implement register, revoke, and validation logic with expiry-aware queries.
3. Emit session lifecycle events.
4. Generate the Rust client and IDL through standard `build.rs`.
5. Add gtests for register, replace, revoke, and expiry.
6. Wire frontend env/docs to acknowledge the new program as the first signed session step.
