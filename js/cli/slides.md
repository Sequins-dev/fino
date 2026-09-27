---
weight: 39
---
# slides

`fino slides` serves one trusted MDX or presentation-module file in a browser.
The audience page follows the presenter by default; add `?follow=false` to the
audience URL for an independent viewer session. File changes reload the deck
without restarting the server.

```sh
fino slides talk.mdx
fino slides talk.mdx --port 4000
fino slides talk.mdx --host 0.0.0.0
```

The command prints the audience URL at `/` and the presenter URL at
`/_presenter`. It binds to `127.0.0.1:3000` by default. `--port 0` selects an
available port and prints the selected port. `--host` changes the listener's
bind address, including to `0.0.0.0` for access from other machines; use the
machine's reachable address in shared links when binding to a wildcard address.

The presenter route is unauthenticated. Anyone who can reach a public bind can
open it and control the shared presentation. For a public audience with protected
presenter controls, mount `Presentation.viewer()` and
`Presentation.presenter()` in your own `App` and apply middleware to the latter.

The file is loaded before the server announces its URLs. A missing or invalid
deck exits with an error. Stop the command to close the listener and deck
watcher. MDX and presentation modules are executable trusted code.
