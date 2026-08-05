import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const normalize = (value) => value.split(path.sep).join('/')
const sorted = (values) => [...new Set(values)].sort()

async function sourceFiles(root) {
  const directory = path.join(root, 'src', 'connectors')
  const entries = await readdir(directory, { withFileTypes: true })
  return entries.filter((item) => item.isFile() && /^feishu(?:-.+)?\.ts$/.test(item.name)).map((item) => path.join(directory, item.name)).sort()
}

function stringArray(node) {
  if (!ts.isArrayLiteralExpression(node)) return null
  const values = []
  for (const element of node.elements) {
    if (!ts.isStringLiteralLike(element)) return null
    values.push(element.text)
  }
  return values
}

function isExported(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function hasRemoteWriteTag(node, source) {
  return ts.getJSDocTags(node).some((tag) => tag.tagName.text === 'feishu-remote-write')
    || source.text.slice(Math.max(0, node.getFullStart() - 80), node.getStart(source)).includes('@feishu-remote-write')
}

export async function checkFeishuConnectorContracts(root = process.cwd()) {
  const manifest = JSON.parse(await readFile(path.join(root, 'tools', 'feishu-connector-contract.json'), 'utf8'))
  if (manifest.schema_version !== 1) throw new Error('unsupported Feishu connector contract schema')
  const actions = [], requestMappedActions = [], controllerMappedActions = [], adapters = [], entrypoints = []
  for (const file of await sourceFiles(root)) {
    const relative = normalize(path.relative(root, file)), source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'actionSchema'
        && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.arguments[0]) {
        const values = stringArray(node.initializer.arguments[0])
        if (values) actions.push(...values)
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ['actionsByType', 'allowed'].includes(node.name.text)
        && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        const destination = node.name.text === 'actionsByType' ? requestMappedActions : controllerMappedActions
        for (const property of node.initializer.properties) {
          if (ts.isPropertyAssignment(property)) {
            const values = stringArray(property.initializer)
            if (values) destination.push(...values)
          }
        }
      }
      if (ts.isClassDeclaration(node) && node.heritageClauses?.some((clause) => clause.types.some((type) => type.getText(source).includes('ConfirmationControllerAdapter')))) adapters.push(relative)
      if (relative.endsWith('feishu-callback.ts') && ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
        const body = node.body?.getText(source) ?? ''
        if (/\b(?:acceptAction|processFeishuAction|executeConfirmationRequest)\s*\(|\bcontroller\.execute\s*\(/.test(body)) {
          if (!hasRemoteWriteTag(node, source)) throw new Error(`${relative}#${node.name.text} is an unregistered remote write entrypoint without @feishu-remote-write`)
          entrypoints.push(`${relative}#${node.name.text}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  const cli = await readFile(path.join(root, 'src', 'cli.ts'), 'utf8')
  const localChoice = cli.match(/feishu\.command\('confirm-local'[\s\S]*?\.choices\(\[([\s\S]*?)\]\)/)?.[1]
  if (!localChoice) throw new Error('confirm-local action choices are not statically discoverable')
  const cliActions = [...localChoice.matchAll(/['"]([a-z_]+)['"]/g)].map((match) => match[1])
  const expectedActions = sorted(manifest.action_ids)
  for (const [label, actual] of [
    ['connector action schemas', sorted(actions)],
    ['request-type action mapping', sorted(requestMappedActions)],
    ['Controller action mapping', sorted(controllerMappedActions)],
    ['confirm-local choices', sorted(cliActions)],
  ]) {
    if (JSON.stringify(actual) !== JSON.stringify(expectedActions)) throw new Error(`${label} differ from the registered action contract: ${JSON.stringify(actual)}`)
  }
  if (JSON.stringify(sorted(adapters)) !== JSON.stringify(sorted(manifest.controller_adapters))) throw new Error('Controller Adapter discovery differs from the registered contract')
  if (JSON.stringify(sorted(entrypoints)) !== JSON.stringify(sorted(manifest.remote_write_entrypoints))) throw new Error('remote write entrypoint discovery differs from the registered contract')
  return { actions: expectedActions.length, adapters: adapters.length, entrypoints: entrypoints.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkFeishuConnectorContracts(process.argv[2] ? path.resolve(process.argv[2]) : process.cwd())
    console.log(`PASS: 飞书持续契约 Gate 已核对 ${result.actions} 个动作、${result.adapters} 个 Controller Adapter、${result.entrypoints} 个远程写入口。`)
  } catch (error) {
    console.error(`FAIL: ${error.message}`)
    process.exitCode = 1
  }
}
