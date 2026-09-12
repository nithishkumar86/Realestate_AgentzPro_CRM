# Meta lead processing correction

Migration: `supabase/migrations/20260908131754_harden_meta_lead_processing.sql`.

The migration and the retrieval, webhook, and recovery service changes must be released together. Pause dispatch/retrieval/recovery processing during the database/code cutover. The migration removes unsafe RPC signatures and invalidates legacy processing attempts; old workers fail closed. Resume processing with the updated services and run recovery after the cutover. Do not deploy the new application code against the old schema.

No production migration has been applied by this work. Verify the target migration history and schema before scheduling a production cutover.

## Local regression tests

Run `scripts/test-meta-lead-processing.ps1` with PowerShell. PostgreSQL 17 must be installed; `-PostgreSqlBin` overrides its bin directory. Use `-TemporaryDirectory D:/AgentzPro_crm/node_modules/.cache` to keep the disposable database off C:.

The runner creates a new loopback-only PostgreSQL cluster, applies the repository migration chain, executes `scripts/sql/meta-lead-processing-regression.sql`, and stops the cluster in a finally block. It never reads application database credentials. Supabase-managed auth objects and roles are simulated locally. Test cluster files and logs are retained at the reported path.

The SQL tests execute deterministic race interleavings: duplicate claims, expired workers before/after recovery, stale completion and retry, sixth-attempt exhaustion, NULL retry rejection, initial and recovery dispatch races, disconnect, actual reconnect, current-token invalidation, ad fallback with project mapping, and RPC privileges.

The TypeScript protocol tests are in `src/lib/server/lead-processing-protocol.test.ts`; run these with the existing retrieval and webhook test files using Vitest. They verify the claim, Page generation, and dispatch generation values passed by each service.
