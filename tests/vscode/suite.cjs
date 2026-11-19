const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const vscode = require('vscode');

const command = 'cguard.checkCurrentFile';

function diagnosticsFor(document) {
    return vscode.languages.getDiagnostics(document.uri).filter(({ source }) => source === 'CGuard');
}

async function waitForDiagnostics(document, count) {
    const deadline = Date.now() + 10_000;
    let diagnostics = diagnosticsFor(document);
    while (diagnostics.length !== count && Date.now() < deadline) {
        await delay(25);
        diagnostics = diagnosticsFor(document);
    }

    assert.equal(diagnostics.length, count,
        `Unexpected CGuard diagnostic count for ${path.basename(document.fileName)}`);
    return diagnostics;
}

function assertOutOfBounds(document, diagnostic) {
    const { code, message, range, severity, source } = diagnostic;
    assert.equal(code, 'array-index-out-of-bounds');
    assert.equal(severity, vscode.DiagnosticSeverity.Error);
    assert(range.isEqual(new vscode.Range(2, 18, 2, 19)));
    assert.equal(document.getText(range), '3');
    return {
        source, code, message, severity: vscode.DiagnosticSeverity[severity],
        file: path.basename(document.fileName),
        range: {
            start: { line: range.start.line, character: range.start.character },
            end: { line: range.end.line, character: range.end.character },
        },
    };
}

async function replaceIndex(editor, index) {
    const offset = new vscode.Range(2, 18, 2, 19);
    assert(await editor.edit((edit) => edit.replace(offset, index)));
    assert(editor.document.isDirty);
}

exports.run = async function run() {
    const extension = vscode.extensions.getExtension('leekmny.cguard');
    assert(extension, 'CGuard must be installed from the VSIX');
    assert.equal(extension.packageJSON.version, process.env.CGUARD_TEST_VERSION);
    const extensionsDirectory = await fs.realpath(process.env.CGUARD_TEST_EXTENSIONS);
    const installedPath = await fs.realpath(extension.extensionPath);
    assert.equal(path.dirname(installedPath), extensionsDirectory,
        'CGuard must load from the isolated extensions directory');

    const [workspace] = vscode.workspace.workspaceFolders ?? [];
    assert(workspace, 'The isolated fixture workspace must be open');
    const invalid = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(workspace.uri, 'array-out-of-bounds.c'));
    assert.equal(invalid.languageId, 'c');
    await vscode.window.showTextDocument(invalid);
    const [diagnostic] = await waitForDiagnostics(invalid, 1);
    const invalidDiagnostic = assertOutOfBounds(invalid, diagnostic);
    assert(extension.isActive, 'The installed CGuard must activate in the desktop extension host');

    const valid = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(workspace.uri, 'array-in-bounds.c'));
    assert.equal(valid.languageId, 'c');
    const validEditor = await vscode.window.showTextDocument(valid);
    await vscode.commands.executeCommand(command);
    assert.deepEqual(diagnosticsFor(valid), []);
    const validText = valid.getText();

    await replaceIndex(validEditor, '3');
    assert.deepEqual(diagnosticsFor(valid), []);
    await vscode.commands.executeCommand(command);
    const [manualResult] = await waitForDiagnostics(valid, 1);
    const manualDiagnostic = assertOutOfBounds(valid, manualResult);
    assert(valid.isDirty, 'The command must check the unsaved editor contents');

    await replaceIndex(validEditor, '2');
    assert(await valid.save());
    await waitForDiagnostics(valid, 0);
    await replaceIndex(validEditor, '3');
    assert(await valid.save());
    const [newDiagnostic] = await waitForDiagnostics(valid, 1);
    const savedInvalidDiagnostic = assertOutOfBounds(valid, newDiagnostic);

    const invalidEditor = await vscode.window.showTextDocument(invalid);
    await replaceIndex(invalidEditor, '2');
    assert(await invalid.save());
    assert.equal(await fs.readFile(invalid.uri.fsPath, 'utf8'), validText);
    await waitForDiagnostics(invalid, 0);

    await fs.writeFile(process.env.CGUARD_TEST_EVIDENCE, JSON.stringify({
        vscodeVersion: vscode.version,
        extensionId: extension.id,
        extensionVersion: extension.packageJSON.version,
        installedPath,
        extensionsDirectory,
        command,
        invalidDiagnostic,
        validDiagnosticCount: 0,
        manualDiagnostic,
        savedInvalidDiagnostic,
        fixedDiagnosticCount: diagnosticsFor(invalid).length,
    }));
};
