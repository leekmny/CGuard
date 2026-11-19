import { join } from 'node:path';
import { Language, Node, Parser } from 'web-tree-sitter';
import { analyzeSource, isConditionalDirective } from './rules-source';

export interface Finding {
  rule: string;
  severity: 'error' | 'warning';
  message: string;
  advice: string;
  start: number;
  end: number;
}

let languagePromise: Promise<Language> | undefined;

export async function analyzeText(source: string): Promise<Finding[]> {
  languagePromise ??= Parser.init()
    .then(() => Language.load(join(__dirname, 'tree-sitter-c.wasm')))
    .catch((error: unknown) => {
      languagePromise = undefined;
      throw error;
    });

  const language = await languagePromise;
  const parser = new Parser();
  let tree: ReturnType<Parser['parse']> = null;
  try {
    parser.setLanguage(language);
    tree = parser.parse(source);
    if (!tree) {
      throw new Error('CGuard could not parse the document.');
    }

    const findings: Finding[] = [];
    addSyntaxFindings(tree.rootNode, findings);
    analyzeSource(tree.rootNode, findings);
    return findings.sort((a, b) => a.start - b.start || a.end - b.end);
  } finally {
    tree?.delete();
    parser.delete();
  }
}

function addSyntaxFindings(node: Node, findings: Finding[]): void {
  if (isConditionalDirective(node.type)) {
    return;
  }
  if (node.isError || node.isMissing) {
    findings.push({
      rule: 'syntax-error',
      severity: 'error',
      message: node.isMissing ? `Expected ${JSON.stringify(node.type)}.` : 'C syntax could not be parsed here.',
      advice: node.isMissing
        ? `Check whether ${JSON.stringify(node.type)} belongs at this position.`
        : 'Check the delimiters and tokens near this location.',
      start: node.startIndex,
      end: node.endIndex,
    });
    return;
  }
  if (node.hasError) {
    for (const child of node.children) {
      addSyntaxFindings(child, findings);
    }
  }
}
