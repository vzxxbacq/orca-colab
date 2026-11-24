import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";

// Stand-ins that live in the test process, so no test leaves this machine: an HTTP CONNECT proxy and a
// SOCKS5 proxy that send named hosts to local ports and refuse everything else.

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function track(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  return () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
}

// `routes`: { "relay.test:443": localPort }. `requireAuth`: the Proxy-Authorization header to insist on.
export async function startConnectProxy({ routes = {}, requireAuth = null } = {}) {
  const connects = [];
  const server = http.createServer((_req, res) => res.writeHead(405).end());
  const close = track(server);
  server.on("connect", (req, client, head) => {
    connects.push(req.url);
    client.on("error", () => {});
    if (requireAuth && req.headers["proxy-authorization"] !== requireAuth) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
      return;
    }
    const port = routes[req.url];
    if (!port) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, port, connects, routes, close };
}

export async function startSocksProxy({ routes = {} } = {}) {
  const connects = [];
  const server = net.createServer((client) => {
    let stage = "greeting";
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (stage === "greeting" && buffered.length >= 2 + buffered[1]) {
        buffered = buffered.subarray(2 + buffered[1]);
        client.write(Buffer.from([5, 0]));
        stage = "request";
      }
      if (stage === "request" && buffered.length >= 5 && buffered.length >= 7 + buffered[4]) {
        const host = buffered.subarray(5, 5 + buffered[4]).toString();
        const target = `${host}:${buffered.readUInt16BE(5 + buffered[4])}`;
        connects.push(target);
        stage = "piped";
        client.off("data", onData);
        const port = routes[target];
        if (!port) {
          client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const upstream = net.connect(port, "127.0.0.1", () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
      }
    };
    client.on("data", onData);
  });
  const close = track(server);
  const port = await listen(server);
  return { url: `socks5://127.0.0.1:${port}`, port, connects, close };
}

// An HTTP server that also accepts websockets the way a Jupyter terminal does: one "stdout" frame once
// the client has spoken. `upgrades` records the headers each websocket arrived with.
export async function startOriginServer({ createServer = http.createServer, handler } = {}) {
  const upgrades = [];
  const server = createServer(handler);
  const close = track(server);
  server.on("upgrade", (req, socket) => {
    upgrades.push({ url: req.url, host: req.headers.host, token: req.headers["x-colab-runtime-proxy-token"] ?? null });
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const text = Buffer.from(JSON.stringify(["stdout", "hello from the runtime"]));
    socket.once("data", () => socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text])));
  });
  const port = await listen(server);
  return { port, upgrades, close };
}

// A self-signed certificate for relay.test and runtime.test, valid until 2126. It protects nothing: it
// exists so the tests can run TLS through the tunnel.
export const TEST_ONLY_CERT = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUZyX2RxDjIpJsMLTV8cxu31JlZ54wCgYIKoZIzj0EAwIw
HzEdMBsGA1UEAwwUb3JjYS1jb2xhYiB0ZXN0IG9ubHkwIBcNMjYxMTI0MDgyMzQz
WhgPMjEyNjEwMzEwODIzNDNaMB8xHTAbBgNVBAMMFG9yY2EtY29sYWIgdGVzdCBv
bmx5MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEECXa3/6SF8EEjzDN0cgaDIeP
h2btemUzw+zBTyOQ27g7AeSjrSmbGSIgY0Jo/uzixbcPRpkbJ12Xl6KJZO7+4KNX
MFUwHQYDVR0OBBYEFBmL4JVfV0G9oBrutvec5ovyN7YfMA8GA1UdEwEB/wQFMAMB
Af8wIwYDVR0RBBwwGoIKcmVsYXkudGVzdIIMcnVudGltZS50ZXN0MAoGCCqGSM49
BAMCA0gAMEUCIAhlktojHyXNsIiriLjxHfqhfeJRtMhjKxNXyZczp3p4AiEA44mg
ipzaMyuxQ2NgBf5NoMPnCQiQW2EMYGsVkY8oye4=
-----END CERTIFICATE-----
`;
export const TEST_ONLY_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgxt3zH26Ky1uPZpXj
1Tu7x8HngrVBUuoa6rYsWHmOrJWhRANCAAQQJdrf/pIXwQSPMM3RyBoMh4+HZu16
ZTPD7MFPI5DbuDsB5KOtKZsZIiBjQmj+7OLFtw9GmRsnXZeXoolk7v7g
-----END PRIVATE KEY-----
`;
