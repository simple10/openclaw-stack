// WebSocket proxy that injects Cloudflare Access service token headers
// into the upstream WebSocket upgrade request.
//
// Listens on localhost:18789, proxies to wss://<GATEWAY_DOMAIN>.
// The openclaw node host connects here instead of directly to the gateway.

import { WebSocketServer, WebSocket } from "ws";
import https from "node:https";

const LISTEN_PORT = 18789;
const GATEWAY_DOMAIN = process.env.GATEWAY_DOMAIN;
const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID;
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;

if (!GATEWAY_DOMAIN) {
  console.error("[ws-proxy] GATEWAY_DOMAIN not set");
  process.exit(1);
}

if (!CF_ACCESS_CLIENT_ID || !CF_ACCESS_CLIENT_SECRET) {
  console.warn("[ws-proxy] CF_ACCESS_CLIENT_ID/SECRET not set — connecting without CF Access headers");
}

const wss = new WebSocketServer({ port: LISTEN_PORT, maxPayload: 25 * 1024 * 1024 });

console.log(`[ws-proxy] Listening on localhost:${LISTEN_PORT} → wss://${GATEWAY_DOMAIN}`);
console.log(`[ws-proxy] CF Access Client ID: ${CF_ACCESS_CLIENT_ID ? CF_ACCESS_CLIENT_ID.slice(0, 8) + "..." : "(not set)"}`);

wss.on("connection", (client) => {
  const headers = {};
  if (CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = CF_ACCESS_CLIENT_SECRET;
  }

  const remote = new WebSocket(`wss://${GATEWAY_DOMAIN}`, {
    headers,
    maxPayload: 25 * 1024 * 1024,
  });

  let clientAlive = true;
  let remoteAlive = false;

  remote.on("upgrade", (res) => {
    console.log(`[ws-proxy] Upgrade response: ${res.statusCode}`);
  });

  remote.on("unexpected-response", (req, res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      console.error(`[ws-proxy] Unexpected response: ${res.statusCode} ${res.statusMessage}`);
      if (res.headers.location) {
        console.error(`[ws-proxy] Redirect → ${res.headers.location.slice(0, 120)}`);
      }
      if (res.statusCode === 302 || res.statusCode === 403) {
        console.error(`[ws-proxy] CF Access rejected the request — check service token and Access policy`);
      }
      if (body) console.error(`[ws-proxy] Body: ${body.slice(0, 200)}`);
      if (clientAlive) client.close(1001, `upstream ${res.statusCode}`);
    });
  });

  remote.on("open", () => {
    remoteAlive = true;
    console.log(`[ws-proxy] Connected to gateway`);

    client.on("message", (data, isBinary) => {
      if (remoteAlive) remote.send(data, { binary: isBinary });
    });
    remote.on("message", (data, isBinary) => {
      if (clientAlive) client.send(data, { binary: isBinary });
    });
  });

  remote.on("close", (code, reason) => {
    remoteAlive = false;
    console.log(`[ws-proxy] Remote closed (${code}): ${reason}`);
    if (clientAlive) client.close(code, reason);
  });

  remote.on("error", (err) => {
    console.error(`[ws-proxy] Remote error: ${err.message}`);
    if (clientAlive) client.close(1001, "upstream error");
  });

  client.on("close", (code, reason) => {
    clientAlive = false;
    if (remoteAlive) remote.close(code, reason);
  });

  client.on("error", (err) => {
    console.error(`[ws-proxy] Client error: ${err.message}`);
    if (remoteAlive) remote.close(1001, "client error");
  });
});
