# Valenced plugins

Plugins for [Valenced](https://github.com/Valenced/valenced), the Discord mobile mod that replaced Revenge Next.

## Install

Valenced installs plugins from repositories, not single plugin URLs. In Discord, open the Valenced plugin settings, add this repository, then install the plugin from it:

```
https://johnnycyan.github.io/discord-plugins/valenced/index.json
```

| Plugin | ID |
|---|---|
| CustomFavorites | `johnnycyan.custom-favorites` |

## CustomFavorites

Same features as the [Kettu version](../kettu-plugins/README.md#customfavorites). Your Kettu favorites don't carry over on their own, since each mod keeps its own storage: export them to the clipboard from the Kettu plugin settings, then import from the clipboard in the Valenced plugin settings. Sync through the [sync server](../sync-server/README.md) works across all three versions.

## Development

```sh
bun install
bun run build        # plugins/<Name>/build/js/index.js
node package.mjs     # dist/pool/<id>@<version>.zip and dist/index.json
```

`bun run serve` serves the built plugins to a device for testing; see the [plugin template](https://github.com/Valenced/valenced-plugin-template).

Each plugin lives in `plugins/<Name>/` with an `index.tsx`, a `manifest.json` and a `tsconfig.json`. Code shared with the Equicord and Kettu versions lives in `../equicord-plugins/<Name>/` and is imported from there.

**Never reuse an imported name for a local variable or parameter.** The plugin CLI rewrites every use of an imported name (such as `before` from `@valenced/patcher`) into its runtime global without checking scope, so a local `before` silently becomes the patcher function.

**Patch lazily loaded Discord modules with `getModules`, not `lookupModule`.** Valenced only searches modules Discord has already loaded, unlike Kettu, which loads everything.

**Bump `version` in the plugin's `manifest.json` for every release.** Valenced only offers an update when the version changes. GitHub Pages only holds the current build, so `dist/pool` has one ZIP per plugin, the current version.
