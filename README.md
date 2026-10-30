# Discord plugins

My Discord client plugins for [Equicord](https://github.com/Equicord/Equicord) (desktop and web) and [Kettu](https://github.com/C0C0B01/Kettu) (Android).

## Layout

| Path | What |
|---|---|
| `equicord-plugins/<Name>/` | Equicord user plugins. Only plugin folders go here: Equicord treats every top-level entry as a plugin. |
| `kettu-plugins/` | Kettu plugins and their esbuild build. See [kettu-plugins/README.md](kettu-plugins/README.md). |
| `shared/<Name>/` | Platform-free code used by both versions of a plugin (no `@api`, `@webpack` or Vendetta imports). |
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
- **Kettu:** `cd kettu-plugins && npm install && npm run build`. Pushing to `main` deploys `kettu-plugins/dist` to GitHub Pages when `kettu-plugins/` or `shared/` changes.

## Adding a plugin

- **Equicord:** create `equicord-plugins/<Name>/index.ts(x)`.
- **Kettu:** create `kettu-plugins/plugins/<Name>/index.tsx` and `manifest.json`.
- **Both:** put the logic that does not touch the client in `shared/<Name>/` and import it relatively from each version.
