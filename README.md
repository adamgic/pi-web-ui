# Pi Web UI

A browser interface for the **same session as your Pi terminal**, packaged as an independent Pi extension. It uses Pi's public extension APIs and ordinary session storage. There is no durable engine, separate agent process, build step, or dependency on a Pi source checkout.

Tested against `@earendil-works/pi-coding-agent` 1.1.0. Requires Node.js 22.19+ and Pi installed on your PATH. This package has no additional runtime dependencies.

## Quick start

From the workspace where you want Pi to work, run:

```sh
sh ./pi-web-ui/start.sh
```

This starts the Pi terminal with the extension and opens your default browser. It preserves your working directory. If the extension is elsewhere, use the corresponding path to `start.sh`.

Equivalent command:

```sh
pi --extension ./pi-web-ui/src/index.ts --web-ui
```

The server chooses a free loopback port. Optional arguments are forwarded to Pi:

```sh
sh ./pi-web-ui/start.sh --continue
sh ./pi-web-ui/start.sh --web-ui-port 4317
sh ./pi-web-ui/start.sh --web-ui-no-open
```

If Pi is not installed, install `@earendil-works/pi-coding-agent` using your preferred package manager. Alternatively, `PI_BIN` selects an existing Pi executable. In the original development workspace, the adjacent Pi checkout can be used explicitly:

```sh
PI_BIN=./pi/pi-test.sh sh ./pi-web-ui/start.sh
```

That checkout needs its own dependencies and model metadata prepared. The extension does not automatically find or modify sibling repositories.

## Install as a Pi package

For persistent installation, from the parent directory:

```sh
pi install ./pi-web-ui
```

Then start Pi normally and enter `/web`. To open the browser automatically at startup:

```sh
pi --web-ui
```

The `pi.extensions` field in [package.json](package.json) points to the extension entry file. Once this repository is hosted, Pi can install it with `pi install git:github.com/OWNER/REPOSITORY`. No upstream Pi PR or fork is required. For npm distribution, the package includes `src/`, `public/`, both launchers, this README, and the license; tests and output are excluded.

## Commands and controls

Terminal commands:

| Command | Behavior |
| --- | --- |
| `/web` or `/web open` | Start the server if necessary and open the browser. |
| `/web url` | Start if necessary and display the launch URL without opening it. |
| `/web stop` | Close browser connections and stop the server; Pi keeps running. |

Browser controls:

| Control | Behavior |
| --- | --- |
| Enter / Send | Send a prompt, or steer active work. |
| Shift+Enter | Insert a newline. |
| Arrow Up / Arrow Down | Move within multiline input first. Up on the first line browses older prompts; Down on the last line browses newer prompts, then restores your unsent draft (or empty input), including its cursor position. |
| Alt+Enter / Follow-up | Queue a prompt after the current run. |
| Escape / Stop / `/abort` | Request cancellation through Pi. |
| Alt+M / Model / `/model` | Select an authenticated model while idle. |
| Alt+T / Thinking / `/thinking` | Cycle thinking levels; Pi clamps to the model's capabilities. |
| Compact / `/compact [instructions]` | Compact context when idle. |
| Alt+O | Expand or collapse tool and reasoning details. |
| `/help` | Show browser shortcuts. |
| Sessions | Open a searchable list of saved sessions for the current working directory. |
| New session (inside Sessions) | Start a fresh Pi session and switch both the terminal and browser to it. |

The browser displays the active session branch, streaming responses and reasoning, tool arguments/results, compaction summaries, model selection, token/cost estimates, and available tools. Queued work is indicated; the public extension API does not expose the full queue text. Pending messages appear in the transcript when Pi consumes them.

The sidebar shows the full working directory (with the home prefix shortened to `~`), session name or first prompt, creation time, current-branch message count, provider/model, and session-file path. The model name, session name, and working directory are clickable to copy; the directory copies its full path. Session details sit below the always-visible model name and start collapsed. Click the arrow or **Session details** label to expand or collapse them. The model is not repeated inside the details. Only the session ID shows a full-value preview on hover or focus. Click any detail value to copy it. Copy feedback appears as yellow, orange-bordered toasts at the top left for three seconds; multiple notices stack and fade away in order. Model usage includes input/output tokens, cache reads/writes, context usage and capacity, and estimated cost. The sidebar scrolls independently in short windows. Ready, disconnected, and animated thinking status share the same text size above the prompt.

Prompt history comes from the active session and includes prompts accepted from this tab that are still queued. Switching history items preserves the cursor's character column, clamped to the destination line's length. Up enters the last line; Down enters the first line. While browsing, edits to recalled prompts are kept for that navigation pass; returning to your draft restores the original unsent text and saved cursor position. History is held steady during navigation so streaming updates do not move your position. Modified arrow keys retain their normal text-editing behavior.

Light and dark appearance follow the OS/browser preference, including live changes. The page fits normal window sizes; the transcript scrolls within its panel. At widths of 440px or less, or heights of 560px or less, vertical page scrolling is enabled.

The footer shows an animated gradient through “Thinking…” while Pi is working, and “Compacting…” during compaction. It returns to “Ready” when idle. Reduced-motion settings disable the animation while retaining the activity label.

## Authentication and terminal interactions

Run `/login` **in the Pi terminal** to authenticate your provider, then open the browser model picker. It refreshes the available models from Pi. Provider credentials remain managed by Pi; the extension does not implement a second login flow or send credentials to browser JavaScript.

Use the **Sessions** picker in the top bar to search saved sessions, switch sessions, or create a **New session**. The list refreshes each time the picker opens. These actions are available while Pi is idle with no queued messages or compaction. The picker shows session names (or the first prompt), message counts, and modification times. It respects the current session directory, and only lists sessions for the current working directory. Pi's session-change hooks can cancel an operation. A blank session may not appear in the saved list until Pi persists it after a conversation.

Use the terminal for `/tree`, `/reload`, custom extension commands, permission dialogs, and other terminal UI interactions. Terminal `/resume` and `/new` remain available too. The browser provides its own small command set; use the session buttons instead of typing those slash commands in the browser. Unknown slash commands receive guidance and are never forwarded as model prompts, including through the follow-up button.

The extension does not replicate arbitrary terminal widgets, browser file uploads, or durable task/subagent navigation. It shows the active Pi session. This is a browser frontend for an ordinary Pi session, with the terminal available for the remaining workflows.

## Session lifecycle

Closing a tab leaves Pi running. Multiple tabs share the same session; each keeps its own draft. Reconnecting retrieves a fresh snapshot and does not resend prompts.

Pi controls history persistence. A normal saved session can be resumed with `pi --continue`; in-memory sessions follow Pi's own semantics. Interrupted model calls and tools do not gain durable recovery from this extension.

Browser-initiated session changes hand the existing HTTP server to the replacement extension runtime. The URL, access token, and browser connections stay valid; all connected tabs follow the new active session. Each tab keeps a separate unsent draft for each visited session in memory.

Terminal-initiated session replacement, reload, and shutdown close the old server and connections. With `--web-ui`, a subsequent interactive session start opens a new server automatically. Otherwise run `/web` again. Old tabs then need the new launch URL, which has a fresh token. `/web stop` leaves the terminal session active.

## Local transport

The server binds only to `127.0.0.1`. The launch URL contains a random access token in its fragment. Browser JavaScript moves it to tab-scoped session storage and removes the fragment from the address bar. API requests use an authorization header; host/origin validation and a restrictive content security policy protect the local endpoint. Anyone with the launch URL can control this session; treat it as private.

Commands have identifiers for bounded replay protection within the server process. Streaming uses server-sent events (SSE): HTTP responses that carry successive session snapshots. Full snapshots simplify reconnects; this is not optimized for extremely large histories. Slow connections with excessive queued output are disconnected and reconnect automatically. Live tool previews retain the last 64,000 characters; completed results come from Pi's session history.

## Implementation

| File | Responsibility |
| --- | --- |
| [src/index.ts](src/index.ts) | Package entry point; supplies Pi's public session discovery API to the extension. |
| [src/extension.js](src/extension.js) | Registers `/web`, CLI flags, Pi event listeners, browser launch, and cleanup. No server starts during extension registration. |
| [src/transport.mjs](src/transport.mjs) | Keeps the server alive during browser session changes and transfers ownership to the new extension runtime through a temporary handoff. |
| [src/bridge.mjs](src/bridge.mjs) | Maps public Pi session APIs/events into browser snapshots and validates browser actions. Handles the gap between `message_end` and session persistence. |
| [src/server.mjs](src/server.mjs) | Serves fixed static assets, authenticated commands, current state, and SSE updates. |
| [public/app.js](public/app.js) | Browser rendering, dialogs, keyboard controls, safe text/Markdown rendering, and reconnects. |
| [public/view.js](public/view.js) | Pure transcript and usage projections from ordinary Pi session entries. |
| [public/index.html](public/index.html), [public/style.css](public/style.css) | Accessible interface structure, responsive layout, and OS theme selection. |
| [start.mjs](start.mjs), [start.sh](start.sh) | Launch the installed Pi executable with this extension enabled. |
| [test](test) | Fake-host unit/HTTP tests and a real Chromium browser check. |

The browser assets and transport were adapted from the existing MIT-licensed Pi durable web UI. The backend now uses ordinary extension/session APIs; there are no imports from Pi's experimental adapter or fork internals.

## Verification

From this package's repository checkout:

```sh
npm run check
node --test test/*.test.mjs
node test/browser.mjs
```

The browser check uses Chrome's DevTools protocol directly, without an additional testing dependency. It defaults to the macOS Google Chrome path; set `CHROME_PATH` elsewhere. It saves screenshots/results under [output](output) and retains its disposable browser profile under `temp/`.

Each assistant response has an overlapping-rectangles copy icon (hover for **Copy response**) that copies its original text, preserving Markdown syntax for pasting into a `.md` file. During streaming it copies the text received so far. Copying shows a toast. **Expand tool details** sits to the right of the activity indicator above the prompt; Alt+O still works without an inline shortcut hint.

Response links open in a new tab. Explicit Markdown links, bare HTTP(S) URLs,
file paths, and filenames in inline code are clickable. Relative files resolve
against the session working directory. Use `[label](<path with spaces.md>)` for
paths containing spaces.

Local `.md` and `.markdown` files open in the built-in Markdown preview with a
source toggle; no browser extension is required. The lightweight renderer supports
headings, paragraphs, lists, bold, inline code, fenced code, and links. Raw HTML
is displayed as text. Other text files open as source. Preview reads require the
launch token and are limited to 2 MiB. Any file readable by the Pi process can
be previewed, including files outside the working directory and symlink targets.
Local references (including backtick-only names) are checked while rendering;
only existing files become links. Relative paths use the session working directory;
absolute paths, `../`, `~/`, and `file://` links are supported. Binary files are not previewed.
External Markdown and text-file URLs are fetched on click and shown in the
built-in preview. Ordinary web pages open directly. Remote reads time out after
15 seconds and do not forward the launch token or browser cookies. File links refer to the machine running Pi.

Math in Markdown previews and responses is rendered locally with bundled KaTeX
as accessible MathML. Inline `$...$` and `\(...\)`, display `$$...$$`, and
multiline `\[...\]` support fractions, subscripts, superscripts, vectors, and
aligned equations. Code spans and fenced code stay literal; invalid equations
fall back to their source. The source toggle always shows the original file.
No browser extension or CDN connection is required.
