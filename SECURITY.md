# Security

Bluestone PIM Lens is an unofficial prototype. It acts in Bluestone PIM with the session of the person using it, so problems that could let a web page read PIM data, or change something in the PIM without the user asking, are taken seriously.

## Reporting a problem

Please do not open a public issue for a security problem. Use **Report a vulnerability** on this repository's Security tab (GitHub's private reporting), and say what you did, what happened and what you expected.

Problems in Bluestone PIM itself are not for this repository: report those to Bluestone PIM.

## What the extension is allowed to do

- Call two addresses with the signed-in user's session: `app.test.bluestonepim.com` and `demo-ui.test.bluestonepim.com` (the Test environment).
- Read the page in the current tab, after the user clicks the extension's button or its right-click menu item.
- Fetch pictures from a shop's image host, without cookies, after the user allows that host in Chrome's own permission question.
- Keep its settings and the remembered product per page in the browser's extension storage.

It holds no credentials, loads no code from the network and contacts no other server. The README's "Privacy and security" section says how a page is kept from reading or steering it.
