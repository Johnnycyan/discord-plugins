# Discord plugins

My Discord client plugins for [Equicord](https://github.com/Equicord/Equicord) (desktop and web) and the Discord mobile mods [Kettu](https://github.com/C0C0B01/Kettu) and [Valenced](https://github.com/Valenced/valenced).

## Layout

| Path | What |
|---|---|
| `equicord-plugins/<Name>/` | Equicord user plugins. Only plugin folders go here: Equicord treats every top-level entry as a plugin. |
| `kettu-plugins/` | Kettu plugins and their esbuild build. See [kettu-plugins/README.md](kettu-plugins/README.md). |
| `valenced-plugins/` | Valenced plugins, built with Valenced's plugin CLI. See [valenced-plugins/README.md](valenced-plugins/README.md). |
| `sync-server/` | Self-hosted sync server for CustomFavorites. See [sync-server/README.md](sync-server/README.md). |
| `Equicord/` | Upstream Equicord clone used to build, not committed. |
| `_old/` | Local archive, not committed. |

## Setup

Clone this repo, then clone Equicord inside it and link the plugins in. From `cmd` in the repo root:

```bat
git clone https://github.com/Equicord/Equicord
rmdir /s /q Equicord\src\userplugins
mklink /J Equicord\src\userplugins equicord-plugins
cd Equicord && pnpm install
```

`tsconfig.json` in the repo root extends Equicord's, so the `@api`, `@utils`, ... aliases resolve for both the Equicord build (esbuild follows the junction to the real path) and the editor.

## Building

- **Equicord:** `cd Equicord && pnpm build` (or `pnpm watch`). Update upstream with `git pull` in `Equicord/`; the plugins are untouched.
- **Kettu:** `cd kettu-plugins && npm install && npm run build`.
- **Valenced:** `cd valenced-plugins && bun install && bun run build && node package.mjs`.

Pushing to `main` deploys `kettu-plugins/dist` to GitHub Pages, with the Valenced repository under `valenced/`, when `kettu-plugins/`, `valenced-plugins/` or `equicord-plugins/` changes.

## Adding a plugin

- **Equicord:** create `equicord-plugins/<Name>/index.ts(x)`.
- **Kettu:** create `kettu-plugins/plugins/<Name>/index.tsx` and `manifest.json`.
- **Valenced:** create `valenced-plugins/plugins/<Name>/index.tsx`, `manifest.json` and `tsconfig.json`.
- **Shared code:** put the logic that does not touch the client in its own files in `equicord-plugins/<Name>/` (no `@api`, `@webpack`, Vendetta or `@valenced` imports) and import it from the Kettu and Valenced versions with a relative path. It must live inside the plugin folder: the Equicord launcher copies only that folder when it builds.
