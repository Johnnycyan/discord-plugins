# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Monorepo of John's Discord client plugins (GitHub: `Johnnycyan/discord-plugins`), for four clients:

- **Equicord** (desktop/web): `equicord-plugins/<Name>/`
- **Kettu** (Android, Vendetta-compatible): `kettu-plugins/plugins/<Name>/`
- **Valenced** (mobile mod that replaced Revenge Next): `valenced-plugins/plugins/<Name>/`
- **Phoenix** (Discord's Rust Android alpha, through Sunbird): `phoenix-plugins/plugins/<Name>/`
- `sync-server/`: dependency-free Node server (`server.mjs`) that syncs CustomFavorites between the clients. Its README documents the API.

`Equicord/` (an upstream clone used only for building) and `_old/` (local archive) are gitignored. Never commit to or push from `Equicord/`: its `origin` is upstream `Equicord/Equicord`.

## How the Equicord build sees the plugins

`Equicord/src/userplugins` is a Windows directory junction to `../equicord-plugins`. Consequences:

- Equicord's build scans every top-level entry in `equicord-plugins/` as a plugin, so put only plugin folders there (no loose files).
- esbuild resolves the junction to the real path, so imports are resolved from the repo root. The root `tsconfig.json` extends `Equicord/tsconfig.json` to make Equicord's path aliases (`@api`, `@utils`, `@webpack`, `@components`, `@main`, ...) work. Don't delete it.
- Desktop-only code goes in a plugin's `native.ts` (main process, e.g. `RemindMe/native.ts`), which Equicord picks up automatically.

## Code shared between clients

When a plugin exists for several clients, its platform-free logic (no `@api`, `@webpack`, `vendetta`, `@valenced` or `phoenix` use) lives as its own files **inside the Equicord plugin folder**, and the other versions import it relatively, e.g. `kettu-plugins/plugins/CustomFavorites/index.tsx` imports `../../../equicord-plugins/CustomFavorites/placement` and `.../sync`. Shared code must not live outside the plugin folder: the Equicord launcher copies only that folder into `src/userplugins` when it builds.

## Commands

Equicord (run in `Equicord/`; if pnpm complains that deps are outdated, run `pnpm install --frozen-lockfile` first):

```sh
pnpm build        # or: pnpm watch
pnpm testTsc      # typecheck; covers equicord-plugins through the junction (tsc from the repo root does not work)
pnpm lint         # eslint
pnpm inject       # install the built Equicord into Discord
```

Update upstream with `git pull` in `Equicord/`; the plugins are untouched.

Kettu (run in `kettu-plugins/`):

```sh
npm install
npm run build     # or: npm run watch
```

Valenced (run in `valenced-plugins/`):

```sh
bun install
bun run build     # plugins/<Name>/build/js/index.js
node package.mjs  # dist/pool/<id>@<version>.zip and dist/index.json
```

Phoenix (run in `phoenix-plugins/`):

```sh
npm install
npm run types     # downloads phoenix.d.ts
npm run build     # or: npm run watch
npm run typecheck
```

There is no test suite.

## Kettu specifics

- `build.mjs` bundles each `plugins/<Name>/index.tsx` with esbuild into `dist/<Name>/index.js` + `manifest.json` (from the plugin's `manifest.json`, plus a content hash). The output is wrapped as a single expression because Kettu evaluates it as `vendetta => { return <file> }`.
- The plugin API comes from the global `vendetta` object (`metro`, `patcher`, `plugin`, `ui`, `logger`, `utils`), not imports.
- Kettu runs plugins through Hermes `eval`, where `let`/`const` inside loops are function scoped. Never close over a loop variable; use array methods instead.
- Pushing to `main` deploys `kettu-plugins/dist` to GitHub Pages (`.github/workflows/deploy.yml`) when `kettu-plugins/`, `valenced-plugins/` or `equicord-plugins/` changes. Install URLs are `https://johnnycyan.github.io/discord-plugins/<Name>/`.
- Changes to `sync-server/` publish `ghcr.io/johnnycyan/customfavorites-sync` (`.github/workflows/sync-server-image.yml`).

## Valenced specifics

See `valenced-plugins/README.md`. In short: never reuse an imported name for a local (the plugin CLI rewrites every use of it), patch lazily loaded modules with `getModules`, and bump `version` in the plugin's `manifest.json` for every release. Pushing to `main` deploys the Valenced repository to GitHub Pages under `valenced/`.

## Phoenix specifics

Phoenix is Discord's Rust client in the Android alpha; `phoenix-plugins/` targets it through [Sunbird](https://github.com/sunbird-tools/sunbird).

- Plugins declare permissions in their `// @` header: `// @gateway <events...>` (only those appear on `phoenix.gateway`), `// @discord <METHOD> /path` for request hooks and API calls, `// @fetch <hosts>` (exact or `*.domain`, no catch-all), `// @stores`, `// @ui-tree`, `// @messages`. Anything undeclared is missing or throws.
- One plugin file serves Android and desktop Sunbird (Windows). Desktop has the same runtime (gateway hooks, `discord.onRequest/onResponse`, `stores.sql`, settings, `ui.choose`), but it stubs the view tree: `ui.onNode`, `mount`, `patchProps` and `onEvent` (except `rowDoubleTap`) do nothing, `ui.node`/`root` return null, and `find`/`findDown` return an empty array. Code that uses the tree must still be correct when those calls do nothing.

- `npm run types` downloads Sunbird's `phoenix.d.ts` (gitignored: Sunbird has no license), the reference for the global `phoenix` API. `npm run build` bundles `plugins/<Name>/index.ts` into `dist/<Name>.js` (IIFE, `// @` metadata lines kept as a banner); `npm run typecheck` runs tsc.
- Plugins run in QuickJS with no `setTimeout`, `atob`, `TextDecoder` or `AbortController`. Shared code that needs timers takes them from the host (see `Timers` in `CustomFavorites/sync.ts`); `shared-globals.d.ts` only types the globals such code mentions.
- `phoenix.fetch` gives up after 15 s, so the CustomFavorites sync long-polls with `waitMs` set to 10 s.
- Phoenix stores are Rust, so plugins can't patch them; they rewrite Discord traffic instead (`phoenix.discord.onRequest/onResponse`, gateway `hook`) and feed updates back with `phoenix.enqueue`. CustomFavorites does this to the settings proto (`proto.ts`).
- Plugins can't write files. `npm run receive` starts `report-receiver.mjs`, which saves text that a plugin POSTs to it into `reports/` (gitignored), for getting debug output off the phone.

## Adding a plugin

- Equicord: `equicord-plugins/<Name>/index.ts(x)`.
- Kettu: `kettu-plugins/plugins/<Name>/index.tsx` + `manifest.json`, and add its install URL to `kettu-plugins/README.md`.
- Valenced: `valenced-plugins/plugins/<Name>/index.tsx` + `manifest.json` + `tsconfig.json`.
- Phoenix: `phoenix-plugins/plugins/<Name>/index.ts`, starting with `// @description`, `// @version`, `// @author` lines.
