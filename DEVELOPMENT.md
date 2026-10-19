# Developing Semble for Obsidian

This covers setup, how the plugin works, and releasing. For what the plugin does, see the [README](README.md).

## Setup

Requirements: Node 22+ and npm.

```sh
npm install
npm run dev      # watch mode: rebuilds main.js whenever you save a file
npm run build    # type-check, then make a minified production build
npm run lint     # ESLint with Obsidian's official rules (eslint-plugin-obsidianmd)
npm test         # unit tests (Vitest): link extraction, API client, URL helpers
```

### Trying it in a vault

Use a separate test vault, not your real one. Link the repo into the vault's plugin folder; the folder name must match the `id` in `manifest.json`:

```sh
ln -s "$(pwd)" /path/to/test-vault/.obsidian/plugins/semble
```

Then in Obsidian go to **Settings → Community plugins**, turn on community plugins, and enable **Semble**. With `npm run dev` running, use the **Reload app without saving** command to pick up changes, or install the [Hot Reload](https://github.com/pjeby/hot-reload) plugin to reload automatically.

### Checking the mobile layout

To preview the mobile UI on desktop, open the developer console (`Cmd+Opt+I` on macOS, `Ctrl+Shift+I` on Windows and Linux) and run:

```js
this.app.emulateMobile(true); // emulateMobile(false) switches back
```

Obsidian reloads with the mobile interface: sidebars become drawers, `body` gets the `is-mobile` class, and `Platform.isMobile` is `true`. To try phone widths, turn on the DevTools device toolbar (`Cmd+Shift+M` on macOS, `Ctrl+Shift+M` on Windows and Linux) and pick a device size. This is the quickest way to check layout and styles. It still runs on Electron, though, so test on a real device before a release.

## Project layout

```
src/
  main.ts                 Plugin entry point: registers the view, command, ribbon icon and settings tab; owns the API client
  view.ts                 LinksView (an ItemView): tracks the active note, renders the list and its save counts, swaps in the link view
  links.ts                Pure web link extraction: no runtime Obsidian imports, so it's unit tested in Node
  api.ts                  Typed Semble API client built on Obsidian's requestUrl, with a stale-while-revalidate cache
  settings.ts             Settings tab: the API key secret and Check connection
  ui.ts                   Shared UI helpers: tree-item rows and their count badges, toggle-button groups, messages, confirm modal
  icon.ts                 The Semble logo as an outline icon, for the ribbon, the pane's tab and settings search
  urls.ts                 Pure URL helpers: host names, validation, URL comparison, semble.so page links
  detail/
    LinkDetail.ts         The link view: top bar, header with stats, tabs
    context.ts            DetailContext shared by the panels; Panel and PagedPanel base classes
    LibraryPanel.ts       Add tab: collections, note, add/update and remove
    ConnectionsPanel.ts   Connections tab: connection list and the add-connection form
    lists.ts              Related tab, plus the Saved by and In collections lists opened from the stats (paged)
tests/
  links.test.ts  api.test.ts  urls.test.ts
styles.css      Pane styles; Obsidian loads this automatically
manifest.json   Plugin metadata read by Obsidian
versions.json   Maps each plugin version to its minimum Obsidian version
```

## How it works

**Finding links.** Obsidian's metadata cache doesn't record external links, so `extractLinks(content, cache)` scans the note text. Before scanning, it blanks out the regions that can't contain web links: code blocks, inline code, math blocks, frontmatter, and internal links. It gets the internal link positions from the metadata cache, so a URL used as alias text, like `[[Note|https://…]]`, isn't listed. Blanking replaces characters with spaces, so offsets and line numbers still match the original text. Markdown links come first, then `<autolinks>`, then bare URLs. Each pass blanks what it matched so the next pass can't count the same link twice. Only `http://` and `https://` URLs are kept.

Links are listed in the order they appear in the note. Each link keeps its `Pos` (line, column, offset), which **Jump to link in note** uses to select the link's text.

**Tracking the note.** Like Outline, the pane shows the most recently _opened_ file, not whichever pane has focus. So when you click into the sidebar, it keeps showing your note. The view listens to these events:

| Event                   | Reaction                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `workspace:file-open`   | Switch to the new file                                                                                 |
| `metadataCache:changed` | Re-extract links, debounced, if it's our file. This fires after edits, so the pane updates as you type |
| `vault:delete`          | Clear the pane if our file was deleted                                                                 |

`refresh()` reads the file asynchronously, so each call takes an ID first. If a newer refresh has started by the time the read finishes, the older result is thrown away.

**Save counts in the list.** Each row's count comes from the same `getUrlMetadata` request as the link view's header, which is cached. When the list draws, `peekUrlInfo()` applies cached counts immediately. Missing counts are fetched once the note has been unchanged for a second, so typing a URL doesn't look up every partial URL. Counts are fetched three at a time. Opening a note, or returning from a link view, re-checks every count in the background.

**The link view.** `LinksView` keeps the list in the DOM and hides it while a link is open, so the filter and scroll position survive going back. `LinkDetail` is a `Component` added as a child of the view. The content below the tab bar, whether a tab or a stat's list, is a child `Panel`. So switching views, going back, or closing the pane unloads it along with its listeners. Panels load data asynchronously and check an `alive` flag, plus a request counter where a request can be repeated, before rendering. This drops responses that arrive after you've moved on. Switching to another note returns to the list, and changing settings rebuilds an open link view.

**Opening links.** `openLink()` sends every web link to its Semble page, `https://semble.so/url?id=<encoded link>`. The only exception is Semble collection links (`semble.so/profile/<handle>/collections/<rkey>`), which open as they are. Profile and collection pages from the Saved by and In collections lists are opened directly with `openUrl()`. Collection pages use the `rkey` from the end of the collection's AT URI. Both use `window.open()`, which Obsidian sends to the system browser, or to the Web viewer core plugin if that's enabled.

**Semble API.** `SembleClient` (`src/api.ts`) calls `https://api.semble.so/xrpc/<method>` with the key in the `x-api-key` header and `X-Semble-Client: semble-obsidian-plugin` to identify the integration. It reads the key on every request, so a key change takes effect immediately.

**Caching.** GET responses are cached in memory and served _stale-while-revalidate_:

- Opening a link, or switching tabs, renders straight from the cache. Anything more than 10 seconds old is then fetched again in the background.
- If the fresh data is identical, nothing changes on screen. If it differs, such as a new collection, save or connection, the client updates the cache and calls `onChange` listeners. The link view then redraws its header, and the current tab unless you're mid-edit: unsaved collection changes, a search or filter, extra pages loaded, or the add-connection form open. Each panel's `canRefresh()` decides this. The link list redraws its counts.
- Data more than an hour old isn't shown. It's fetched first.
- The client caches the promise, not just the result, so identical requests that are already in flight are shared.
- Failed requests are never cached, and a failed background check keeps the cached data.

Your own changes are known to make data stale, so each one clears the affected entries and they're fetched fresh:

- Adding, updating or removing a library card clears that URL's entries and the collection lists.
- Creating a collection clears the collection lists.
- Creating or deleting a connection clears entries for both of its URLs.

Entries are matched with `sameUrl()`, because Semble normalizes URLs: for example, `https://semble.so` becomes `https://semble.so/`. A different API key clears the whole cache.

**Errors.** 401 and 403 responses turn into a "check your API key" message, and other errors show the API's own `message`.

**Endpoints used:**

| Where                    | Endpoints                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List counts, header      | `card.getUrlMetadata` (with `includeStats`)                                                                                                                                                               |
| Saved by, In collections | `card.getLibrariesForUrl`, `collection.getForUrl`                                                                                                                                                         |
| Add                      | `card.getLibraryStatus`, `collection.listMine`, `collection.getRecommendedForUrl`, `collection.search` (open), `collection.create`, `card.addUrl`, `card.updateUrlAssociations`, `card.removeFromLibrary` |
| Related                  | `search.getSimilarUrls`                                                                                                                                                                                   |
| Connections              | `connection.getForUrl` (both directions), `connection.create`, `connection.delete`, `actor.getMyProfile` (to know which connections are yours)                                                            |
| Settings                 | `actor.getMyProfile` (Check connection)                                                                                                                                                                   |

**The icon.** `icon.ts` uses the four stone paths from Semble's logo unchanged, drawn as a `currentColor` outline. The stroke weight matches Obsidian's Lucide icons, so the icon follows the theme like the other sidebar icons. Obsidian doesn't show icons for community plugins in the settings sidebar, but it does show the settings tab's icon in settings search results.

## Obsidian best practices followed

- **First run:** once the workspace layout is ready, the plugin adds its pane to the right sidebar with `ensureSideLeaf()`, without switching to it, so its tab icon is there from the start. A `paneAdded` flag in `data.json` makes this happen only once. After that, Obsidian's saved layout decides where the pane is, and a closed pane stays closed.
- **Views:** the plugin never keeps references to its view. It looks them up with `getLeavesOfType()` and checks `instanceof LinksView`, because leaves can be deferred since 1.7. It doesn't detach leaves in `onunload()`, so the pane stays in place when the plugin is updated.
- **Cleanup:** every listener is attached with `registerEvent` / `register*`, so it's removed automatically when the view closes or the plugin unloads.
- **Native UI:** the plugin uses Obsidian's own building blocks instead of custom widgets, so it looks right in any theme:
    - Every list is built from core `tree-item` rows.
    - The link view's top bar puts back on the left and actions on the right, like Obsidian's own back buttons. It uses core `clickable-icon` buttons. The tabs and filter rows are `clickable-icon` buttons too, marked `is-active`, so they pick up the theme's hover and active states.
    - The search box is a `SearchComponent`, the collection picker uses native checkboxes, and actions are standard buttons with `mod-cta` and `mod-warning`.
    - Confirmations open in a `Modal`. Everything else stays in the sidebar.
    - `styles.css` only adds layout, using theme variables throughout.
    - Elements are created with `createEl` / `createDiv`, never `innerHTML`.
- **Workspace API:** it uses `getActiveFile()`, `revealLeaf()` and `Keymap.isModEvent()` instead of `workspace.activeLeaf` or hand-rolled modifier-key checks.
- **Settings:** settings are declared with `getSettingDefinitions()` (Obsidian 1.13+), which makes them show up in settings search. A `display()` fallback renders the same definitions on older versions. Labels use sentence case. The settings loader keeps only known keys, so options removed in earlier versions drop out of `data.json`.
- **Secrets:** the API key lives in `app.secretStorage`, shown as Keychain in Obsidian's settings (Obsidian 1.11.4+). The settings only store the secret's name. This is why `minAppVersion` is 1.11.4.
- **Network:** requests go through `requestUrl`, not `fetch`. It isn't subject to CORS and works on mobile.
- **Commands:** command IDs and names don't include the plugin name (Obsidian adds it as a prefix), and no hotkeys are assigned by default.
- **Mobile:** the plugin uses no Node or Electron APIs, so `isDesktopOnly` is `false`.
- **Linting:** `eslint-plugin-obsidianmd` checks the same guidelines that Obsidian's review uses for community plugin submissions. This includes flagging APIs newer than `minAppVersion`. "Semble" is added to the sentence-case rule's `ignoreWords` because it's a product name.

## Releasing and distribution

Obsidian installs plugins from GitHub releases: each release must have `main.js`, `manifest.json` and `styles.css` attached. The release workflow (`.github/workflows/release.yml`) builds these for you.

### Before the first release

- **Public repo:** the plugin must live in a public GitHub repo. For example:
    ```sh
    gh repo create cosmik-network/semble-obsidian-plugin --public --source . --push
    ```
- **Manifest:** check `manifest.json`. The `id` must be unique in the community directory (`semble` was free when checked) and must not contain "obsidian". The name and description shouldn't mention Obsidian either. Optionally add a `fundingUrl`.
- **Docs:** the `LICENSE` (MIT) and the README's _Network use and privacy_ section are required by Obsidian's developer policies for plugins that use the network or need an account. Keep that section accurate if what the plugin sends changes.

### Releasing a version

The tag must match the version in `manifest.json` exactly, with no `v` prefix.

**First release** (`manifest.json` is already at `0.1.0`):

```sh
git tag 0.1.0
git push origin 0.1.0
```

**Later releases:**

```sh
npm version patch    # or minor / major; updates manifest.json and versions.json via version-bump.mjs, then commits and tags
git push --follow-tags
```

The workflow then lints, tests, builds, and creates a **draft** GitHub release with the three files attached. Open it on the repo's Releases page, add release notes, and click **Publish**. Users get the update once the release is published.

If you raise `minAppVersion`, update it in `manifest.json` before running `npm version`. `versions.json` then records which plugin versions need which Obsidian version, so people on older Obsidian versions get the last compatible release.

### Beta testing with BRAT

Before (or alongside) the community directory, testers can install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin and add this repo's URL. BRAT installs from the GitHub releases and keeps the plugin updated.

### Submitting to the community plugin directory

Obsidian's own guide, in case the process changes: [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin).
