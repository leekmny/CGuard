import { Buffer } from 'node:buffer';
import * as vscode from 'vscode';
import type { Finding } from './analyzer.js';

const maxSourceBytes = 512 * 1024;

export function activate(context: vscode.ExtensionContext): void {
    const diagnostics = vscode.languages.createDiagnosticCollection('cguard');
    const pending = new Map<vscode.TextDocument, symbol>();

    function clear(document: vscode.TextDocument): void {
        if (isLocalCFile(document)) {
            pending.delete(document);
            diagnostics.delete(document.uri);
        }
    }

    async function check(document: vscode.TextDocument | undefined, manual = false): Promise<void> {
        if (!document || document.isClosed || !isLocalCFile(document)) {
            if (manual) {
                void vscode.window.showInformationMessage('Open a local .c file to run CGuard.');
            }
            return;
        }

        const request = Symbol();
        const version = document.version;
        pending.set(document, request);
        const isCurrent = () => pending.get(document) === request &&
            document.version === version && !document.isClosed;

        try {
            const source = document.getText();
            if (Buffer.byteLength(source, 'utf8') > maxSourceBytes) {
                diagnostics.delete(document.uri);
                if (manual) {
                    void vscode.window.showInformationMessage('CGuard can check C files up to 512 KiB.');
                }
                return;
            }

            let findings: Finding[] = [];
            if (source.trim()) {
                const { analyzeText } = await import('./analyzer.js');
                if (!isCurrent()) {
                    return;
                }
                findings = await analyzeText(source);
            }
            if (isCurrent()) {
                diagnostics.set(document.uri, findings.map(finding => toDiagnostic(document, finding)));
                if (manual && findings.length === 0) {
                    void vscode.window.showInformationMessage('CGuard found no issues in this file.');
                }
            }
        } catch (error) {
            if (isCurrent()) {
                diagnostics.delete(document.uri);
                console.error('[CGuard] Analysis failed:', error);
                if (manual) {
                    void vscode.window.showErrorMessage('CGuard could not analyze this file. See the Extension Host log for details.');
                }
            }
        } finally {
            if (pending.get(document) === request) {
                pending.delete(document);
            }
        }
    }

    context.subscriptions.push(
        new vscode.Disposable(() => pending.clear()),
        diagnostics,
        vscode.workspace.onDidOpenTextDocument(document => void check(document)),
        vscode.workspace.onDidSaveTextDocument(document => void check(document)),
        vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
            if (contentChanges.length > 0) {
                clear(document);
            }
        }),
        vscode.workspace.onDidCloseTextDocument(clear),
        vscode.commands.registerCommand('cguard.checkCurrentFile', () =>
            check(vscode.window.activeTextEditor?.document, true)),
    );

    for (const document of vscode.workspace.textDocuments) {
        void check(document);
    }
}

function isLocalCFile(document: vscode.TextDocument): boolean {
    return document.uri.scheme === 'file' && document.uri.path.toLowerCase().endsWith('.c');
}

function toDiagnostic(document: vscode.TextDocument, finding: Finding): vscode.Diagnostic {
    const range = new vscode.Range(document.positionAt(finding.start), document.positionAt(finding.end));
    const severity = finding.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
    const diagnostic = new vscode.Diagnostic(range, `${finding.message}\n${finding.advice}`, severity);
    diagnostic.source = 'CGuard';
    diagnostic.code = finding.rule;
    return diagnostic;
}
