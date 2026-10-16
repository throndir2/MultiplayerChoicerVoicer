# Deployment on Nahida

The live site is **https://choicervoicer.throndir.com**.

The service is one Docker container. It uses the same release flow as Fold Down Stories: build on the workstation, copy the image over SSH, and start it with Docker Compose. No container registry and no GitHub Actions minutes are used.

## Topology

| Item | Value |
| --- | --- |
| Public address | `https://choicervoicer.throndir.com` |
| DNS | Cloudflare, proxied record (same as `stories.throndir.com`) |
| Host | Nahida, `192.168.50.9`, SSH port `9222`, user `throndir` |
| Remote folder | `/Volume2/apps/multiplayer-choicer-voicer` |
| Upstream | `http://192.168.50.9:3090` (LAN address; do not forward this port in the router) |
| Reverse proxy | Nginx Proxy Manager on Nahida, proxy host 10, wildcard certificate `*.throndir.com` (certificate 3) |
| Data | Docker volume `multiplayer-choicer-voicer_mcv-data` mounted at `/data` |
| Limits | 4 CPUs, 3 GB of memory |

The request path is: browser → Cloudflare → router (443 → 8443) → Nginx Proxy Manager → `192.168.50.9:3090`.

The data volume contains:

- `catalog.json`: the GameBanana pack list.
- `rooms.json`: the open rooms.
- `packs-index.json`: the processing jobs and the last use of each pack.
- `media/packs/<packId>/`: the processed packs (cache, limited by `PACK_CACHE_MAX_GB`).
- `media/rooms/<roomId>/`: the recordings and the exported videos and take ZIPs of each room.

## First release

1. Make sure that Docker Desktop runs on the workstation, and that `ssh -p 9222 throndir@192.168.50.9` works with a key.
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
   - forwards `choicervoicer.throndir.com` to `http://192.168.50.9:3090`;
   - turns on WebSocket upgrades (the rooms use Socket.IO), HTTP/2, forced HTTPS and HSTS;
   - sets `client_max_body_size 64m` and 300-second proxy timeouts.

   For a different domain, use `-Domain <name>`. The microphone works only on HTTPS.

4. Open the domain. The first start reads the GameBanana list in the background. This takes about two and a half minutes.

## Cloudflare

- Cloudflare caches the pack images, the MP3 files and the MP4 files, because their names never change. Recordings (`.m4a`) and the API are not cached.
- Uploads go in 8 MB parts, so they stay below the 100 MB request limit of the free Cloudflare plan.
- WebSockets work through Cloudflare without extra settings.

## Later releases

Agents release `main` after every merge that changes the image. The steps are in `.github/copilot-instructions.md`, in "Deploy every finished change".

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

## Resources

The container is limited to 4 CPUs and 3 GB of memory. Video conversion is the heaviest work. The server converts one video at a time, while the players record. When it is idle, the container uses about 100 MB of memory.
