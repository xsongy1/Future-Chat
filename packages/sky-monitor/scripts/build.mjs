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
import { writeFileSync, rmSync } from 'node:fs'
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

// CJS 产物（node require 直接可用）
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

// CJS 目录标记（根 package.json 是 type: module，.js 默认按 ESM 解析）
writeFileSync(
  path.join(root, 'dist/cjs/package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2)
)

console.log('✔ build complete')
