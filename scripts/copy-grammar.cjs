const { copyFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const grammar = resolve(root, 'node_modules', 'tree-sitter-c');
const output = resolve(root, 'out');

mkdirSync(output, { recursive: true });
copyFileSync(resolve(grammar, 'tree-sitter-c.wasm'), resolve(output, 'tree-sitter-c.wasm'));
copyFileSync(resolve(grammar, 'LICENSE'), resolve(output, 'tree-sitter-c-LICENSE.txt'));
