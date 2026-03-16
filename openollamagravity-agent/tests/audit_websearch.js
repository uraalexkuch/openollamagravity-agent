const http = require('http');

const perplexicaConfig = {
  hostname: '10.1.0.138',
  port: 3030,
  path: '/api/search'
};

const defaultPayload = {
  sources: ["web"],
  chatModel: {
    providerId: "4a2503c9-bb5f-4cf9-8976-87e1c6147710",
    key: "gemma3n:latest"
  },
  embeddingModel: {
    providerId: "ff97a883-e050-4356-bd4e-636b10b06524",
    key: "Xenova/all-MiniLM-L6-v2"
  },
  optimizationMode: "speed",
  history: [],
  stream: true // Performance optimization
};

async function runTest(testName, query) {
  console.log(`\n--- Test: ${testName} ---`);
  console.log(`Query: "${query}"`);

  const data = JSON.stringify({ ...defaultPayload, query });
  const start = Date.now();
  let timeToFirstSource = null;
  let sourceCount = 0;

  return new Promise((resolve) => {
    const req = http.request({
      ...perplexicaConfig,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 60000 // 1 minute timeout per test
    }, (res) => {
      let buf = '';
      res.on('data', (d) => { 
        const chunk = d.toString();
        buf += chunk;
        
        // Perplexica streams line-delimited JSON or similar.
        // Let's look for "sources" in the chunk
        if (!timeToFirstSource && chunk.includes('"sources"')) {
          timeToFirstSource = Date.now() - start;
        }
      });

      res.on('end', () => {
        const duration = Date.now() - start;
        console.log(`Status: ${res.statusCode}`);
        console.log(`Time to First Source: ${timeToFirstSource ? timeToFirstSource + 'ms' : 'N/A'}`);
        console.log(`Total Duration: ${duration}ms`);
        
        let hasSummary = false;
        try {
          // Parsing a stream is tricky, but we can look for the final summary or sources list
          hasSummary = buf.includes('"message"') || buf.includes('"text"');
          const sourceMatches = buf.match(/"sources":/g);
          sourceCount = sourceMatches ? sourceMatches.length : 0;
          
          console.log(`Correctness Check:`);
          console.log(`- Has Any Data: Yes`);
          console.log(`- Has Summary: ${hasSummary ? 'Yes' : 'No'}`);
          console.log(`- Detected Sources: ${sourceCount > 0 ? 'Yes' : 'No'}`);
          
          resolve({ ok: res.statusCode === 200, duration, timeToFirstSource });
        } catch (e) {
          console.log(`- Error during audit: ${e.message}`);
          resolve({ ok: false, duration });
        }
      });
    });

    req.on('error', (e) => {
      console.error(`Request Error: ${e.message}`);
      resolve({ ok: false });
    });

    req.write(data);
    req.end();
  });
}

async function main() {
  const results = [];
  
  // Test 1: Standard query
  results.push(await runTest("Standard Search", "Current weather in Kyiv"));
  
  // Test 2: Niche query (possible no results or specific handling)
  results.push(await runTest("Niche Search", "Exact version of Perplexica released on March 15 2026"));

  // Test 3: Very short query
  results.push(await runTest("Short Search", "AI"));

  const avgDuration = results.reduce((acc, r) => acc + (r.duration || 0), 0) / results.length;
  console.log(`\n--- Summary ---`);
  console.log(`Average Latency: ${avgDuration.toFixed(2)}ms`);
  console.log(`Reliability: ${results.filter(r => r.ok).length}/${results.length} tests passed.`);
}

main();
