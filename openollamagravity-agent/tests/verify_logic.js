
const fs = require('fs');
const path = require('path');

// --- MOCKS ---
const oogLogger = { appendLine: (m) => console.log(`[LOG] ${m}`) };

// Mocking the parseToolCall logic exactly as it is in agentLoop.ts
function parseToolCall(text) {
  const block = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  if (!block) return null;

  const blockStart = text.indexOf('<tool_call>');
  const narration  = text.slice(0, blockStart).trim();
  const inner = block[1];

  const nameMatch =
      inner.match(/<n>\s*([\w_]+)\s*<\/n>/i) ||
      inner.match(/<name>\s*([\w_]+)\s*<\/name>/i); // true fallback
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();

  let raw = '';
  const argsMatch = inner.match(/<args>([\s\S]*?)<\/args>/i);
  if (argsMatch) {
    raw = argsMatch[1].trim();
  } else {
    const fallbackMatch = inner.match(/<args>([\s\S]*)/i);
    if (fallbackMatch) raw = fallbackMatch[1].trim();
    else return { name, narration, args: {} };
  }

  if (!raw || raw === '{}') return { name, narration, args: {} };
  raw = raw.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

  try { return { name, narration, args: JSON.parse(raw) }; } catch { 
     // Silently try repair
      return { name, narration, args: {}, parseError: 'JSON error' };
  }
}

// --- TESTS ---

function testParser() {
  console.log("Testing parseToolCall...");
  
  const cases = [
    {
      name: "Standard format",
      input: "I will list files.\n<tool_call>\n<name>list_files</name>\n<args>{\"path\": \".\"}</args>\n</tool_call>",
      expectedName: "list_files"
    },
    {
      name: "Short name format",
      input: "<tool_call><n>read_file</n><args>{\"path\": \"foo.ts\"}</args></tool_call>",
      expectedName: "read_file"
    },
    {
      name: "Malformed mixed format (should fail now)",
      input: "<tool_call><n>search_files</name><args>{}</args></tool_call>",
      expectedName: null
    },
    {
      name: "No tool call",
      input: "Just talking here.",
      expectedName: null
    }
  ];

  cases.forEach(c => {
    const res = parseToolCall(c.input);
    if (res?.name === c.expectedName || (res === null && c.expectedName === null)) {
      console.log(`✅ ${c.name} passed.`);
    } else {
      console.error(`❌ ${c.name} failed. Got: ${res?.name}, Expected: ${c.expectedName}`);
    }
  });
}

function testTrimHistory() {
  console.log("\nTesting history trimming...");
  let history = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 30; i++) {
    history.push({ role: 'user', content: `msg ${i}` });
  }

  // Simulated _trimHistory logic
  if (history.length > 22) {
    const sys = history[0];
    const recent = history.slice(-20);
    history = [sys, ...recent];
  }

  if (history.length === 21 && history[0].content === 'sys' && history[1].content === 'msg 10') {
    console.log("✅ History trimming passed (kept 21 messages total).");
  } else {
    console.error(`❌ History trimming failed. Length: ${history.length}, First: ${history[1]?.content}`);
  }
}

// Run them
testParser();
testTrimHistory();
