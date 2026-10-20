import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Repository root: the test lives in <root>/test, so go one level up.
const root = dirname(dirname(fileURLToPath(import.meta.url)))

interface PackageManifest {
  name: string
  version: string
  icon?: string
  exports: Record<string, string | Record<string, string>>
  files: string[]
  dsh?: { bundle?: { patch?: string } }
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageManifest
const patchPath = 'cordis.patch.yml'
const patchText = readFileSync(join(root, patchPath), 'utf8')
const sourceText = readFileSync(join(root, 'src', 'index.ts'), 'utf8')

function unquote(value: string): string {
  const trimmed = value.trim()
  const first = trimmed[0]
  if (trimmed.length >= 2 && (first === "'" || first === '"') && trimmed.at(-1) === first) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Extract a YAML scalar per line, accepting both `key: value` and `- key: value`. */
function yamlScalars(text: string, key: string): string[] {
  const pattern = new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*([^\\n]+?)\\s*$`, 'gm')
  return [...text.matchAll(pattern)].map((match) => unquote(match[1].replace(/\s+#.*$/, '')))
}

/** Extract a YAML sequence under `key:`, either flow (`[a, b]`) or block (`- a`). */
function yamlList(text: string, key: string): string[] {
  const inline = new RegExp(`^\\s*${key}:\\s*\\[([^\\]]*)\\]\\s*$`, 'm').exec(text)
  if (inline) {
    return inline[1].split(',').map(unquote).filter((item) => item.length > 0)
  }
  const block = new RegExp(`^\\s*${key}:\\s*\\n((?:[ \\t]*-[ \\t]*[^\\n]+\\n?)+)`, 'm').exec(text)
  assert.ok(block, `${key}: must be a YAML sequence in ${patchPath}`)
  return block[1]
    .split('\n')
    .map((line) => unquote(line.replace(/^[ \t]*-[ \t]*/, '')))
    .filter((item) => item.length > 0)
}

/** Extract the hard dependencies declared by the plugin entry point. */
function sourceInject(text: string): string[] {
  const match = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/.exec(text)
  assert.ok(match, 'src/index.ts must declare `export const inject = [...]`')
  return match[1].split(',').map(unquote).filter((item) => item.length > 0)
}

const canonical = (values: string[]): string[] => [...new Set(values)].sort()

test('package.json declares the bundle patch and the patch file exists', () => {
  const declared = manifest.dsh?.bundle?.patch
  assert.equal(declared, `./${patchPath}`)
  if (typeof declared !== 'string') assert.fail('dsh.bundle.patch must be a string')
  assert.ok(existsSync(join(root, declared)), `${declared} must exist`)
})

test('the patch has one unique id and names this package', () => {
  const ids = yamlScalars(patchText, 'id')
  assert.equal(ids.length, 1, `expected exactly one id, got ${JSON.stringify(ids)}`)
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${JSON.stringify(ids)}`)
  assert.equal(ids[0], 'local-dream')
  assert.deepEqual(yamlScalars(patchText, 'name'), [manifest.name])
})

test('patch inject equals the hard dependencies declared in src/index.ts', () => {
  const patchInject = yamlList(patchText, 'inject')
  const declaredInject = sourceInject(sourceText)
  assert.ok(patchInject.length > 0, 'the patch must declare at least one injected service')
  assert.deepEqual(canonical(patchInject), canonical(declaredInject))
})

test('locale files carry non-empty titles and descriptions', () => {
  for (const locale of ['en', 'zh']) {
    const file = join(root, 'locale', `${locale}.json`)
    assert.ok(existsSync(file), `locale/${locale}.json must exist`)
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      meta?: { title?: unknown; description?: unknown }
    }
    const title = data.meta?.title
    const description = data.meta?.description
    assert.ok(typeof title === 'string' && title.trim().length > 0, `${locale}: meta.title must be non-empty`)
    assert.ok(
      typeof description === 'string' && description.trim().length > 0,
      `${locale}: meta.description must be non-empty`,
    )
  }
})

test('icon.svg exists, is within the size cap and is a plain standalone SVG', () => {
  const iconPath = join(root, 'icon.svg')
  assert.ok(existsSync(iconPath), 'icon.svg must exist')
  const size = statSync(iconPath).size
  assert.ok(size <= 256 * 1024, `icon.svg is ${size} bytes (limit 256 KiB)`)
  const icon = readFileSync(iconPath, 'utf8')
  assert.match(icon, /<svg[\s>]/)
  assert.match(icon, /viewBox="0 0 32 32"/)
  assert.doesNotMatch(icon, /<script/i)
  assert.doesNotMatch(icon, /<text/i)
  assert.doesNotMatch(icon, /(?:href|src)\s*=/i)
  // The Host ships icons as a data URI (dsh-app-boot), so `currentColor` resolves to
  // the initial colour instead of following the page theme: pin fixed colours.
  assert.doesNotMatch(icon, /currentColor/i, 'the icon must use fixed colours, not currentColor')
  assert.doesNotMatch(icon, /url\(\s*['"]?(?:https?:|\/\/|data:)/i, 'the icon must not load external resources')
})

test('package metadata exposes the locale, the icon and the bundle files', () => {
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(manifest.exports['./package.json'], './package.json')
  for (const entry of ['cordis.patch.yml', 'locale', 'icon.svg']) {
    assert.ok(manifest.files.includes(entry), `files must include ${entry}`)
  }
  assert.ok(manifest.files.includes('vendor'), 'files must keep the vendored platform-tools')
})

test('the manifest declares the top-level icon field the Host reads first', () => {
  // dsh-app-boot resolves `package.json#icon` before falling back to `<pkg>/icon`.
  assert.equal(manifest.icon, 'icon.svg', 'package.json must declare icon: "icon.svg"')
  assert.ok(existsSync(join(root, 'icon.svg')), 'the icon field target must exist')
})
