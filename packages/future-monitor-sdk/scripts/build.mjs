/**
 * 构建脚本（纯 TypeScript API，无外部依赖、无子进程）
 *
 * 产出三种产物：
 * - dist/esm/*.js    ESM（moduleResolution: bundler，供 Next/Vite/webpack 消费）
 * - dist/cjs/*.js    CJS（附 package.json 标记 type: commonjs，供 require 消费）
 * - dist/types/*.d.ts 类型声明
 *
 * 说明：SDK 核心零运行时依赖，无需 bundler 打包；
 * 调试面板（src/debug）依赖宿主设计系统，不随 npm 包发布。
 */
import ts from 'typescript'
import { writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const configPath = path.join(root, 'tsconfig.build.json')

function build(overrides, outDir) {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
  if (configFile.error) {
    console.error(ts.formatDiagnostic(configFile.error, formatter))
    process.exit(1)
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    root,
    { ...overrides, outDir: path.join(root, outDir) }
  )

  const program = ts.createProgram(parsed.fileNames, parsed.options)
  const result = program.emit()
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(result.diagnostics)

  if (diagnostics.length > 0) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatter))
    process.exit(1)
  }
  console.log(`✔ ${outDir}`)
}

const formatter = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: () => root,
  getNewLine: () => '\n',
}

/**
 * 给产物里的相对导入补上 .js 扩展名。
 *
 * 为什么不在源码里直接写 .js？
 * 因为本仓库通过 `transpilePackages: ['future-monitor-sdk']` 让 Next.js 直接编译
 * SDK 源码，而 webpack 不会把 './core/monitor.js' 映射回 'monitor.ts'，
 * 源码里带扩展名会直接导致 `next build` 失败（Module not found）。
 *
 * 而原生 Node ESM 又要求显式扩展名，省略会报 ERR_MODULE_NOT_FOUND。
 * 两边诉求冲突，所以在「源码」与「产物」上分别满足：
 *   源码无扩展名（给 bundler 用） → 产物补扩展名（给 Node 用）。
 */
function addJsExtensions(dir) {
  let count = 0
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) {
        walk(p)
        continue
      }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts')) continue
      const src = readFileSync(p, 'utf8')
      const out = src.replace(
        /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]*?)\2/g,
        (m, pre, q, spec) => {
          if (/\.(js|mjs|cjs|json|css)$/.test(spec)) return m
          count++
          return `${pre}${q}${spec}.js${q}`
        }
      )
      if (out !== src) writeFileSync(p, out, 'utf8')
    }
  }
  walk(dir)
  console.log(`  ↳ ${path.relative(root, dir)} 补全 ${count} 处相对导入扩展名`)
}

// 清理旧产物
rmSync(path.join(root, 'dist'), { recursive: true, force: true })

// ESM 产物（bundler 解析，无扩展名 import）
build(
  {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: false,
    emitDeclarationOnly: false,
  },
  'dist/esm'
)
// 原生 Node 的 ESM 加载器要求显式扩展名，产物补齐
addJsExtensions(path.join(root, 'dist/esm'))

// CJS 产物（node require 直接可用；CJS 解析允许省略扩展名，无需处理）
build(
  {
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    declaration: false,
    emitDeclarationOnly: false,
  },
  'dist/cjs'
)

// 类型声明
build(
  {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    emitDeclarationOnly: true,
  },
  'dist/types'
)
// .d.ts 同样补扩展名，兼容 moduleResolution: node16/nodenext 的使用方
addJsExtensions(path.join(root, 'dist/types'))

// CJS 目录标记（根 package.json 是 type: module，.js 默认按 ESM 解析）
writeFileSync(
  path.join(root, 'dist/cjs/package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2)
)

console.log('✔ build complete')
