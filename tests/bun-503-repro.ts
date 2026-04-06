/**
 * Minimal reproduction for Bun fetch 503 on localhost keep-alive
 */

const TARGET_PORT = 34567;
let server503Count = 0;
let client503Count = 0;
let total = 0;

const server = Bun.serve({
  port: TARGET_PORT,
  hostname: '127.0.0.1',
  fetch(req) {
    total++;
    return new Response(JSON.stringify({ ok: true, n: total }), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
});

console.log(`Server running on ${TARGET_PORT}`);

async function burst(count: number, delayMs: number) {
  const promises: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    promises.push(
      (async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${TARGET_PORT}/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index: i }),
          });
          const text = await res.text().catch(() => 'empty');
          if (res.status === 503) {
            client503Count++;
            console.log(`503 #${client503Count} at request ${i}, body="${text}"`);
          }
        } catch (err: any) {
          console.log(`Network error at request ${i}: ${err.message}`);
        }
      })()
    );
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  await Promise.all(promises);
}

// Run multiple bursts to stress keep-alive
(async () => {
  for (let round = 1; round <= 5; round++) {
    console.log(`\n--- Round ${round} ---`);
    await burst(200, 0);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`\nTotal server requests handled: ${total}`);
  console.log(`Client saw 503 count: ${client503Count}`);
  server.stop();
  process.exit(client503Count > 0 ? 1 : 0);
})();
