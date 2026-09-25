---
title: Browser (experimental)
description: Open web pages beside your terminals.
---

Browser tabs let you use websites and development servers inside a tree.

You can interact with the page while an agent uses it. A robot icon appears in the toolbar during an agent command.

## Open a page

1. Open **New tab** and select **Browser tab**.
2. Enter a URL or search terms in the address bar.
3. Press Enter.

Use **Development servers** beside the address bar to open a detected server.

The tab supports navigation, page search, fullscreen, pointer lock, and normal keyboard and pointer input.

## Browser requirements

The local macOS app includes browser support. For browser hosting without the local app:

- **macOS:** Install Google Chrome in Applications.
- **Linux:** Install local, rootful Docker, then select **Set up browser** when prompted.

Docker access gives extensive host privileges. Grant it only to trusted users.

Remote viewing requires a browser with WebCodecs VP8 support, such as Chrome.

## Browser data and limits

Browser tabs on the same host share login state. Anyone with browser access, including agents, can use those signed-in accounts.

Treeport uses its own browser data, not your personal browser profile.

Remote browser tabs do not support audio, downloads, or file uploads.
