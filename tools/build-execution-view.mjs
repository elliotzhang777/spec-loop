import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

await build({
  entryPoints: ['assets/execution-view/controls.jsx'],
  bundle: true, minify: true, format: 'iife', target: 'es2022',
  outfile: 'assets/execution-view/controls.js',
  plugins: [{
    name: 'execution-view-style-nonce',
    setup(builder) {
      // rc-util's scrollbar/portal helpers omit ConfigProvider.csp. Supply
      // the same instance nonce at their shared CSS insertion boundary,
      // before insertion; retain CSP and leave node_modules untouched.
      builder.onLoad({ filter: /[/\\]@rc-component[/\\]util[/\\]es[/\\]Dom[/\\]dynamicCSS\.js$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8')
        const insertion = '  const {\n    csp,\n    prepend,'
        if (source.split(insertion).length !== 2) throw new Error('rc-util CSS insertion changed; review its nonce integration')
        return { contents: source.replace(insertion, `  option = {...option, csp: {nonce: document.querySelector('meta[name="csp-nonce"]')?.content, ...option.csp}};\n${insertion}`), loader: 'js' }
      })
    },
  }],
})
