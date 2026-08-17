# Deploying to Hostinger from GitHub

For Hostinger **Business** web hosting or **Cloud** (Node.js is not available on
the Single or Premium shared plans). Everything below also applies to any host
that builds from git and gives you no terminal.

---

## The one thing that decides whether this works

**`DATABASE_PATH` must point outside the application folder.**

Hostinger deploys into `/home/{username}/domains/{domain}/nodejs`. Every deploy
rewrites that folder. If the database sits inside it, **a redeploy destroys the
shop's accounts** — every sale, every payment, gone, with no error to warn you.

So put it in the home directory, beside the app rather than inside it:

```
DATABASE_PATH=/home/YOUR_USERNAME/bookkeeper-data/bookkeeper.db
```

The application creates that directory on first start if it does not exist.

> **Verify this before you trade on it.** Deploy, sign in, record one sale, then
> press Deploy again. If the sale is still there, you are safe. If it is gone,
> stop — the plan cannot hold your records, and you need a VPS with a persistent
> disk instead. Test this while the only thing you can lose is a fake sale.

---

## There is no terminal, and the app is built for that

Hostinger runs `npm install` and the build for you, but you cannot run commands.
`npm run db:migrate`, `db:seed`, `backup` and `preflight` are all unavailable —
so the app does those itself:

| Normally a command | On a managed host |
| --- | --- |
| `npm run db:migrate` | Runs at server start ([src/instrumentation.ts](src/instrumentation.ts)) |
| `npm run db:seed` | The chart of accounts is seeded at start too. **Demo data is never seeded** |
| `npm run backup` | **Settings → Health & backup → Download a backup** |
| `npm run preflight` | **Settings → Health & backup** |

Startup is safe to repeat: migrations are versioned, and the seed checks for
each row before inserting. A restart never resets your shop.

If the database cannot be prepared, the server **refuses to start** rather than
serving pages against a half-built schema. Check the deployment log.

---

## Steps

### 1. Connect the repository

In hPanel: **Websites → your domain → Node.js → Create application**, choose
**GitHub**, and select `kuokoad/bookkeeper` and the `main` branch. The repo is
private, so authorise Hostinger's GitHub access when prompted.

Next.js is detected automatically. Build and start commands are the defaults:

- Build: `npm run build`
- Start: `npm start`
- Node version: **22 or 24** (the app requires 22 or newer; CI tests both)

### 2. Set the environment variables

Under the application's **Environment variables**:

| Variable | Value | Why |
| --- | --- | --- |
| `SESSION_SECRET` | 64 random hex characters | Signs sessions. **Generate a fresh one** — never reuse the one from your PC |
| `DATABASE_PATH` | `/home/YOUR_USERNAME/bookkeeper-data/bookkeeper.db` | Outside the deploy folder. See above |
| `NODE_ENV` | `production` | Keeps developer error detail off the screen |
| `SEED_DEMO_DATA` | `false` | Demo records must never enter real books |
| `COOKIE_SECURE` | `true` | Hostinger serves over HTTPS, so the session cookie should be HTTPS-only |

Generate the secret on your own machine:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`.env` is git-ignored and is never deployed. These values live only in hPanel.

### 3. Deploy, then set up the shop

Press Deploy. On first visit the site opens the **setup screen** to create your
shop and its owner account. That screen closes permanently once an owner exists.

### 4. Check it before trusting it

Go to **Settings → Health & backup**. Every check should read OK. Then do the
redeploy test described at the top of this page.

### 5. Take a backup, and keep taking them

**Settings → Health & backup → Download a backup.** The file is verified before
you get it: it must open, its foreign keys must be intact, and the books inside
it must balance. A copy that fails is discarded rather than handed over.

Do this at the end of each trading day and keep the files somewhere other than
the server. There is no cron on this plan, so nothing will do it for you.

To restore, put the downloaded file back at `DATABASE_PATH` with the app
stopped. Each backup is one self-contained file — no companions to remember.

---

## Notes

**`output: 'standalone'` is deliberately not used.** It is for shipping a
prebuilt folder without `npm install`, which is not how a git deploy works. It
also copies the project root when it cannot trace paths built from
`process.cwd()` — locally that put `.env` and `data/bookkeeper.db` inside
`.next/standalone`, i.e. the session secret and the entire set of accounts in a
folder someone might reasonably zip and upload. If you ever do use standalone,
delete `.env`, `data/` and `backups/` from the output first.

**Do not use hPanel's "upload a compressed project" option** for the same
reason: it would upload your local `.env` and `data/` folder. Deploy from git,
where both are ignored.

**Restarts are harmless.** SQLite is configured with `synchronous = FULL`, so a
committed sale survives the process being killed mid-request.

**One shop per deployment.** The application holds one set of books; running two
sites against one database file is not supported.

---

## If something goes wrong

| Symptom | Cause |
| --- | --- |
| Build fails on `better-sqlite3` | The Node version is below 22, or no prebuilt binary matched. Set Node to 22 or 24 and redeploy |
| Site loads but every page errors | The database could not be prepared. Read the deployment log — the reason is printed with the path it tried |
| Records vanish after a deploy | `DATABASE_PATH` is inside the deploy folder. Move it to the home directory. **Restore from a backup before trading again** |
| "Please sign in" loops forever | `COOKIE_SECURE=true` while the site is served over plain HTTP. Either enable HTTPS or set it to `false` |
| Setup screen appears again | The app is pointing at a new, empty database. Check `DATABASE_PATH` |
