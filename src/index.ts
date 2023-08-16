import http from "http";
import fs from "fs/promises";
import WebSocket from "ws";

const server = http.createServer(async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.write("<script>const ws = new WebSocket();</script>");
    res.end();

    return;
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.write("404 error");
    res.end();
});
const wss = new WebSocket.Server({ server });

server.listen(61559);