# Shared terminals

Opt-in (`"terminals": true`). Agents can see and use the session's terminal tabs in
the Review pane, so you and the agent can share an interactive shell: you start
something, the agent reads it; the agent types, you watch and can take over at any
time.

## Tools

| Tool | What it does |
|---|---|
| `terminal_list` | The session's terminals (yours from the Review pane and ones the agent opened): title, directory, what is running |
| `terminal_read` | The last lines of a terminal's screen and scrollback (default: the most recently active terminal) |
| `terminal_write` | Types text, named keys (`enter`, `tab`, `escape`, arrows, `ctrl-c`, …) and optionally Enter, then returns the screen once output settles |
| `terminal_open` | Opens a new terminal in the session (shown in the Review pane), optionally running a program |

Terminals of the agent's session and its parent sessions are included (subagents
see their parent's terminals).

## Permissions

Typing is allowed by default. Set `"terminalWrite": "ask"` in the plugin options to
get OpenCode's native permission prompt (action `open_enhance_terminal_write`,
resource = terminal id) before each write; native rules for that action apply.

## How it works

OpenCode 2.2.6 lets server plugins only read the focused terminal, and the Desktop
authenticates to its server outside the page. So terminal operations run in the
Desktop app: the agent's tool sends a request; one open Desktop window claims it
(so it runs exactly once, even with several windows), performs it with its own
client and returns the result. Without a Desktop window open, the tools say so.

Only the controlling attachment of a terminal can type. To type, the window takes
control of the terminal for a moment, sends the keys, and detaches; control
returns to your tab, which keeps working as before. Everything typed is visible
in the tab.

Verified with the installed OpenCode Desktop 2.2.6 (isolated profile): user input,
agent read, agent write in the same tab, user input again afterwards.

## Limits

- Needs the Desktop app open (any window) on the machine running the server.
- A full-screen program (editor, `top`) is read as its current screen.
- The agent sees whatever the terminal shows, including secrets printed there.
