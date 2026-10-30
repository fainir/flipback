# Privacy

flipback has no server and collects nothing.

- **What it reads:** when a turn ends, the tail of that session's transcript, which Claude Code already
  keeps on your machine: your last request, the agent's reply text and the names of the tools it used.
- **What it sends:** on turns that need a verdict, that excerpt goes to a small model through your own
  `claude` CLI (`claude -p`, Haiku by default, with no tools, MCP servers or hooks), so it is handled
  under your Claude account and Anthropic's terms, like any other Claude Code request. flipback has no
  network code of its own and no other destination.
- **What it stores:** nothing. It writes no files and the judge runs with `--no-session-persistence`.
- **Turning it off:** set `FLIPBACK_OFF=1`, or disable the plugin with `/plugin`.

Questions: open an issue at https://github.com/fainir/flipback/issues.
