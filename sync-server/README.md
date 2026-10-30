# CustomFavorites sync server

Keeps CustomFavorites in sync between your Equicord and Kettu installs. One small Node.js file with no dependencies, meant to be self-hosted: one server per person, so there are no accounts. Every device uses the same server URL and token.

## Run it

Needs Node.js 18 or newer.

```sh
export SYNC_TOKEN="$(openssl rand -hex 32)"   # keep this; you'll paste it into each plugin
node server.mjs
```

| Variable | Default | |
|---|---|---|
| `SYNC_TOKEN` | (required) | Shared secret, at least 16 characters. Clients send it as `Authorization: Bearer <token>`. |
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | Only listens locally; expose it through a reverse proxy with HTTPS. |
| `DATA_FILE` | `./favorites.json` | Where the favorites are stored. Back this file up if you care about it. |

### HTTPS

Use HTTPS. Discord on Android refuses plain HTTP, Discord web refuses it from an HTTPS page, and the token would travel in the clear. With [Caddy](https://caddyserver.com), which gets certificates automatically:

```
favorites.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

### systemd

`/etc/systemd/system/customfavorites-sync.service`:

```ini
[Unit]
Description=CustomFavorites sync server
After=network.target

[Service]
WorkingDirectory=/opt/customfavorites-sync
ExecStart=/usr/bin/node server.mjs
Environment=SYNC_TOKEN=paste-your-token-here
Environment=DATA_FILE=/opt/customfavorites-sync/favorites.json
Restart=on-failure
User=customfavorites

[Install]
WantedBy=multi-user.target
```

Then `systemctl enable --now customfavorites-sync`.

## Connect the plugins

In each plugin's settings, enter the server URL (for example `https://favorites.example.com`) and the token.

- **Kettu:** Settings → Plugins → CustomFavorites → Sync, then **Save and sync now**.
- **Equicord:** CustomFavorites settings → Sync server URL and token. On Discord desktop, Equicord asks once to allow connecting to that domain; accept and restart Discord.

The first time a device connects:
- if the server is empty, the device uploads its favorites;
- if the device has none, it takes the server's;
- if both have favorites, it asks which to keep.

After that, every change is uploaded about a second later and shows up on your other devices within a couple of seconds. Changes made on two devices at the same time are merged per favorite; if the same favorite was changed on both, the device that uploads its change last keeps its version.

## API

- `GET /v1/health` → `{ "ok": true }` (no token needed)
- `GET /v1/favorites` → `{ revision, updatedAt, data }`. With `?since=<revision>&wait=1`, waits up to 25 s for a newer revision and answers `204` if there is none.
- `PUT /v1/favorites` with `{ baseRevision, data }` → `{ revision, updatedAt }`, or `409` with the current document if `baseRevision` is out of date.
