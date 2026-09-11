# parked/ — code kept out of the build on purpose

These modules are **not** in `tsconfig.json` `include` nor `vitest.config.ts`, so
they are neither type-checked nor run. They are kept in the tree (not deleted)
because they are a complete, tested implementation of a feature we expect to
revive.

## Automatic host failover (parked 2026-09)

`peer-node.ts`, `failover.ts`, `heir-probe.ts` and their tests implemented
Phase 2: when the host process died, a peer was promoted to host (new `epoch`),
the survivors re-homed to it, and a UDP `heir_probe` prevented split-brain.

It was parked when signaling moved to the hosted relay (docs/DESIGN.md §2.2 /
§18). With the relay, "the host" is just the peer holding the relay's host slot;
if its WebSocket drops, the relay ends the room (no reconnect grace in v1). A
future version can bring failover back by having the relay hand the host slot to
a designated successor instead of closing the room — at which point most of this
code applies again, but re-homing becomes "reconnect to the same relay URL with
a successor token" rather than "dial the heir's IP:port".

Imports in these files were repointed at `../src/...` when they moved here; treat
them as a starting point, not as currently-correct.
