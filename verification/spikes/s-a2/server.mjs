// Throwaway. Serves dist/ on loopback. GET only: it has no way to receive a signature.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const types = { "index.html": "text/html; charset=utf-8", "page.js": "text/javascript; charset=utf-8" };
const server = createServer(async (req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  const path = new URL(req.url, "http://localhost").pathname;
  const file = path === "/" ? "index.html" : path.slice(1);
  if (!Object.hasOwn(types, file)) {
    res.writeHead(404).end();
    return;
  }
  const body = await readFile(new URL(`./dist/${file}`, import.meta.url));
  res.writeHead(200, { "Content-Type": types[file], "Cache-Control": "no-store" }).end(body);
});
server.listen(4173, "127.0.0.1", () => console.log("http://localhost:4173"));
