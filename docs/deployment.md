# Deployment on Nahida

The service is one Docker container. It uses the same release flow as Fold Down Stories: build on the workstation, copy the image over SSH, and start it with Docker Compose. No container registry and no GitHub Actions minutes are used.

## Topology

| Item | Value |
| --- | --- |
| Host | Nahida, `192.168.50.9`, SSH port `9222`, user `throndir` |
| Remote folder | `/Volume2/apps/multiplayer-choicer-voicer` |
| Upstream | `http://192.168.50.9:3090` |
| Reverse proxy | Nginx Proxy Manager (TLS) |
| Data | Docker volume `multiplayer-choicer-voicer_mcv-data` mounted at `/data` |

The data volume contains:

- `catalog.json`: the GameBanana pack list.
- `rooms.json`: the open rooms.
- `packs-index.json`: the processing jobs and the last use of each pack.
- `media/packs/<packId>/`: the processed packs (cache, limited by `PACK_CACHE_MAX_GB`).
- `media/rooms/<roomId>/`: the recordings and the exported videos of each room.

## First release

1. Make sure that Docker Desktop runs on the workstation, and that `ssh -p 9222 throndir@192.168.50.9` works with a key.
2. Run the script from the repository root:

   ```powershell
   pwsh -File scripts/deploy-nahida.ps1
   ```

   The script runs the type check and the tests, builds the image, copies it to Nahida, writes the `.env` file, starts Compose and checks `/healthz`.

3. In Nginx Proxy Manager, add a proxy host:
   - **Domain name**: your domain, for example `voicer.example.com`.
   - **Forward hostname / IP**: `192.168.50.9`, **port** `3090`, scheme `http`.
   - Turn on **Websockets Support** (the rooms use Socket.IO).
   - On the SSL tab, request a certificate and turn on **Force SSL**. The microphone works only on HTTPS.
   - Optional, on the Advanced tab: `client_max_body_size 32m;` if your proxy has a body limit below 32 MB. Uploads use 8 MB parts and recordings are smaller than 30 MB.

4. Open the domain. The first start reads the GameBanana list in the background. This takes about two minutes.

## Later releases

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

The container is limited to 2 CPUs and 1.5 GB of memory. Video conversion is the heaviest work. The server converts one video at a time, while the players record.
