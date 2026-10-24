/**
 * Starters: the files a new tree can begin with. A starter is a
 * single change, so the tree's history begins with it.
 */

export const STARTERS = Object.freeze({
  html: {
    describe: 'A page, a stylesheet and a module script: no packages, nothing to sign in to.',
    files: {
      'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Hello</title>
    <link rel="stylesheet" href="style.css">
    <!-- Publishing adds the tree's import map, imports.json, to each page: pin packages, then import them by name. -->
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
