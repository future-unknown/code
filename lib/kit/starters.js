/**
 * Starters: the files a new tree can begin with. A starter is a
 * single change, so the tree's history begins with it.
 */

export const STARTERS = Object.freeze({
  html: {
    describe: 'A page, a stylesheet, a module script and an icon: no packages, nothing to sign in to.',
    files: {
      'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hello</title>
    <!-- The site's icon: Known shows it beside the site's name. Make it the site's own. -->
    <link rel="icon" href="favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="style.css">
    <!-- Publishing adds the tree's import map, imports.json, to each page: pin packages, then import them by name. -->
    <!-- It also adds the site's settings for signing in with Known: JSON.parse(document.getElementById('known-site').textContent). -->
    <script type="module" src="app.js"></script>
  </head>
  <body>
    <main>
      <h1>Hello, world</h1>
      <p id="when"></p>
    </main>
  </body>
</html>
`,
      'favicon.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#2a2a22"/>
  <circle cx="16" cy="16" r="6" fill="#f7f4e9"/>
</svg>
`,
      'style.css': `body {
  font-family: system-ui, sans-serif;
  margin: 0;
  padding: 2rem 1rem;
}

main {
  max-width: 40rem;
  margin: 0 auto;
}
`,
      'app.js': `document.getElementById('when').textContent = \`Loaded \${new Date().toLocaleString()}\`
`
    }
  }
})
