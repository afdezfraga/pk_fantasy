# Putting the league on the internet

This runs the app on a free Oracle Cloud VM with real HTTPS, for about the cost of an hour one
Saturday. Nothing in it is specific to Oracle except the firewall step — any VM with a persistent
disk will do.

## Why a VM, and not something serverless

The whole league is one SQLite file, and SQLite takes one writer. The guarantee that two people
can't buy the same Pokémon at the same instant is a guarded `UPDATE` in
[`lib/services/ownership.ts`](lib/services/ownership.ts) — it holds because there is exactly one
process with exactly one database file. Put this on Cloud Run, Lambda or App Engine and you get
two things you don't want: a filesystem that's wiped on every deploy, and a second instance racing
the first.

So: **one small VM, one disk.** Oracle's Always Free Ampere A1 tier gives 4 ARM cores, 24 GB RAM
and 200 GB of storage, free indefinitely rather than for twelve months. That's absurdly generous
for ten people, and roomy enough to build the image on the box — which means the Prisma engine is
always compiled for the right architecture and you never think about it again.

---

## 1. The VM

Oracle Cloud → **Compute → Instances → Create instance**.

| Setting | Value |
|---|---|
| Image | Ubuntu 24.04 |
| Shape | `VM.Standard.A1.Flex` — **4 OCPU, 24 GB RAM** |
| SSH | upload your public key |

> **If it says "Out of host capacity"** — very common for the free ARM shape — try a different
> availability domain, or another region, or simply retry over a day or two. Failing that, the
> always-free AMD shape (`VM.Standard.E2.1.Micro`, 1 core / 1 GB) also works, but 1 GB of RAM
> cannot run `next build`; add 4 GB of swap first, or build the image elsewhere and push it to a
> registry.

### Reserve the public IP

By default Oracle gives the instance an **ephemeral** IP that changes if you ever stop and start
it — which silently breaks your DNS one morning. Always Free includes reserved IPs:

Instance → **Attached VNICs → the VNIC → IPv4 Addresses → Edit → Reserved public IP**.

---

## 2. Open ports 80 and 443 — in *both* places

This trips up nearly everyone deploying to Oracle. There are two firewalls and you need both.

**The cloud one.** VCN → Security Lists → the subnet's default list → **Add Ingress Rules**:

| Source | Protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | 80 |
| `0.0.0.0/0` | TCP | 443 |

**The one on the machine.** Oracle's Ubuntu images ship iptables rules that drop everything except
SSH. If you skip this, the site simply hangs and everything looks correct from the console:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

> **If the site ever hangs rather than erroring, come back and check this first.**

---

## 3. Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu
```

Log out and back in so the group takes effect, then confirm `docker ps` works without `sudo`.

---

## 4. A name and a certificate

Go to [duckdns.org](https://www.duckdns.org), sign in, and create a subdomain — say
`your-league.duckdns.org`. Point it at the **reserved IP** from step 1.

Check it resolves before going further, because Let's Encrypt will refuse the certificate
otherwise and rate-limit you if you keep trying:

```bash
dig +short your-league.duckdns.org
```

Caddy handles the certificate itself — requesting it, installing it, and renewing it. There is
nothing to schedule and nothing to remember.

---

## 5. Deploy

```bash
git clone <your repo url> pk_fantasy
cd pk_fantasy

cp .env.deploy.example .env
nano .env            # set DUCKDNS_DOMAIN and ACME_EMAIL

docker compose up -d --build
```

The first build takes roughly 3–5 minutes on 4 ARM cores. Watch it come up:

```bash
docker compose logs -f app
```

On a fresh volume you should see, in order:

```
==> database: file:/data/league.db
==> applying schema
==> journal mode: wal
==> empty catalog — seeding from data/roster.json
Seeding 247 Pokémon from roster generated ...
==> starting: node_modules/.bin/next start -H 0.0.0.0 -p 3000
```

Then open `https://your-league.duckdns.org`, create your account, start a league, and share the
six-character invite code. Signup is open, so anyone with the link can register — but they can't
join your league without that code.

---

## Trying it on your own machine first

The whole stack runs locally, certificate and all — worth doing once before you touch the cloud.

Caddy treats `localhost` specially: instead of asking Let's Encrypt for a certificate it cannot
get, it issues one from its own internal CA. So you get **real HTTPS**, which is the point — over
plain HTTP the `secure` session cookie is dropped and login looks broken for reasons that have
nothing to do with your deployment.

```bash
DUCKDNS_DOMAIN=localhost ACME_EMAIL=you@example.com \
HTTP_PORT=8080 HTTPS_PORT=8443 \
  docker compose up -d --build
```

Then open **https://localhost:8443** and click through the browser's warning — the certificate is
genuine, it just comes from a CA only this machine trusts.

Three things to know:

- **The ports.** `HTTP_PORT`/`HTTPS_PORT` exist because a desktop is often already running
  something on 80. Leave them unset on the server, where Let's Encrypt needs port 80 to answer
  its challenge.
- **Go to the HTTPS URL directly.** Caddy's automatic HTTP→HTTPS redirect points at the standard
  port, so `http://localhost:8080` bounces to `https://localhost/…` and stalls. That's a
  local-ports artefact; on the real domain the redirect is right.
- **`--build` after any data change.** `data/` is baked into the image, so a repricing only
  reaches the container when you rebuild. Without it you will seed yesterday's roster.

### Reaching it from a phone on the same wifi

Testing on a real phone needs a different arrangement, because Caddy serves exactly one
hostname. Ask it for `192.168.x.x` and the TLS handshake fails before HTTP starts — it has no
certificate for that address, only for the name you configured.

Rather than teach Caddy a second name and have every device click through a warning from a CA it
does not trust, skip the proxy:

```bash
docker compose -f docker-compose.yml -f deploy/compose.lan.yml up -d --build
```

Then open **http://<this machine's LAN IP>:3000** on the phone — `hostname -I` or
`ip -4 addr show scope global` will tell you the address.

That override publishes the app directly and sets `ALLOW_INSECURE_COOKIE=1`, which is required:
without it the `secure` session cookie is dropped over plain HTTP and logins do nothing at all.
**It must never be used on anything reachable from the internet** — it is the one setting that
turns a working login into a session anyone on the network can copy.

Tear it down with `docker compose down`. Add `-v` only if you also want to throw away the test
league — on the server that flag destroys the real one.

## Living with it

### Updating

```bash
cd ~/pk_fantasy
git pull
docker compose up -d --build
```

The schema is reapplied on every start. Seeding is not — `deploy/bootstrap.mjs` only seeds when
the catalog is empty, because `scripts/seed.ts` also backfills free-agent rows into existing
leagues, which is right after a roster rotation and wrong on a restart.

### After a roster rotation

```bash
docker compose exec app npm run db:seed
```

### Backups

The league is one file. `deploy/backup.sh` takes a consistent snapshot of it while the app is
running — plain `cp` can catch SQLite mid-write and give you a database that opens fine and is
quietly wrong.

```bash
./deploy/backup.sh                    # writes ~/pkf-backups/league-YYYY-MM-DD.db
crontab -e
0 4 * * * cd ~/pk_fantasy && ./deploy/backup.sh >> ~/pkf-backups/backup.log 2>&1
```

**A backup on the same disk is not a backup.** Pull one down to your laptop now and then:

```bash
scp ubuntu@your-league.duckdns.org:pkf-backups/league-2026-09-22.db .
```

### Restoring

The stale write-ahead log has to go with the old database — leaving `-wal` and `-shm` behind is
the step people forget, and SQLite will happily replay them over your restored data.

```bash
docker compose stop app
docker run --rm -v pkfantasy_league:/data -v "$HOME/pkf-backups:/backup" busybox \
  sh -c 'rm -f /data/league.db-wal /data/league.db-shm \
         && cp /backup/league-2026-09-22.db /data/league.db'
docker compose start app
```

### Looking at the data

```bash
docker compose exec app sqlite3 /data/league.db "select username, displayName from User;"
docker compose logs -f app
curl https://your-league.duckdns.org/api/health     # {"ok":true}
```

---

## Things that will bite

**Never run `npm run db:reset`.** `scripts/demo.ts --reset` calls `deleteMany({})` on users and
leagues. It exists for local development and it will erase your league without asking.

**Never run `docker compose down -v`.** The `-v` removes the volumes — both the league and Caddy's
certificates. Let's Encrypt allows five certificates per domain per week, so re-issuing is not
free. `docker compose down` on its own is safe.

**Never scale the app.** `docker compose up --scale app=2` gives you two processes writing one
SQLite file. The rule that two people can't buy the same Pokémon at once is a guarded `UPDATE`
that assumes a single writer; a second instance doesn't just slow things down, it corrupts the
league.

**Don't test over the VM's raw IP.** Session cookies are marked `secure` whenever `NODE_ENV` is
production, so over plain HTTP the browser accepts your login and then silently drops the cookie —
it looks like the password is wrong. Always test through `https://your-league.duckdns.org`.

**Build cache grows.** Repeated `--build` cycles accumulate layers fast at this image size. A
`docker builder prune` every month or two keeps the boot volume comfortable.

**Forms suddenly returning 403.** Next 15 checks the request origin against the host on every
server action. Caddy passes the original `Host` through, so this should not happen — but if it
does after some future change to the proxy, add to `next.config.mjs`:

```js
experimental: {
  serverActions: { allowedOrigins: ['your-league.duckdns.org'] },
},
```

**Schema changes.** There are no migrations here — the entrypoint runs `prisma db push`, and
deliberately without `--accept-data-loss`. If a change would drop a column, the container stops and
refuses to start rather than deleting a season's history. That's the intended behaviour: back up,
then decide. If you start changing the schema often, move to `prisma migrate`.

**Idle reclamation.** Oracle may reclaim Always Free compute that sits idle. A league in use won't
qualify, but if you'd rather not think about it, upgrading the account to Pay As You Go exempts it
while leaving Always Free resources free.

**Sprites** are hotlinked from `raw.githubusercontent.com` as pages render. If that's ever slow or
blocked, `npm run roster:build -- --sprites` caches them into `public/sprites/` and the next image
build picks them up.
