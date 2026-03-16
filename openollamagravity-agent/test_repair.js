function repairJson(raw) {
  // 1. Ensure it's wrapped in braces if it looks like a key-value list but isn't wrapped
  let result = raw.trim();
  if (result && !result.startsWith('{') && result.includes(':')) {
    result = '{' + result + '}';
  }

  // 2. Fix unquoted keys or keys with single quotes
  result = result.replace(/([{,]\s*)(['"]?)([a-zA-Z0-9_$-]+)\2\s*:/g, '$1"$3":');

  // 3. Fix values with single quotes
  result = result.replace(/:\s*'([^']*)'/g, (_, inner) => ': "' + inner.replace(/"/g, '\\"') + '"');
  result = result.replace(/,\s*'([^']*)'/g, (_, inner) => ', "' + inner.replace(/"/g, '\\"') + '"');

  // 4. Handle Windows paths and control characters inside strings
  let finalResult = '';
  let inString = false;
  let i = 0;

  while (i < result.length) {
    const ch = result[i];

    if (!inString) {
      if (ch === '"') { inString = true; }
      finalResult += ch;
      i++;
      continue;
    }

    // Inside string
    if (ch === '\n') {
      finalResult += '\\n';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\t') {
      finalResult += '\\t';
      i++;
      continue;
    }

    if (ch === '\\') {
      const next = result[i + 1] ?? '';
      // If it's a valid JSON escape sequence, keep it
      if (/["\\\/bfnrtu]/.test(next)) {
        finalResult += ch + next;
        i += 2;
      } else if (next === 'u') {
        // Handle unicode escape
        finalResult += ch + result.slice(i + 1, i + 6);
        i += 6;
      } else {
        // It's a single backslash (likely Windows path), escape it
        finalResult += '\\\\';
        i++;
      }
      continue;
    }

    if (ch === '"') {
      inString = false;
    }
    finalResult += ch;
    i++;
  }

  return finalResult;
}

const tests = [
  'path: "D:\\\\web_project\\\\NewSiteAdmin\\\\package.json"',
  '{ path: "D:\\\\web_project\\\\NewSiteAdmin\\\\package.json" }',
  '{"path": "D:\\web_project\\file.txt"}', // Single backslash
  'text: \'Hello world\', count: 5',
  '{\n  "code": "print(\\"hello\\")",\n  "file": "main.py"\n}'
];

tests.forEach(t => {
  console.log('--- TEST ---');
  console.log('Input:', t);
  const repaired = repairJson(t);
  console.log('Repaired:', repaired);
  try {
    JSON.parse(repaired);
    console.log('Valid JSON: ✅');
  } catch (e) {
    console.log('Valid JSON: ❌ (' + e.message + ')');
  }
});
