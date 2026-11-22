# Deployment on Nahida

**Status:** Implemented
**Last Updated:** 2026-11-22
**Audience:** Contributors releasing the service
**Last verified:** 2026-11-22 against b76dc30
**Code:** `Dockerfile`, `deploy/compose.yaml`, `deploy/.env.example`, `scripts/deploy-nahida.ps1`, `scripts/configure-npm.ps1`, `scripts/resolve-nahida.ps1`, `scripts/test-nahida-discovery.ps1`, `apps/server/src/config.ts`

The live site is **https://choicervoicer.throndir.com**.

The service is one Docker container. It uses the same release flow as Fold Down Stories: build on the workstation, copy the image over SSH, and start it with Docker Compose. No container registry and no GitHub Actions minutes are used.

## Topology

| Item | Value |
| --- | --- |
| Public address | `https://choicervoicer.throndir.com` |
| DNS | Cloudflare and Nginx Proxy Manager are the intended public route. |
| Host | Nahida, discovered LAN address, SSH port `9222`, user `throndir` |
| Remote folder | `/Volume2/apps/multiplayer-choicer-voicer` |
| Upstream | Nahida's discovered LAN address on port `3090` (do not forward this port in the router) |
| Reverse proxy | Nginx Proxy Manager on Nahida; the setup script selects an existing matching certificate. |
| Data | Docker volume `multiplayer-choicer-voicer_mcv-data` mounted at `/data` |
| Limits | 4 CPUs, 3 GB of memory |

These are repository release defaults, not a fresh audit of external DNS, router, or certificate state.
Compose alone defaults to `127.0.0.1:3090`; the deploy script writes the Nahida bind address.

The data volume contains:

- `catalog.json`: the GameBanana pack list.
- `rooms.json`: the open rooms.
- `packs-index.json`: ready processing jobs and the last use of each pack.
- `media/packs/<packId>/`: the processed packs (cache, limited by `PACK_CACHE_MAX_GB`).
- `media/rooms/<roomId>/`: the recordings and the exported videos and take ZIPs of each room.

## First release

1. Make sure that Docker Desktop runs on the workstation and that the pinned SSH host key is trusted.
2. Run the script from the repository root:

   ```powershell
   pwsh -File scripts/deploy-nahida.ps1
   ```

   The script runs the type check and the tests, builds the image, copies it to Nahida, writes the `.env` file, starts Compose and checks `/healthz`.

3. Create the Nginx Proxy Manager host:

   ```powershell
   pwsh -File scripts/configure-npm.ps1
   ```

   The script asks for the Nginx Proxy Manager login. You can also set `NPM_IDENTITY` and `NPM_SECRET` in the PowerShell session first. The script does not save or print the login. It:
   - uses a certificate that already covers the domain (the `*.throndir.com` wildcard), or requests a Let's Encrypt certificate;
   - forwards `choicervoicer.throndir.com` to the discovered Nahida address on port `3090`;
   - turns on WebSocket upgrades (the rooms use Socket.IO), HTTP/2, forced HTTPS and HSTS;
   - sets `client_max_body_size 64m` and 300-second proxy timeouts.

   For a different domain, use `-Domain <name>`. The microphone works only on HTTPS.

4. Open the domain. The first start reads the GameBanana list in the background. Duration depends on the catalog and network.

## Cloudflare

- The server sends immutable cache headers for media except manifests, including `.m4a` recordings.
- Manifests use `no-cache`. API routes do not set immutable media headers.
- These headers do not prove that Cloudflare caches a response. Its cache rules are external configuration.
- Uploads use 8 MiB parts. The setup script enables WebSocket upgrades in Nginx Proxy Manager.

## Later releases

Agents release `main` after every merge that changes the image.
The steps are in [repository workflow](workflow.md), under "Deploy every finished change".

```powershell
pwsh -File scripts/deploy-nahida.ps1
```

The script keeps the three newest images. To go back to an earlier image:

```powershell
pwsh -File scripts/deploy-nahida.ps1 -Rollback <tag>
```

To read the logs:

```powershell
pwsh -File scripts/deploy-nahida.ps1 -Logs -Tail 400
```

## Settings

Put these values in `/Volume2/apps/multiplayer-choicer-voicer/.env` on Nahida. The deploy script keeps them.

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
It replaces MCV_IMAGE, MCV_BIND_ADDRESS, and MCV_PORT from its parameters.
Other environment keys are not preserved or passed through by this Compose file.

## Deploy script options

Both scripts use `scripts/resolve-nahida.ps1` to find Nahida before making changes.
The helper checks Windows DNS A records for `nahida` on `192.168.50.0/24`.
It then tries `192.168.50.114` and `192.168.50.9`, without duplicate checks or a subnet scan.
Each candidate must pass a read-only SSH check with the existing `[192.168.50.9]:9222` host key.
The scripts stop before writes if no candidate passes.
All deploy SSH and SCP connections use that same pinned host key and batch mode.
The workstation must already trust that key and have key-based SSH access.

| Option | Default | Purpose |
| --- | --- | --- |
| `-NahidaHost`, `-SshPort`, `-SshUser` | discovered address, `9222`, `throndir` | SSH target. An explicit host still requires the pinned key. |
| `-RemoteRoot` | `/Volume2/apps/multiplayer-choicer-voicer` | Remote release folder. |
| `-RemoteDockerBin` | `/Volume2/@apps/DockerEngine/dockerd/bin` | Remote Docker executable folder. |
| `-BindAddress`, `-Port` | verified address, `3090` | Compose host binding. |
| `-Tag` | version-date-time-short-SHA | Image tag; changed tracked files add a dirty suffix. |
| `-Rollback` | unset | Starts an existing image instead of building one. |
| `-KeepImages` | `3` | Retains newest images after release; 0 disables pruning. |
| `-SkipVerify` | off | Skips script typecheck and tests, not the image build or health check. |
| `-Logs`, `-Tail` | off, `200` | Reads logs without a release. |

`configure-npm.ps1` also accepts `ProxyManagerUrl`, `Domain`, `ForwardHost`, `ForwardPort`,
`NoCertificate`, `LetsEncryptEmail`, `NahidaHost`, `SshPort`, and `SshUser`.
Its default proxy URL and upstream use the verified address.
Explicit proxy URLs and upstreams are kept.
An explicit non-Nahida proxy URL and upstream do not require discovery.
Known Nahida proxy URLs still require the pinned SSH check.
`NoCertificate` avoids requesting a new certificate when none matches; it can still use an existing certificate.

Run `pwsh -NoProfile -File scripts/test-nahida-discovery.ps1` for the local mocked discovery checks.
The checks do not contact Nahida or change the proxy.

## Resources

Compose limits the container to 4 CPUs and 3 GB of memory.
Pack video conversions run one at a time. Dub exports use a separate serialized queue.
The code does not enforce a single shared queue for all ffmpeg operations.
