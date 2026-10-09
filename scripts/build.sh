#!/bin/bash
# Build lib/ (Host entry + declarations, and the Web client bundle).
#
# Review R6 6.2: there is one build. When the lockfile toolchain is installed
# (`npm ci`), this script runs exactly what CI runs (build:host + build:client)
# so the artifact a release ships is the artifact CI tested. Only a machine
# without node_modules (the installed-DSH operator setup in HANDOFF §5) takes
# the fallback below, which links the host's runtime packages and bundles the
# client with esbuild from the SAME bundle spec (scripts/client-bundle.mjs).
# Set DSH_BUILD_FORCE_INSTALLED=1 to exercise the fallback anyway (CI does).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -z "${DSH_BUILD_FORCE_INSTALLED:-}" ] && [ -f node_modules/typescript/bin/tsc ] && [ -f node_modules/tsdown/package.json ]; then
  rm -rf lib
  npm run -s build:host
  npm run -s build:client
  echo "build: complete (lockfile toolchain, same as CI)"
  exit 0
fi

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
  # Never replace a package npm installed: this used to rm -rf it and leave a
  # symlink to a host path, silently swapping the lockfile's version (or
  # breaking the checkout when the host path does not exist).
  if [ -e "node_modules/$name" ] && [ ! -L "node_modules/$name" ]; then
    return 0
  fi
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
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const esbuildPath = process.env.DSH_ESBUILD_PATH
if (!esbuildPath) throw new Error('build: resolved esbuild path is missing')
const { build } = await import(pathToFileURL(esbuildPath).href)
const { esbuildClientOptions } = await import(pathToFileURL(path.resolve('scripts/client-bundle.mjs')).href)
await build(esbuildClientOptions('lib/client.js'))
NODE

echo "build: complete (installed-runtime fallback)"
