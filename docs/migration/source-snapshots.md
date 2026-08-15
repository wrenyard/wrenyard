# Source Snapshots

This document records the provenance of the source components assembled in a
private staging monorepo on 2026-08-15 and exported into the public repository
as one audited clean-history snapshot.

| Component | Source repository | Branch | Full SHA | Import method |
| --- | --- | --- | --- | --- |
| `services/foreman` | Foreman | `foreman/wrenmono` | `787d91b244cdb01c4a130887ca39c9ffe476275b` | In-place staging migration; clean snapshot export |
| `runtime/forge` | Forge | `master` | `15d9c3f71edac4866e23fd8441cdef1edec3b4e9` | git archive tracked snapshot |
| `apps/pet` | Pet | `main` | `06112cfdeaa824409086051db2cea6c122728f92` | git archive tracked snapshot |

## Import exclusions

The following were not imported for any component:

- Git histories (all components enter the public repository only as audited
  tracked snapshots)
- `.git` directories and any nested repositories
- Ignored and untracked files
- Build outputs, `node_modules`, `dist`, and other generated artifacts
- User configuration, credentials, and local state
- Per-component `package-lock.json` files (removed; the suite uses one pnpm lockfile)
