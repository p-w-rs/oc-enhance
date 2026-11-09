# Keyboard behavior

## Desktop: deferred, not a release blocker

The requested **Enter = newline / Shift+Enter = send** swap is not implemented. The documented OpenCode 2.2.6 GUI contract does not provide a native composer submit operation or a writable native keybinding API. No verified documented Desktop setting for this swap was found.

`Composer.insert()` inserts plain text, but does not replace selected text like native editing. `Composer.text()` is plain text only: attachments and attached parts are omitted, mentions become text, and shell-mode input is a shell command. Calling `session.prompt()` with that string would bypass native submission semantics and risk losing attachments, mentions, shell behavior, or draft state. The plugin therefore does not intercept these keys, guess built-in command IDs, simulate button clicks, or edit global configuration. Native Send/Stop and editor behavior remain intact.

## TUI only: native configuration recipe

For terminal clients, merge these entries into your existing global `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`):

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "keybinds": {
    "input.newline": "return,ctrl+return,alt+return,ctrl+j",
    "input.submit": "shift+return"
  }
}
```

This uses native input actions, preserving the native prompt's attachments and editing behavior rather than rebuilding a prompt from text. If you already bind `prompt.submit`, remove a conflicting Enter binding or set it to `shift+return` as well. Other input fields using these shared input actions may also change; dialog and autocomplete selection have separate native commands. Your terminal must distinguish Shift+Enter from Enter. Valid edits reload automatically. This is guidance only; setup does not modify the file, and these settings do not affect Desktop.

References: [GUI composer and commands](https://opencode.ai/docs/build/plugins/gui), [CLI settings](https://opencode.ai/docs/cli/config), [CLI keybinds](https://opencode.ai/docs/cli/keybinds).
