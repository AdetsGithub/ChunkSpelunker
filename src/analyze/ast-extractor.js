import parser from '@babel/parser';
import _traverse from '@babel/traverse';
import { toPostmanTemplate, isPathLike } from './url-utils.js';
import { regexFallback } from './regex-fallback.js';

const traverse = _traverse.default || _traverse;

const HTTP_VERBS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'request',
]);

/**
 * @param {string} code
 * @param {string} sourceUrl
 */
export function extractFromCode(code, sourceUrl) {
  try {
    const ast = parser.parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: [
        'jsx',
        'typescript',
        'classProperties',
        'dynamicImport',
        'optionalChaining',
        'nullishCoalescingOperator',
        'objectRestSpread',
        'topLevelAwait',
      ],
    });
    const findings = [];
    traverse(ast, {
      CallExpression(path) {
        const hit = fromCallExpression(path.node);
        if (hit) {
          findings.push({
            ...hit,
            source: 'ast',
            confidence: 'high',
            evidence: { jsUrls: [sourceUrl], rawPath: hit.rawPath },
          });
        }
      },
      StringLiteral(path) {
        // Low-confidence harvest only for API-like paths outside calls (parent checked)
        if (path.parent.type === 'CallExpression' || path.parent.type === 'ObjectProperty') return;
        const val = path.node.value;
        if (!isPathLike(val)) return;
        if (!/\/(api|v\d+|graphql|rest)\b/i.test(val) && !val.startsWith('http')) return;
        findings.push({
          method: 'GET',
          rawPath: val,
          url: val,
          pathTemplate: toPostmanTemplate(val),
          queryParams: [],
          bodyParams: [],
          headers: {},
          source: 'ast',
          confidence: 'low',
          evidence: { jsUrls: [sourceUrl], rawPath: val },
        });
      },
      TemplateLiteral(path) {
        if (path.parent.type === 'CallExpression') return;
        const raw = templateToString(path.node);
        if (!raw || !isPathLike(raw)) return;
        if (!/\/(api|v\d+|graphql|rest)\b/i.test(raw) && !raw.startsWith('http')) return;
        findings.push({
          method: 'GET',
          rawPath: raw,
          url: raw,
          pathTemplate: toPostmanTemplate(raw),
          queryParams: [],
          bodyParams: [],
          headers: {},
          source: 'ast',
          confidence: 'low',
          evidence: { jsUrls: [sourceUrl], rawPath: raw },
        });
      },
    });

    // SPEC §9.5: if AST yields no hits, still run regex (comments, obfuscated literals)
    if (findings.length === 0) {
      return {
        findings: regexFallback(code, sourceUrl),
        engine: 'regex',
        degradedReason: 'ast-empty',
      };
    }
    return { findings, engine: 'ast' };
  } catch (err) {
    if (err instanceof RangeError || err instanceof SyntaxError) {
      return {
        findings: regexFallback(code, sourceUrl),
        engine: 'regex',
        degradedReason: err instanceof RangeError ? 'range-error' : 'syntax',
      };
    }
    return {
      findings: regexFallback(code, sourceUrl),
      engine: 'regex',
      degradedReason: 'syntax',
    };
  }
}

function fromCallExpression(node) {
  const callee = node.callee;
  const args = node.arguments || [];

  // fetch(url, init?)
  if (callee.type === 'Identifier' && callee.name === 'fetch') {
    const url = argToUrl(args[0]);
    if (!url) return null;
    const init = args[1];
    const method = objectProp(init, 'method') || 'GET';
    const headers = objectHeaders(init);
    const bodyParams = bodyKeys(objectPropNode(init, 'body'));
    return makeHit(method, url, headers, bodyParams);
  }

  // axios.get(url) / client.post(url) / $http.get
  if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
    const verb = callee.property.name.toLowerCase();
    if (HTTP_VERBS.has(verb)) {
      const url = argToUrl(args[0]) || configUrl(args[0]);
      if (!url) return null;
      const method = verb === 'request' ? objectProp(args[0], 'method') || 'GET' : verb;
      const headers = objectHeaders(args[0]) || objectHeaders(args[1]);
      const bodyParams =
        bodyKeys(objectPropNode(args[0], 'data')) ||
        bodyKeys(objectPropNode(args[1], 'data')) ||
        [];
      return makeHit(method, url, headers, bodyParams);
    }
  }

  // axios({ url, method })
  if (callee.type === 'Identifier' && /axios|request|api/i.test(callee.name)) {
    const url = configUrl(args[0]);
    if (!url) return null;
    const method = objectProp(args[0], 'method') || 'GET';
    return makeHit(method, url, objectHeaders(args[0]), bodyKeys(objectPropNode(args[0], 'data')));
  }

  // xhr.open(method, url)
  if (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'open'
  ) {
    const method = argToUrl(args[0]) || 'GET';
    const url = argToUrl(args[1]);
    if (!url) return null;
    return makeHit(method, url, {}, []);
  }

  return null;
}

function makeHit(method, url, headers, bodyParams) {
  return {
    method: String(method).toUpperCase(),
    rawPath: url,
    url,
    pathTemplate: toPostmanTemplate(url),
    queryParams: [],
    bodyParams: bodyParams || [],
    headers: headers || {},
  };
}

function argToUrl(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral') return templateToString(node);
  return null;
}

function templateToString(node) {
  let out = '';
  for (let i = 0; i < node.quasis.length; i++) {
    out += node.quasis[i].value.cooked ?? node.quasis[i].value.raw;
    if (i < node.expressions.length) {
      const expr = node.expressions[i];
      if (expr.type === 'Identifier') out += `\${${expr.name}}`;
      else if (expr.type === 'MemberExpression' && expr.property.type === 'Identifier') {
        out += `\${${expr.property.name}}`;
      } else out += '${param}';
    }
  }
  return out;
}

function configUrl(node) {
  if (!node || node.type !== 'ObjectExpression') return null;
  return objectProp(node, 'url');
}

function objectProp(node, key) {
  const prop = objectPropNode(node, key);
  return argToUrl(prop) || (prop?.type === 'StringLiteral' ? prop.value : null);
}

function objectPropNode(node, key) {
  if (!node || node.type !== 'ObjectExpression') return null;
  for (const p of node.properties) {
    if (p.type !== 'ObjectProperty') continue;
    const name =
      p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null;
    if (name === key) return p.value;
  }
  return null;
}

function objectHeaders(node) {
  const headersNode = objectPropNode(node, 'headers');
  if (!headersNode || headersNode.type !== 'ObjectExpression') return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const p of headersNode.properties) {
    if (p.type !== 'ObjectProperty') continue;
    const name =
      p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : null;
    if (!name) continue;
    const val = argToUrl(p.value);
    if (val) out[name] = val;
  }
  return out;
}

function bodyKeys(node) {
  if (!node) return [];
  // JSON.stringify({ a: 1 })
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'JSON' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'stringify'
  ) {
    return objectKeys(node.arguments[0]);
  }
  return objectKeys(node);
}

function objectKeys(node) {
  if (!node || node.type !== 'ObjectExpression') return [];
  const keys = [];
  for (const p of node.properties) {
    if (p.type !== 'ObjectProperty') continue;
    if (p.key.type === 'Identifier') keys.push(p.key.name);
    else if (p.key.type === 'StringLiteral') keys.push(p.key.value);
  }
  return keys;
}
