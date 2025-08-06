import type { Plugin, HookHandler } from "vite";
import { createHash } from "crypto";
import path from "path";

const VITE_INTERNAL_ANALYSIS_PLUGIN = 'vite:build-import-analysis'
const EXTERNAL_SCRIPT_RE = /<script([^<>]*)['"]*src['"]*=['"]*([^ '"]+)['"]*([^<>]*)><\/script>/g
const EXTERNAL_CSS_RE = /<link([^<>]*)['"]*rel['"]*=['"]*stylesheet['"]*[^<>]+['"]*href['"]*=['"]([^^ '"]+)['"]([^<>]*)>/g
const EXTERNAL_MODULE_RE = /<link([^<>]*)['"]*rel['"]*=['"]*modulepreload['"]*[^<>]+['"]*href['"]*=['"]([^^ '"]+)['"]([^<>]*)>/g

export type GenerateBundle = HookHandler<Plugin["generateBundle"]>

export interface SriOptions {
	ignoreMissingAssets?: boolean
	crossorigin?: string | boolean
	customCrossorigin?: (url: string) => string | boolean | null
	excludeExternal?: boolean
	excludePatterns?: (string | RegExp)[]
	includePatterns?: (string | RegExp)[]
}

function hijackGenerateBundle(plugin: Plugin, afterHook: GenerateBundle) {
	const hook = plugin.generateBundle
	if (typeof hook === "object" && hook.handler) {
		const fn = hook.handler
		hook.handler = async function (this, ...args: any) {
			await fn.apply(this, args)
			await afterHook?.apply(this, args)
		}
	}
	if (typeof hook === "function") {
		plugin.generateBundle = async function (this, ...args: any) {
			await hook.apply(this, args)
			await afterHook?.apply(this, args)
		}
	}
}

function isExternalUrl(url: string): boolean {
	return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("//")
}

function matchesPatterns(url: string, patterns: (string | RegExp)[]): boolean {
	return patterns.some(pattern => {
		if (typeof pattern === "string") {
			return url.includes(pattern)
		}
		return pattern.test(url)
	})
}

function shouldProcessUrl(url: string, options: SriOptions): boolean {
	if (options.excludeExternal && isExternalUrl(url)) {
		return false
	}

	if (options.excludePatterns && matchesPatterns(url, options.excludePatterns)) {
		return false
	}

	if (options.includePatterns && !matchesPatterns(url, options.includePatterns)) {
		return false
	}

	return true
}

function getCrossoriginAttribute(url: string, options: SriOptions): string {
	if (options.customCrossorigin) {
		const result = options.customCrossorigin(url)
		if (result === null || result === false) return ""
		if (result === true) return ' crossorigin="anonymous"'
		if (typeof result === "string") return ` crossorigin="${result}"`
	}

	if (options.crossorigin === false || options.crossorigin === null) return ""
	if (options.crossorigin === true) return ' crossorigin="anonymous"'
	if (typeof options.crossorigin === "string") return ` crossorigin="${options.crossorigin}"`

	return isExternalUrl(url) ? ' crossorigin="anonymous"' : ""
}

export function sri(options?: SriOptions): Plugin {
	const {
		ignoreMissingAssets: ignoreMissingAsset = false,
		crossorigin = true,
		customCrossorigin,
		excludeExternal = false,
		excludePatterns = [],
		includePatterns
	} = options || {}

	return {
		name: "vite-plugin-sri3",
		enforce: "post",
		apply: "build",
		configResolved(config) {
			const generateBundle: Plugin["generateBundle"] = async function (_, bundle) {
				const getBundleKey = (htmlPath: string, url: string) => {
					if (config.base === "./" || config.base === "") {
						return path.posix.resolve(htmlPath, url)
					}
					return url.replace(config.base, "")
				}

				const calculateIntegrity = async (htmlPath: string, url: string) => {
					let source: string | Uint8Array
					const resourcePath = url
					if (resourcePath.startsWith("http")) {
						source = new Uint8Array(await (await fetch(resourcePath)).arrayBuffer())
					}
					else {
						const bundleItem = bundle[getBundleKey(htmlPath, url)]
						if (!bundleItem) {
							if (ignoreMissingAsset) return null
							throw new Error(`Asset ${url} not found in bundle`)
						}
						source = bundleItem.type === "chunk" ? bundleItem.code : bundleItem.source
					}
					return `sha384-${createHash("sha384").update(source).digest().toString("base64")}`
				}

				const transformHTML = async function (regex: RegExp, endOffset: number, htmlPath: string, html: string) {
					let match: RegExpExecArray | null
					const changes = []
					let offset = 0
					regex.lastIndex = 0
					while ((match = regex.exec(html))) {
						const [fullMatch, beforeSrc, url, afterSrc] = match
						
						if (!shouldProcessUrl(url, { excludeExternal, excludePatterns, includePatterns, customCrossorigin })) {
							continue
						}

						const end = regex.lastIndex
						const integrity = await calculateIntegrity(htmlPath, url)
						if (!integrity) continue

						const crossoriginAttr = getCrossoriginAttribute(url, { crossorigin, customCrossorigin })
						const insertPos = end - endOffset
						changes.push({ integrity, crossoriginAttr, insertPos })
					}
					
					for (const change of changes) {
						const insertText = ` integrity="${change.integrity}"${change.crossoriginAttr}`
						html = html.slice(0, change.insertPos + offset) + insertText + html.slice(change.insertPos + offset)
						offset += insertText.length
					}
					return html
				}

				for (const name in bundle) {
					const chunk = bundle[name]

					if (chunk.type === "asset" && (chunk.fileName.endsWith(".html") || chunk.fileName.endsWith(".htm"))) {
						let html = chunk.source.toString()

						html = await transformHTML(EXTERNAL_SCRIPT_RE, 10, name, html)
						html = await transformHTML(EXTERNAL_CSS_RE, 1, name, html)
						html = await transformHTML(EXTERNAL_MODULE_RE, 1, name, html)

						chunk.source = html
					}
				}
			}

			const plugin = config.plugins.find(p => p.name === VITE_INTERNAL_ANALYSIS_PLUGIN)
			if (!plugin) {
				throw new Error("vite-plugin-sri3 can't be work in versions lower than vite2.0.0")
			}

			hijackGenerateBundle(plugin, generateBundle)
		}
	}
}