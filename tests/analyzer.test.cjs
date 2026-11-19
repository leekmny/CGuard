const assert = require('node:assert/strict');
const test = require('node:test');
const { analyzeText } = require('../out/analyzer.js');

async function findingsFor(source, rule) {
  return (await analyzeText(source)).filter((finding) => finding.rule === rule);
}

function highlight(source, finding) {
  return source.slice(finding.start, finding.end);
}

test('reports an array read at the first out-of-bounds index on line three', async () => {
  const source = 'int main(void) {\n    int items[3] = {0};\n    return items[3];\n}\n';
  const findings = await analyzeText(source);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'array-index-out-of-bounds');
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings[0].start, source.lastIndexOf('3'));
  assert.equal(highlight(source, findings[0]), '3');
  assert.match(findings[0].advice, /0.+2/);
});

test('checks integer literal bounds on each tracked array dimension', async () => {
  const source = 'int f(void) { int a[2][03] = {{0}}; a[0][0x3] = 1; return a[-1][1]; }';
  const findings = await findingsFor(source, 'array-index-out-of-bounds');

  assert.deepEqual(findings.map((finding) => highlight(source, finding)), ['0x3', '-1']);
});

test('accepts legal indexes, runtime indexes, address formation and unused expressions', async () => {
  const source = `int f(int i) {
    int a[2] = {0};
    int *end = &a[2];
    return a[0] + a[1] + a[i] + sizeof(a[2]) + (int)(end - a);
  }`;

  assert.deepEqual(await analyzeText(source), []);
});

test('permits exactly one-past the end only when forming an address', async () => {
  const source = 'int f(void) { int a[2]; int *end = &a[2], *far = &(a[3]); return a[2]; }';
  const findings = await findingsFor(source, 'array-index-out-of-bounds');

  assert.deepEqual(findings.map((finding) => highlight(source, finding)), ['3', '2']);
  assert.match(findings[0].advice, /0.+2/);
  assert.match(findings[1].advice, /0.+1/);
});

test('uses the outer array bound when elements happen to be pointers', async () => {
  const source = `int f(int index) {
    int (*pointer_to_array)[2];
    int *array_of_pointers[2];
    return pointer_to_array[5][index] + array_of_pointers[2][index];
  }`;
  const findings = await findingsFor(source, 'array-index-out-of-bounds');

  assert.deepEqual(findings.map((finding) => finding.start), [source.lastIndexOf('2')]);
});

test('ignores comments, C string contents and macro syntax as array references', async () => {
  const source = `#define BAD a[50]
  #define IDX 20
  #define DROP(value) 0
  int f(void) {
    int a[2] = {0};
    /* return a[20]; */
    const char *s = "a[20]";
    return a[IDX] + s[0] + DROP(a[20]);
  }`;

  assert.deepEqual(await analyzeText(source), []);
});

test('resolves local redeclarations, multiple declarators and shadowing parameters', async () => {
  const source = `int a[2];
  int f(int a[6]) { return a[4]; }
  int g(void) {
    int a[2] = {0}, b[2] = {0};
    { int a[6] = {0}; a[4] = 1; }
    { int *a = b; a[3] = 1; }
    for (int *a = b; 0;) { a[3] = 1; }
    return a[4] + b[2];
  }`;
  const findings = await findingsFor(source, 'array-index-out-of-bounds');

  assert.deepEqual(findings.map((finding) => finding.start), [
    source.lastIndexOf('a[4]') + 2,
    source.lastIndexOf('b[2]') + 2,
  ]);
});

test('treats a conditional declaration as an unknown shadow', async () => {
  const source = `int a[2];
  int f(void) {
  #ifdef FEATURE
    int a[6];
  #endif
    return a[4];
  }`;

  assert.deepEqual(await analyzeText(source), []);
});

test('reports exact UTF-16 offsets after an emoji and Korean characters', async () => {
  const source = 'int f(void) { int a[2] = {0}; /* 🧩 배열 */ return a[2]; }\r\n';
  const findings = await findingsFor(source, 'array-index-out-of-bounds');

  assert.equal(findings.length, 1);
  assert.equal(findings[0].start, source.lastIndexOf('2'));
  assert.equal(highlight(source, findings[0]), '2');
});

test('reports a parser error for a missing semicolon at the end of an expression', async () => {
  const source = 'int f(void) { return 1 }\n';
  const findings = await findingsFor(source, 'syntax-error');

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings[0].start, source.indexOf('1') + 1);
  assert.ok(findings[0].advice);
});

test('reports a plain local scalar return before any initialization', async () => {
  const source = 'int f(void) { int result; return result; }';
  const findings = await findingsFor(source, 'uninitialized-read');

  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'warning');
  assert.equal(findings[0].start, source.lastIndexOf('result'));
  assert.equal(highlight(source, findings[0]), 'result');
});

test('leaves initialized, static, escaped and branch-assigned variables alone', async () => {
  const source = `void fill(int *);
  int f(void) { int n; n = 1; return n; }
  int g(void) { static int n; return n; }
  int h(void) { int n; fill(&n); return n; }
  int j(int i) { int n; if (i) n = 1; return n; }
  int k(void) { int n = 1; return n; }
  int l(void) { int n = 1; { int n = 2; return n; } }
  `;

  assert.deepEqual(await analyzeText(source), []);
});
