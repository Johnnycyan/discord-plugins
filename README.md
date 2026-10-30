# Kettu plugins

Plugins for [Kettu](https://github.com/C0C0B01/Kettu) (and other Vendetta-compatible Discord mobile mods).

## Install

In Discord, open **Settings → Plugins → +** and paste the plugin's URL.

| Plugin | URL |
|---|---|
| CustomFavorites | `https://johnnycyan.github.io/kettu-plugins/CustomFavorites/` |

## CustomFavorites

Replaces Discord's Favorites with a local, unlimited version while keeping Discord's own UI.

- No favorites limit (Discord allows 3 free, 200 with Nitro).
- Your favorites are stored on the device by the plugin. Discord's synced Favorites are never changed.
- Import from Discord's Favorites (offered once on first start, or any time from the plugin settings), replacing or merging.
- Export to and import from the clipboard as JSON.
- Shows the server icon next to favorited server channels.
- Remembers where a channel sat in a category: when you move it out with **Move to…** and later move it back, it returns to its old spot instead of the bottom.
- Optional sync with the Equicord version through a self-hosted server: see [sync-server](sync-server/README.md).

## Development

```sh
npm install
npm run build   # or: npm run watch
```

Each plugin lives in `plugins/<Name>/` with an `index.tsx` and a `manifest.json`. CustomFavorites' `placement.ts` and `sync.ts` are shared with the Equicord version; keep the copies identical. The build writes `dist/<Name>/manifest.json` and `dist/<Name>/index.js`, and GitHub Actions publishes `dist/` to GitHub Pages on every push to `main`.

Kettu runs plugins through Hermes `eval`, where `let`/`const` inside loops are function scoped. Never close over a loop variable; use array methods instead.
