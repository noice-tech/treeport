---
title: Browser (experimental)
description: Open web pages beside your terminals.
---

Browser panels let you use websites and development servers inside a tree. You and an agent can use the same live page.

## Open a page

1. Open **New panel** and select **Browser**.
2. Enter a URL or search terms in the address bar.
3. Press Enter.

Use **Development servers** beside the address bar to open a detected server.

The panel supports navigation, page search, and normal keyboard and pointer input.

## Browser requirements

The local macOS app includes browser support. For browser hosting without the local app:

- **macOS:** Install Google Chrome in Applications.
- **Linux:** Install local, rootful Docker, then select **Set up browser** when prompted.

Docker access gives extensive host privileges. Grant it only to trusted users.

Remote viewing requires a browser with WebCodecs VP8 support, such as Chrome.

## Browser data and limits

Browser panels on the same host share login state. Anyone with browser access, including agents, can use those signed-in accounts.

Treeport uses its own browser data, not your personal browser profile.

Remote browser panels do not support audio, downloads, or file uploads.
