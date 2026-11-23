# Deployment on Rukkhadevata

**Status:** Implemented
**Last Updated:** 2026-11-22
**Audience:** Contributors releasing the service
**Last verified:** 2026-11-22 against e792933
**Code:** `Dockerfile`, `deploy/compose.yaml`, `deploy/.env.example`, `scripts/deploy-rukkhadevata.ps1`, `scripts/deploy-nahida.ps1`, `scripts/configure-npm.ps1`, `scripts/resolve-nahida.ps1`, `scripts/test-nahida-discovery.ps1`, `apps/server/src/config.ts`

The live site is **https://choicervoicer.throndir.com**.

The service is one Docker container on the NAS Rukkhadevata. It moved from Nahida on 2026-11-22.
The release flow builds the image on the workstation, copies it over SSH, and starts it with Docker Compose.
No container registry and no GitHub Actions minutes are used.

## Topology

| Item | Value |
| --- | --- |
| Public address | `https://choicervoicer.throndir.com` |
| DNS | Cloudflare and Nginx Proxy Manager (on Nahida, proxy host 10) are the public route. |
| Host | Rukkhadevata, `192.168.50.84`, SSH port `9222`, user `throndir` (`ssh rukkhadevata`) |
| Remote folder | `/Volume1/apps/multiplayer-choicer-voicer` (listed in `/Volume1/apps/_ops/stacks.list`) |
| Docker | `/Volume1/@apps/DockerEngine/dockerd/bin` (not on the non-interactive SSH `PATH`) |
| Upstream | `http://192.168.50.84:3090` (do not forward this port in the router) |
| Reverse proxy | Nginx Proxy Manager on Nahida; the setup script selects an existing matching certificate. |
| Data | Docker volume `multiplayer-choicer-voicer_mcv-data` mounted at `/data` |
| Limits | 8 CPUs (`MCV_CPUS`), 3 GB of memory |
| Rollback copy | The stopped Nahida project in `/Volume2/apps/multiplayer-choicer-voicer` and its volume, data as of 2026-11-22. |

These are repository release defaults, not a fresh audit of external DNS, router, or certificate state.
Compose alone defaults to `127.0.0.1:3090` and 4 CPUs; the deploy script writes the bind address and `MCV_CPUS`.

The data volume contains:

- `catalog.json`: the GameBanana pack list.
- `rooms.json`: the open rooms.
- `packs-index.json`: ready processing jobs and the last use of each pack.
- `media/packs/<packId>/`: the processed packs (cache, limited by `PACK_CACHE_MAX_GB`).
- `media/rooms/<roomId>/`: the recordings and the exported videos and take ZIPs of each room.

## Release

1. Make sure that Docker Desktop runs on the workstation and that `ssh rukkhadevata` works without a prompt.
2. Run the script from the repository root:

   ```powershell
   pwsh -File scripts/deploy-rukkhadevata.ps1
   ```

   The script runs the type check and the tests, builds the image, copies it to Rukkhadevata, writes the `.env` file, starts Compose and checks `/healthz`.

3. The Nginx Proxy Manager host already exists. `scripts/configure-npm.ps1` creates it for a new domain. Give it `-ForwardHost 192.168.50.84`, because its default upstream is still Nahida.

   The script asks for the Nginx Proxy Manager login. You can also set `NPM_IDENTITY` and `NPM_SECRET` in the PowerShell session first. The script does not save or print the login. It:
   - uses a certificate that already covers the domain (the `*.throndir.com` wildcard), or requests a Let's Encrypt certificate;
   - forwards the domain to the upstream on port `3090`;
   - turns on WebSocket upgrades (the rooms use Socket.IO), HTTP/2, forced HTTPS and HSTS;
   - sets `client_max_body_size 64m` and 300-second proxy timeouts.

   For a different domain, use `-Domain <name>`. The microphone works only on HTTPS.

## Cloudflare

- The server sends immutable cache headers for media except manifests, including `.m4a` recordings.
- Manifests use `no-cache`. API routes do not set immutable media headers.
- These headers do not prove that Cloudflare caches a response. Its cache rules are external configuration.
- Uploads use 8 MiB parts. The setup script enables WebSocket upgrades in Nginx Proxy Manager.

## Later releases

Agents release `main` after every merge that changes the image.
The steps are in [repository workflow](workflow.md), under "Deploy every finished change".

```powershell
pwsh -File scripts/deploy-rukkhadevata.ps1
```

The script keeps the three newest images. To go back to an earlier image:

```powershell
pwsh -File scripts/deploy-rukkhadevata.ps1 -Rollback <tag>
```

To read the logs:

```powershell
pwsh -File scripts/deploy-rukkhadevata.ps1 -Logs -Tail 400
```

## Settings

Put these values in `/Volume1/apps/multiplayer-choicer-voicer/.env` on Rukkhadevata. The deploy script keeps them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PACK_CACHE_MAX_GB` | `20` | Maximum size of the processed pack cache. The least recently used packs are removed first. |
| `DOWNLOAD_MAX_MB` | `2048` | Largest pack archive that the server downloads. |
| `UPLOAD_MAX_MB` | `2048` | Largest upload. |
| `VIDEO_MAX_HEIGHT` | `720` | Height of the converted video. Use `480` for very slow connections. |
| `VIDEO_PRESET` | `veryfast` | x264 speed. `ultrafast` uses less CPU but makes larger files. |
| `VIDEO_CRF` | `27` | x264 quality. A higher number makes smaller files. |
| `FFMPEG_THREADS` | `0` | Threads for ffmpeg. `0` lets ffmpeg decide. |
| `ROOM_IDLE_HOURS` | `6` | A room with nobody connected is deleted after this time. |
| `CATALOG_REFRESH_HOURS` | `6` | Time between full GameBanana list refreshes. New packs are also checked every 20 minutes. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

After you change the file, run the deploy script again, or run `docker compose --env-file .env -f compose.yaml up -d` in the remote folder.

The script preserves only the tuning keys in this table.
It replaces MCV_IMAGE, MCV_BIND_ADDRESS, MCV_PORT, and MCV_CPUS from its parameters.
Other environment keys are not preserved or passed through by this Compose file.

## Deploy script options

`scripts/deploy-rukkhadevata.ps1` connects to a fixed address with SSH batch mode and strict host key checking.
The workstation must already trust the Rukkhadevata host key and have key-based SSH access.

| Option | Default | Purpose |
| --- | --- | --- |
| `-TargetHost`, `-SshPort`, `-SshUser` | `192.168.50.84`, `9222`, `throndir` | SSH target. |
| `-RemoteRoot` | `/Volume1/apps/multiplayer-choicer-voicer` | Remote release folder. |
| `-RemoteDockerBin` | `/Volume1/@apps/DockerEngine/dockerd/bin` | Remote Docker executable folder. |
| `-BindAddress`, `-Port` | target address, `3090` | Compose host binding. |
| `-Cpus` | `8.0` | CPU limit written as `MCV_CPUS`. |
| `-Tag` | version-date-time-short-SHA | Image tag; changed tracked files add a dirty suffix. |
| `-Rollback` | unset | Starts an existing image instead of building one. |
| `-KeepImages` | `3` | Retains newest images after release; 0 disables pruning. |
| `-SkipVerify` | off | Skips script typecheck and tests, not the image build or health check. |
| `-Logs`, `-Tail` | off, `200` | Reads logs without a release. |

### Old Nahida script

`scripts/deploy-nahida.ps1` is kept only to restart the old Nahida copy in an emergency.
It has the same options, but `-NahidaHost` replaces `-TargetHost` and it has no `-Cpus` (Compose uses 4).
It uses `scripts/resolve-nahida.ps1` to find Nahida: Windows DNS A records for `nahida` on `192.168.50.0/24`, then `192.168.50.114` and `192.168.50.9`.
Each candidate must pass a read-only SSH check with the pinned `[192.168.50.9]:9222` host key.

`configure-npm.ps1` also accepts `ProxyManagerUrl`, `Domain`, `ForwardHost`, `ForwardPort`,
`NoCertificate`, `LetsEncryptEmail`, `NahidaHost`, `SshPort`, and `SshUser`.
Its default proxy URL and upstream use the verified Nahida address; pass `-ForwardHost 192.168.50.84` for this service.
Explicit proxy URLs and upstreams are kept.
An explicit non-Nahida proxy URL and upstream do not require discovery.
Known Nahida proxy URLs still require the pinned SSH check.
`NoCertificate` avoids requesting a new certificate when none matches; it can still use an existing certificate.

Run `pwsh -NoProfile -File scripts/test-nahida-discovery.ps1` for the local mocked discovery checks.
The checks do not contact Nahida or change the proxy.

## Resources

Compose limits the container to `MCV_CPUS` CPUs (8 on Rukkhadevata) and 3 GB of memory.
Pack video conversions run one at a time. Dub exports use a separate serialized queue.
The code does not enforce a single shared queue for all ffmpeg operations.
