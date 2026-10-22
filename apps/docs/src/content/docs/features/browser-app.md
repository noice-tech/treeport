---
title: Browser
description: Open web pages beside your terminals.
---

Browser apps let you use websites and development servers inside a tree.

You and your agents share the same live page. A robot icon in the toolbar shows when an agent is using it.

## Open a page

1. Open **New app** and select **Browser**.
2. Enter a URL or search terms in the address bar.
3. Press Enter.

Use **Development servers** beside the address bar to open a detected server.

The app supports navigation, page search, fullscreen, pointer lock, and normal keyboard and pointer input.

## Local and remote browsers

Treeport picks the browser based on how you connect:

- **Local browser:** When the macOS app runs on the same computer as Treeport, pages open in the app's built-in browser.
- **Remote browser:** In the web interface, or when the macOS app connects to [another computer](/features/remote-access/), the browser runs on the host, next to your development servers and agents. Your device streams it, so agents keep working after you disconnect.

Agents can use either browser.

Opening a development server in your own browser through a tunnel gives you a separate session, not the page your agents use.

## Browser requirements

The local macOS app includes browser support. For browser hosting without the local app:

- **macOS:** Install Google Chrome in Applications.
- **Linux:** Install local, rootful Docker, then select **Set up browser** when prompted.

Docker access gives extensive host privileges. Grant it only to trusted users.

Remote viewing requires a browser with WebCodecs VP8 support, such as Chrome.

## Browser data and limits

Browser apps on the same host share login state. Anyone with browser access, including agents, can use those signed-in accounts.

Treeport uses its own browser data, not your personal browser profile.

Remote browser apps do not support audio, downloads, or file uploads.
