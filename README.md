# dsh-px0

**English** | [简体中文](README.zh-CN.md)

A DSH (DeepSeek Harness) plugin that previews workspace files with [px0](https://github.com/px0-ai/px0) in the right sidebar.

px0 is a fast, single-binary code IDE. This plugin embeds it in the Harness Web UI's right column, alongside the built-in file tree and previews.

## What it does

- **Auto-downloads px0** for the current platform/arch from GitHub Releases on first start, verifies its sha256 against the release's `checksums.txt`, and caches it under `bin/`. A `px0Path` config overrides this with your own binary.
- **Runs px0 as a managed child process** on a loopback port, with `-base-path /px0/`, restarted when the workspace root changes and killed when the plugin unloads.
- **Proxies px0 on the same origin** (`/px0/*`) so the sidebar iframe can embed it, stripping px0's `frame-ancestors 'none'` CSP and `X-Frame-Options` response headers. px0 itself stays bound to `127.0.0.1` and is unreachable except through the authenticated Harness origin.
- **Registers a right-sidebar tab type** that claims workspace file addresses at the `extension` band (outranking the built-in text preview) and renders px0 in a same-origin iframe.
- **Opens fullscreen** when the tab mounts, since px0 is a full IDE.
- **Follows the Session's working directory**: switching a Session's directory restarts px0 at the new root, showing a self-contained loading page while it comes back.
- **Adds context-menu entries inside px0** that insert file references into the DSH composer:
  - file tree → `@file:<path>`
  - code selection → `@file:<path> lines:<fromLine>:<fromCol>-<toLine>:<toCol>`
- **Reports px0 updates**: checks the latest release once per run and offers an update button in the tab toolbar.

## Install

Install the bundle directory (`bundle/`) into a DSH profile:

```
plugin_manager: install_bundle  target: <path>/bundle
```

Or link it into a profile manually:

```json
{
  "dependencies": { "@dsh-xhl/dsh-px0-preview": "link:../path/to/dsh-px0/bundle" },
  "dsh": { "profile": { "bundles": ["...", "@dsh-xhl/dsh-px0-preview"] } }
}
```

Then open the right sidebar's guide page and pick the **px0** entry.

## Configuration

| Key | Type | Description |
| --- | --- | --- |
| `px0Path` | string | Absolute path to a px0 binary you manage yourself. Disables the managed download and update checks. |

## Layout

```
bundle/
├── index.js          Host half: binary management, process, /px0 proxy, /px0-api control plane
├── client.js         Client half: tab type, iframe host, loading/error states, composer insertion
├── px0-extras.js     Script injected into px0's document: context-menu additions
├── cordis.patch.yml  Loader patch inserting the plugin row
├── icon.svg
└── locale/           en / zh-CN display metadata
```

## Notes and limitations

- px0 fixes its root directory for the process lifetime, so switching between workspaces restarts it. Large repositories take a few seconds to index on first open.
- The px0 UI keeps its own theme; it does not follow the Harness light/dark setting.

## License

MIT
