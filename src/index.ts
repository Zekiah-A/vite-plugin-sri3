import type { Plugin, HookHandler } from 'vite'
import { createHash } from 'crypto'

const VITE_INTERNAL_ANALYSIS_PLUGIN = 'vite:build-import-analysis'
const EXTERNAL_SCRIPT_RE = /<script[^<>]*['"]*src['"]*=['"]*([^ '"]+)['"]*[^<>]*><\/script>/g
const EXTERNAL_CSS_RE = /<link[^<>]*['"]*rel['"]*=['"]*stylesheet['"]*[^<>]+['"]*href['"]*=['"]([^^ '"]+)['"][^<>]*>/g

export type GenerateBundle = HookHandler<Plugin['generateBundle']>

function hijackGenerateBundle (plugin: Plugin, afterHook: GenerateBundle) {
  const hook = plugin.generateBundle
  if (typeof hook === 'object' && hook.handler) {
    const fn = hook.handler
        hook.handler = async function (this, ...args: any) {
        await fn.apply(this, args)
        await afterHook?.apply(this, args)
    }
  }
  if (typeof hook === 'function') {
        plugin.generateBundle = async function (this, ...args: any) {
        await hook.apply(this, args)
        await afterHook?.apply(this, args)
    }
  }
}

export function sri (options?: { ignoreMissingAsset: boolean }): Plugin {
  const { ignoreMissingAsset = false } = options || {}

  return {
    name: 'vite-plugin-sri2',
    enforce: 'post',
    apply: 'build',
    configResolved (config) {
      const generateBundle: Plugin['generateBundle'] = async function (_, bundle) {
        const getBundleKey = (url: string) => {
          if (config.base === './' || config.base === '') {
            return url
          }
          return url.replace(config.base, '')
        }

        const calculateIntegrity = async (url: string) => {
          let source: string | Uint8Array
          const resourcePath = url
          if (resourcePath.startsWith('http')) {
            source = Buffer.from(await (await fetch(resourcePath)).arrayBuffer())
          } else {
            const bundleItem = bundle[getBundleKey(url)]
            if (!bundleItem) {
              if (ignoreMissingAsset) return null
              throw new Error(`Asset ${url} not found in bundle`)
            }
            source = bundleItem.type === 'chunk' ? bundleItem.code : bundleItem.source
          }
          return `sha384-${createHash('sha384').update(source).digest().toString('base64')}`
        }

        const transformHTML = async function (regex: RegExp, endOffset: number, html: string) {
          let match: RegExpExecArray | null
          const changes = []
          let offset = 0
          while ((match = regex.exec(html))) {
            const [, url] = match
            const end = regex.lastIndex

            const integrity = await calculateIntegrity(url)
            if (!integrity) continue

            const insertPos = end - endOffset
            changes.push({ integrity, insertPos })
          }
          for (const change of changes) {
            const insertText = ` integrity="${change.integrity}"`
            html = html.slice(0, change.insertPos + offset) + insertText + html.slice(change.insertPos + offset)
            offset += insertText.length
          }
          return html
        }

        for (const name in bundle) {
          const chunk = bundle[name]

          if (
            chunk.type === 'asset' &&
            (chunk.fileName.endsWith('.html') || chunk.fileName.endsWith('.htm'))
          ) {
            let html = chunk.source.toString()

            html = await transformHTML(EXTERNAL_SCRIPT_RE, 10, html)
            html = await transformHTML(EXTERNAL_CSS_RE, 1, html)

            chunk.source = html
          }
        }
      }

      const plugin = config.plugins.find(p => p.name === VITE_INTERNAL_ANALYSIS_PLUGIN)
      if (!plugin) throw new Error('vite-plugin-sri2 can\'t be work in versions lower than vite2.0.0')

      hijackGenerateBundle(plugin, generateBundle)
    }
  }
}
