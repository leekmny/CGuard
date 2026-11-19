const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resolveCliArgsFromVSCodeExecutablePath, runTests } = require('@vscode/test-electron');

const repository = path.resolve(__dirname, '../..');

async function findVSCode() {
    if (process.env.CGUARD_VSCODE_PATH) {
        return fs.realpath(process.env.CGUARD_VSCODE_PATH);
    }

    const windows = process.platform === 'win32';
    const launcher = windows ? 'code.cmd' : 'code';
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!directory) continue;

        const cli = await fs.realpath(path.join(directory, launcher)).catch(() => undefined);
        if (!cli) continue;

        const relativeExecutable = windows ? '../Code.exe'
            : process.platform === 'darwin' ? '../../../MacOS/Electron' : '../code';
        const executable = await fs.realpath(path.resolve(path.dirname(cli), relativeExecutable)).catch(() => undefined);
        if (executable) return executable;
    }

    throw new Error('Could not find VS Code Desktop. Set CGUARD_VSCODE_PATH to its executable.');
}

function installVsix(executable, testDirectory) {
    const [cli] = resolveCliArgsFromVSCodeExecutablePath(executable);
    const args = ['--install-extension', 'cguard-under-test.vsix', '--extensions-dir', 'extensions',
        '--user-data-dir', 'user-data'];
    const options = { cwd: testDirectory, stdio: 'inherit', windowsHide: true };

    if (process.platform === 'win32') {
        // cmd.exe runs the vendor's .cmd launch script. All arguments are fixed
        // relative paths, and the shell expands the CLI path as a quoted value.
        execFileSync(process.env.ComSpec ?? 'cmd.exe', [
            '/d', '/s', '/v:off', '/c', `""%CGUARD_TEST_CLI%" ${args.join(' ')}"`,
        ], { ...options, env: { ...process.env, CGUARD_TEST_CLI: cli }, windowsVerbatimArguments: true });
    } else {
        execFileSync(cli, args, options);
    }
}

async function main() {
    const [input] = process.argv.slice(2);
    assert(input, 'Usage: node tests/vscode/run.cjs <path-to-VSIX>');
    const vsix = await fs.realpath(input);
    const executable = await findVSCode();
    const { version, engines } = require('../../package.json');
    const tempRoot = await fs.realpath(os.tmpdir());
    const testDirectory = await fs.mkdtemp(path.join(tempRoot, 'cguard-vscode-'));
    assert.equal(path.dirname(testDirectory), tempRoot);

    try {
        const extensions = path.join(testDirectory, 'extensions');
        const userData = path.join(testDirectory, 'user-data');
        const userSettings = path.join(userData, 'User');
        const probe = path.join(testDirectory, 'probe');
        const workspace = path.join(testDirectory, 'workspace');
        const evidencePath = path.join(testDirectory, 'evidence.json');
        await Promise.all([extensions, userSettings, probe, workspace].map((directory) =>
            fs.mkdir(directory, { recursive: true })));
        await Promise.all([
            fs.copyFile(vsix, path.join(testDirectory, 'cguard-under-test.vsix')),
            fs.copyFile(path.join(__dirname, 'suite.cjs'), path.join(probe, 'suite.cjs')),
            fs.cp(path.join(repository, 'fixtures'), workspace, { recursive: true }),
            fs.writeFile(path.join(userSettings, 'settings.json'), JSON.stringify({
                'chat.disableAIFeatures': true,
            })),
            fs.writeFile(path.join(probe, 'package.json'), JSON.stringify({
                name: 'cguard-vsix-probe', publisher: 'local-test', version: '0.0.0', engines,
                main: './suite.cjs',
            })),
        ]);

        installVsix(executable, testDirectory);
        const exitCode = await runTests({
            vscodeExecutablePath: executable,
            extensionDevelopmentPath: probe,
            extensionTestsPath: path.join(probe, 'suite.cjs'),
            launchArgs: [workspace, `--extensions-dir=${extensions}`, `--user-data-dir=${userData}`,
                '--new-window', '--disable-telemetry'],
            extensionTestsEnv: {
                CGUARD_TEST_EXTENSIONS: extensions,
                CGUARD_TEST_VERSION: version,
                CGUARD_TEST_EVIDENCE: evidencePath,
            },
        });
        assert.equal(exitCode, 0);

        const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
        const vsixSha256 = createHash('sha256')
            .update(await fs.readFile(path.join(testDirectory, 'cguard-under-test.vsix'))).digest('hex');
        const output = `${JSON.stringify({ vsix, vsixSha256, ...evidence }, null, 2)}\n`;
        if (process.env.CGUARD_QA_OUTPUT) {
            await fs.writeFile(process.env.CGUARD_QA_OUTPUT, output);
        }
        process.stdout.write(output);
    } finally {
        await fs.rm(testDirectory, { recursive: true, force: true, maxRetries: 10 });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
