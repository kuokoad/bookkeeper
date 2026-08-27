# How to back up and restore

The routine, what the commands actually do, and what to do on a bad day.

## Prerequisites

Terminal access on the machine running the app, or an owner account for the in-app
download at `/settings/health`.

## What a backup is

The whole business is one file: `data/bookkeeper.db`. Every sale, every payment,
every product, the ledger underneath them, the users and the settings. Copy that
file somewhere safe and you have the shop. Lose it with no copy and there is
nothing to go back to.

```bash
npm run backup
```

That writes a timestamped copy into `backups/`, and it is safe to run while the
shop is trading.

**This is why a backup is a command and not a file copy.** Dragging
`bookkeeper.db` to a USB stick in the file explorer is not a backup. The newest
transactions do not live in that file yet — they sit in `bookkeeper.db-wal`
beside it, waiting to be folded in — so a copy taken on its own is missing the
most recent trading, and a copy taken mid-write can be torn in half. The command
uses SQLite's own online backup instead, which produces one consistent file
without asking the shop to stop.

### Every copy is checked before it counts

A backup nobody has opened is a guess. So the command opens the finished file and
proves three things about it:

- SQLite can read it end to end.
- Nothing in it points at a record that is not there.
- **The books inside the copy still balance** — debits equal credits.

The last one is the one that matters. The first two say the file survived; that
one says the *accounts* survived, which is what the shop actually needs from a
backup.

**A copy that fails is deleted and the command fails loudly.** A broken backup
you believe in is worse than no backup at all, so it is never left in the folder
looking valid. Older backups are trimmed only after a good one exists, so a
failure never leaves you with fewer than you started with.

Each backup is a single self-contained file with no `-wal` or `-shm` companions
beside it. It can be copied to a stick on its own and still be whole.

### The commands

| Command                        | What it does                           |
| ------------------------------ | -------------------------------------- |
| `npm run backup`               | Verified backup, keeping the newest 14 |
| `npm run backup -- --keep=30`  | Keep 30 instead                        |
| `npm run backup -- --dir=E:/`  | Write straight to a USB stick          |
| `npm run db:restore -- <file>` | Put one back (see below)               |

## The daily routine

At close of business:

```bash
npm run backup -- --dir=E:/
```

Point `--dir` at a USB stick. That is the whole routine.

A backup sitting on the same computer does not survive that computer being stolen,
dropped, or having its disk fail — which are the three things you are backing up
against. A copy on the same disk protects you only from your own mistakes, which is
the least likely of the four.

If the shop has no terminal, an owner can download a verified copy from
**Settings → Health**. Same file, same verification.

## Before anything risky

Take one before:

- closing a financial year
- restoring an older backup (so today is recoverable if the restore was the mistake)
- upgrading the app
- any bulk change

```bash
npm run backup
```

## Restoring

```bash
npm run db:restore -- ./backups/bookkeeper-2026-08-26T18-00-00.db --force
```

Stop the app first. The command refuses while it is running.

### Never copy a backup over the database by hand

This is the one instruction on this page that is worth reading twice, because
getting it wrong is silent.

The write-ahead log — `bookkeeper.db-wal` — holds transactions that have not been
folded into the main file yet. Shutting the app down cleanly folds them in and
deletes it. **A power cut does not.** The `-wal` survives, which is the entire
point of the setting that makes this app slower than it needs to be: the last
sales committed before the lights went out are still there.

Now copy a backup over `data/bookkeeper.db` with that `-wal` still lying beside
it. SQLite finds it and replays it into your restored file — putting back exactly
the transactions you were restoring to undo. And the books still balance
afterwards, so nothing warns you. You would only find out by noticing a figure.

The command does it properly, in this order:

1. Verifies the backup **before** touching anything, so a bad file never replaces
   a working database.
2. Refuses if the database is in use.
3. Copies the database it is about to replace to
   `bookkeeper.db.replaced-<timestamp>`, so a restore made in a panic is itself
   undoable.
4. Removes `-wal` and `-shm`, then copies the backup into place.
5. Puts the restored database back into write-ahead mode — backups are stored in
   the plain mode that makes them a single file, and the live database needs the
   other one.
6. Verifies the result, and says where the replaced database is if it does not.

## Practise it once

A backup you have never restored is a hope, not a plan. Once, on a copy:

1. Take a backup.
2. Note today's sales total.
3. Restore a backup from a few days ago.
4. Confirm the total changed to match that day.
5. Restore the backup from step 1 to get back.

Fifteen minutes, once. You will know the routine works and that you can do it under
pressure.

## Verification

After a restore:

- Sign in. The shop name and logo are the ones you expect.
- **Trial balance** balances.
- Recent sales are the ones from the backup's date, not today's.
- **Inventory** shows no red alert.
- `/settings/health` passes its readiness checks.

## Troubleshooting

**The backup command failed and deleted its own output.** Working as intended. Every
backup is verified before it counts, and one that fails is removed rather than left
looking valid. A broken backup you believe in is worse than none. Investigate the
database itself: `npm run preflight`.

**"Refusing while the app is running."** Stop the server, then restore.

**I restored and the books do not balance.** Restore the
`bookkeeper.db.replaced-<timestamp>` file to get back to where you were, then
investigate before trying again.

**Backups are filling the disk.** `npm run backup` keeps the newest 14. Use
`-- --keep=30` for more.

**How far back do I need?** Far enough to cover the gap between a mistake happening
and someone noticing. For a shop filing monthly, a month of dailies plus a keeper at
each month end.

## Related

- [Close a period](close-a-period.md) — take one before closing a year.
- [Commands](../reference/commands.md) — `backup`, `db:restore`, `preflight`.
