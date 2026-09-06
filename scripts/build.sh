#!/bin/bash
# Build the Host entry with tsc and the Web entry with esbuild.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# A source checkout remains the preferred build source. The installed DSH
# distribution has no packages/ tree, so use the local runtime dependency tree
# and an available TypeScript/esbuild toolchain as a deterministic fallback.
CHECKOUT="${DSH_CHECKOUT:-}"
RUNTIME_DEPS="${DSH_RUNTIME_DEPS:-D:/tools/dsh-plugins/dsh-plugin-playwright-0.2.0}"
TSC_ROOT="${DSH_TYPESCRIPT_ROOT:-D:/tools/dsh-plugins/dsh-thread-0.1.3}"
ESBUILD_ROOT="${DSH_ESBUILD_ROOT:-D:/tools/dsh-plugins/dsh-thread-0.1.3}"
DSH_INSTALL_ROOT="${DSH_INSTALL_ROOT:-C:/Users/Admin/AppData/Local/hermes/node/node_modules/@deepseek-ai/dsh}"

if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi

link_dep() {
  local name="$1"
  local target="$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "const fs=require('fs');const path=require('path');const link=path.resolve(process.argv[1]);const target=path.resolve(process.argv[2]);fs.rmSync(link,{recursive:true,force:true});fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(target,link,process.platform==='win32'?'junction':'dir')" "node_modules/$name" "$target"
}

rm -rf lib
mkdir -p node_modules/@deepseek-ai node_modules/@types

if [ -n "$CHECKOUT" ] && [ -d "$CHECKOUT/packages" ]; then
  TSC="$CHECKOUT/node_modules/.bin/tsc"
  link_dep @deepseek-ai/cordis "$CHECKOUT/vendor/cordis"
  link_dep @deepseek-ai/dsh-llm "$CHECKOUT/packages/llm/llm"
  link_dep @deepseek-ai/dsh-settings "$CHECKOUT/packages/settings/settings"
  link_dep schemastery "$CHECKOUT/vendor/schemastery"
  link_dep @types/node "$CHECKOUT/node_modules/@types/node"
else
  TSC="$TSC_ROOT/node_modules/typescript/bin/tsc"
  link_dep @deepseek-ai/cordis "$RUNTIME_DEPS/node_modules/@deepseek-ai/cordis"
  link_dep @deepseek-ai/dsh-llm "$RUNTIME_DEPS/node_modules/@deepseek-ai/dsh-llm"
  link_dep @deepseek-ai/dsh-settings "$DSH_INSTALL_ROOT/node_modules/@deepseek-ai/dsh-settings"
  link_dep schemastery "$RUNTIME_DEPS/node_modules/@deepseek-ai/schemastery"
  link_dep @types/node "$TSC_ROOT/node_modules/@types/node"
fi

if [ ! -f "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi
node "$TSC" -p tsconfig.json

ESBUILD="${DSH_ESBUILD_PATH:-$ESBUILD_ROOT/node_modules/esbuild/lib/main.js}"
if [ ! -f "$ESBUILD" ]; then
  echo "build: esbuild not found at $ESBUILD" >&2
  exit 1
fi
export DSH_ESBUILD_PATH="$ESBUILD"
node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url'
const esbuildPath = process.env.DSH_ESBUILD_PATH
if (!esbuildPath) throw new Error('build: resolved esbuild path is missing')
const { build } = await import(pathToFileURL(esbuildPath).href)
const pluginId = '@dsh-external/dsh-verifier-autopilot'
const quote = String.fromCharCode(34)
await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  outfile: 'lib/client.js',
  sourcemap: true,
  banner: { js: 'var module = { exports: {} }; var exports = module.exports; window.__ModuleLoader__.load({ id: ' + quote + pluginId + quote + ', factory: (require) => {' },
  footer: { js: 'return module.exports; } });' },
})
NODE

echo "build: complete"
