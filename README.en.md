# CGuard

[한국어](README.md) | **English**

CGuard finds errors in C source code and shows their causes and how to fix them **at the relevant location in the file and in the VS Code Problems panel**. It analyzes source code statically in the current VS Code process.

## Usage

1. Download the VSIX file from the [GitHub release](https://github.com/leekmny/CGuard/releases/tag/v0.1.1). In VS Code desktop (1.95 or later), run **Extensions: Install from VSIX...**, then open a local `.c` file.
2. CGuard checks the file when you open or save it. To check the current editor contents immediately, run **CGuard: Check Current C File** from the Command Palette.
3. Read the message on the flagged line, fix the code, and check the diagnostics again.

CGuard uses Tree-sitter's C grammar via WebAssembly and reports the results of its TypeScript analysis rules as VS Code diagnostics. It checks syntax and errors it can determine with certainty within a single file. It supports source files up to 512 KiB.

- Highlights the locations of C syntax errors identified by the parser.
- Checks array bounds when the size and index are integer literals. For a compatible redeclaration that omits the size, it uses the size from the earlier declaration of the same array.
- Checks variable-length array (VLA) size expressions and some `sizeof` expressions whose result requires evaluating the operand. It uses integer literal conditions and simple `_Generic` selections to determine which operands are skipped. When it cannot determine whether an access will be evaluated, it reports the index error that would occur if it were evaluated.
- Checks for an immediate return of a simple local scalar declared without an initializer in the same block.

Preprocessor conditions, macro expansion, dynamic indices, pointer aliasing, and cross-file data flow are currently outside the scope of analysis. CGuard does not infer dynamic array sizes or full C types, so it may skip `_Generic` branches that require type information and VLA `sizeof` expressions involving compound types.

## Development and standalone testing

```powershell
npm ci --ignore-scripts
npm test
npm run package -- --out cguard.vsix
node tests/vscode/run.cjs cguard.vsix
```

The standalone test launches VS Code desktop with fresh user data and extensions directories and installs the package. It verifies the diagnostic lines and messages in the error examples, the results for valid files, the removal of diagnostics after fixing errors, and the diagnostic for an array redeclaration with an omitted size. Set `CGUARD_VSCODE_PATH` to specify the path to an installed VS Code executable. Set `CGUARD_QA_OUTPUT` to choose where to save the JSON results.
