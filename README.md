# Spck CLI

Edit the code on your computer from your phone or tablet. Spck CLI connects a local project to the [Spck Editor](https://spck.io) mobile app, giving it access to your files, Git, terminal, language servers, browser preview and local AI agents.

![Remote Project features in Spck Editor](https://docs.spck.io/assets/gifs/remote-cli-preview.gif)

## Quick Start

You need [Node.js](https://nodejs.org) 22.22.2+ or 24.15+, and the Spck Editor app for [Android](https://play.google.com/store/apps/details?id=io.spck) or [iOS](https://apps.apple.com/us/app/spck-editor/id1507309511).

1. In your project directory, run:

   ```bash
   npx spck
   ```

2. Sign in and answer the setup questions. This only happens the first time. The CLI then shows a QR code.

3. In Spck Editor, go to **Projects → New Project → Link Remote Server**, tap the QR code icon, and scan the code.

Your project is now open in the app. To enter the connection details by hand instead, use the Client ID, Secret and relay server shown in the terminal.

After an editor connects successfully, future launches open the dashboard directly. Press `c` in the dashboard to show the QR code again, or `l` to view logs, including startup details.

To skip `npx` next time, install the CLI with `npm install -g spck` and run `spck`.

A free Spck Editor account includes 30 minutes a day of remote use. A Premium subscription removes the limit.

The Claude and Codex ACP adapters are bundled with Spck CLI. Sign in with the
agent's own login on the CLI host; no global ACP adapter installation is needed.
Gemini CLI is detected separately on PATH.

## Documentation

- [Getting started](https://docs.spck.io/en/cli-start)
- [Commands and advanced usage](https://docs.spck.io/en/cli-advanced)
- [Configuration and security](https://docs.spck.io/en/cli-config)
- [Relay servers, Fast Lane and troubleshooting](https://docs.spck.io/en/cli)
- [Local AI agents (Claude Code, Codex, Gemini CLI)](https://docs.spck.io/en/cli-acp)
- [Language server](https://docs.spck.io/en/cli-language-server)
- [File transfer](https://docs.spck.io/en/cli-file-transfer)
- [Changelog](https://docs.spck.io/en/changelog-cli)

## License

MIT
