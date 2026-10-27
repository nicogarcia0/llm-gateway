// Starts the simulated backend and hands it to the fetch shim installed in <head>.
import { createDemo } from "./mock-api.js";

const demo = createDemo({ live: true });

window.__demoResolve(async (url, init) => {
  const u = new URL(url, location.href);
  let body;
  try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
  const { status, body: out } = await demo.handle((init.method || "GET").toUpperCase(), u.pathname, body);
  return new Response(JSON.stringify(out), { status, headers: { "content-type": "application/json" } });
});

setInterval(() => { if (!document.hidden) demo.tick(); }, 900);
