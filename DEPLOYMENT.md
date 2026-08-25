# Running it in the shop

This application is local-first, and the shop's own computer is the server.
There is no hosting company in this picture, no deploy step, and nothing that
rewrites your folder while you are trading.

That is not a compromise. It is what the code already assumes: the session
cookie is not marked `Secure` by default because the shop runs over plain HTTP
on its own network, SQLite is set to `synchronous = FULL` so a committed sale
survives the power going out mid-request, and the whole of the shop's records
live in one file you can copy.

> **Hostinger and other managed Node hosts are not supported.** `better-sqlite3`
> is a native module and needs to be compiled or matched to a prebuilt binary on
> the machine that runs it, which those plans do not reliably allow. A VPS works
> — you control the runtime there — but everything below is the simpler answer.

---

## What you need

- A Windows PC that stays switched on while the shop trades. It does not need to
  be fast; it needs to be reliable and backed up.
- **Node 22 or newer.** The application refuses to start on anything older.
- Somewhere off this machine to keep backups. A phone, a USB stick, an email to
  yourself — anywhere that does not share a fate with the computer.

---

## First install

Run these in the project folder, in this order.

```bash
npm ci                 # exactly the dependency versions this app was tested with
npm run env:init       # writes .env with a fresh random SESSION_SECRET
```

`env:init` never overwrites an existing `.env`, so it is safe to run twice.

Now open `.env` and set three values for a real shop:

```
NODE_ENV=production
SEED_DEMO_DATA=false
COOKIE_SECURE=false
```

`SEED_DEMO_DATA=false` matters more than it looks: **there is no way to remove
demo records once they are in.** They are tagged, and `npm run preflight` will
refuse to pass while any exist, but nothing deletes them — the only route back
is `npm run db:reset -- --force`, which deletes the whole database file and
refuses to run at all once `NODE_ENV=production`. A shop machine should simply
never seed them.

Then build it and start it:

```bash
npm run db:migrate     # also runs at startup; this just gets errors out early
npm run build
npm start -- -p 5177
```

Open <http://localhost:5177>. The first visit shows the setup screen, where you
create the shop and its owner account. That screen closes for good once an owner
exists.

---

## Reaching it from the counter, the office, a phone

`next start` already listens on every network interface, so nothing needs
changing in the app. Other devices reach it at the PC's own address:

```
http://<this-pc-on-the-network>:5177
```

Two things to sort out once:

**Let it through the Windows firewall.** In an Administrator terminal:

```
netsh advfirewall firewall add rule name="NunaBooks" dir=in action=allow protocol=TCP localport=5177
```

**Pin the address.** Most routers hand out addresses that can change after a
reboot, which would quietly break every bookmark in the shop. Reserve a fixed
address for this PC in the router's settings, or set a static one on the machine.

### Do not put this on the internet

No port forwarding, no exposing 5177 through the router. Over plain HTTP,
anybody between the browser and the PC can read the session cookie and every
figure that passes. On the shop's own network that is an acceptable, deliberate
trade; across the internet it is not.

If you ever do need access from outside, that is a different setup: a VPN back
into the shop, or a reverse proxy terminating HTTPS in front of the app with
`COOKIE_SECURE=true` and `TRUST_PROXY_HEADERS=true`. Both of those settings are
documented in `env.example` and neither should be changed speculatively.

---

## Keeping it running

Starting it by hand works, but the shop should not depend on somebody
remembering. Use **Task Scheduler**:

- Trigger: *At log on*
- Action: start a program — `npm`, arguments `start -- -p 5177`, "Start in" set
  to the project folder
- Tick *Run whether user is logged on or not* if the PC is left at a lock screen

Restarting is harmless. Migrations are versioned and skip what is already
applied, the chart of accounts is checked rather than rewritten, and a sale that
was committed is on disk. Nothing resets your shop.

If the database cannot be prepared, the server **refuses to start** rather than
serving pages against a half-built schema. Read the terminal output; the reason
is printed with the path it tried.

---

## Backups

**Settings → Health & backup → Download a backup**, and keep the file somewhere
other than this computer.

The backup is verified before you get it: it must open, its foreign keys must be
intact, and the books inside it must balance. A copy that fails any of those is
discarded rather than handed to you looking like a safety net.

The app now tells you when you are behind. The Health screen shows when the last
backup was taken and how many entries have been posted since, and the dashboard
raises it once there is a day of unsaved trading, or after a week regardless.
`npm run backup` from the command line counts too — it records itself, so taking
one that way clears the warning.

Nothing takes a backup for you. Do it at the end of each trading day.

---

## Before you trade on it

```bash
npm run preflight
```

It answers, one by one: is the session secret real, is demo seeding off, are
migrations applied, is the database uncorrupted, **do the books balance**, does
the stock match its own movement history, is there an active owner, and are
there demo records or published demo credentials still present.

Anything that would misstate money or let the wrong person in is a failure, not
a warning. Do not start trading with failures on that list.

---

## Updating

```bash
git pull
npm ci
npm run build
```

Then restart it. Migrations apply themselves at startup.

Your data is never touched by an update: `data/` is git-ignored, so it is not
part of what `git pull` replaces, and it does not live inside anything that gets
rebuilt.

---

## If something goes wrong

| Symptom | Cause |
| --- | --- |
| `npm ci` fails on `better-sqlite3` | Node is older than 22, or no prebuilt binary matched your machine. Check `node -v` first |
| The build fails on `@tailwindcss/postcss` or `typescript` | `NODE_ENV=production` was set in your terminal, so npm skipped `devDependencies`. Install and build first, and let `.env` carry the production setting |
| Other devices cannot reach it | The firewall rule is missing, or the PC's address changed. Confirm the address on the PC itself first |
| "Please sign in" loops for ever | `COOKIE_SECURE=true` while served over plain HTTP. Set it back to false |
| The setup screen appears again | The app is pointing at a new, empty database. Check `DATABASE_PATH` in `.env` |
| Preflight says demo records are present | Nothing removes them. Start from a clean database before the shop trades |
