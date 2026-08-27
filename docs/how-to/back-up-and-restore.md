# How to back up and restore

The routine, and what to do on a bad day.

The **mechanism** — what the commands do, why a plain file copy is unsafe, and what
verification checks — is in [`README.md` → Backups](../README.md#backups) and not
repeated here. This page is the routine around it.

## Prerequisites

Terminal access on the machine running the app, or an owner account for the in-app
download at `/settings/health`.

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

**Never copy a backup over `data/bookkeeper.db` by hand.** README explains why in
detail; the short version is that the write-ahead log sitting beside the database
gets replayed into your restored file and puts back the very transactions you were
undoing — and the books still balance afterwards, so nothing warns you.

The command keeps the database it replaced as `bookkeeper.db.replaced-<timestamp>`,
so a restore made in a panic is itself undoable.

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

- [`README.md` → Backups](../README.md#backups) — what the commands actually do.
- [Close a period](close-a-period.md) — take one before closing a year.
- [Commands](../reference/commands.md) — `backup`, `db:restore`, `preflight`.
