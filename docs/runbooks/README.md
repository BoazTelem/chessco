# Chessco operator runbooks

These runbooks codify what to do when something specific happens. Each one is short on purpose — a runbook that doesn't fit on one screen during an incident is the wrong shape.

Pinned runbooks (spec §22):

| Runbook                                                                | When to use                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| [fide-ingestion.md](./fide-ingestion.md)                               | Monthly FIDE crawl failed, partial, or row count drifted. |
| [engine-cheating-investigation.md](./engine-cheating-investigation.md) | Fairplay queue surfaces a high-severity flag.             |
| [account-takeover.md](./account-takeover.md)                           | A user reports unauthorized access.                       |
| [gdpr-data-request.md](./gdpr-data-request.md)                         | Article 15 (access) or Article 17 (erasure) request.      |
| [account-deletion.md](./account-deletion.md)                           | A user requested account deletion via UI or email.        |
| [database-restore.md](./database-restore.md)                           | Supabase or Cloud SQL needs point-in-time restore.        |
| [incident-response.md](./incident-response.md)                         | Production is degraded or down.                           |
| [daily-finance-reconciliation.md](./daily-finance-reconciliation.md)   | The daily ledger reconciliation job failed or alerted.    |

Each runbook follows the same shape: **When → Goal → Steps → Verify → Escalate**.
