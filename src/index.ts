import http from "node:http";
import fs from "node:fs/promises";
import fsSync, { PathLike } from "node:fs";
import path from "node:path";
import URL from "node:url";
import WebSocket from "ws";
import mime from "mime";
import ejs from "ejs";
import { minify } from "html-minifier";
import { handleWebsocketMessage, websocketEvents } from "./websocket";
import * as DB from "./database";
import { allowedMimeTypes } from "./database/file";
import { handleApiRequest } from "./api";
import { handleForm } from "./forms";

require("dotenv").config();

let options: {[key: string]: string | undefined} = {};

const server = http.createServer(async (req, res) => {
    const url = URL.parse(req.url ?? "/");

    const ip = req.headers["cf-connecting-ip"]?.toString() ?? req.headers["x-forwarded-for"]?.toString() ?? "unknown";

    const cookies = parseCookies(req.headers["cookie"]);
    const [authorized, user] = await DB.Session.checkAuthorization(cookies["Authorization"]);

    await DB.Logs.info(authorized ? user : null, "Connection to '{}' from {}", url.pathname ?? "", ip);

    if (authorized) {
        if (!user.ips.has(ip)) {
            user.ips.add(ip);
            await user.writeChanges();
        }
    }

    const highContentEndpoints = ["/upload"];
    const isHighContentEndpoint = highContentEndpoints.includes(url.pathname ?? "/");

    if (isHighContentEndpoint && !authorized) {
        res.writeHead(303, { "Location": "/login" });
        res.write("Authorization is required for this endpoint");
        res.end();
        return;
    }

    if (url.pathname?.startsWith("/api/")) {
        try {
            let success = await handleApiRequest(req, res, ip, cookies, user, authorized, url);
            if (success) return;
        } catch (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write(JSON.stringify({ "error": String(err), "data": {} }, null, 4));
            res.end();
            return;
        }
    }

    if (req.method === "POST") {
        const stack = "Call Stack:" + (new Error().stack)?.substring(5);
        try {
            await handleForm(req, res, ip, cookies, user, authorized, url);
        } catch (err) {
            res.write(await renderErrorPage(url.pathname ?? "unknown", {
                ip, cookies, user, url, options
            }, err, stack));
            res.end();
            return;
        }
    }

    if (authorized && user.permissionLevel >= 5) {
        let success = await handleAdminRequest(req, res, ip, cookies, user);
        if (success) return;
    }

    if (authorized) {
        let success = await handleAuthorizedRequest(req, res, ip, cookies, user);
        if (success) return;
    }

    {
        let success = await handleUserFileRequest(req, res, url, ip, cookies, user);
        if (success) return;
    }

    if (url.pathname === "/amiauthorized") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write(`authorized: ${authorized ? "yes" : "no"}\nsigned in as: ${authorized ? user.username : "none"}`);
        res.end();
        return;
    }

    if (authorized && ["/signup", "/login"].includes(url.pathname ?? "")) {
        res.writeHead(303, { "Location": "/profile" });
        res.write("redirecting to /profile");
        res.end();
    }

    if (!authorized && ["/profile", "/upload", "/search"].includes(url.pathname ?? "")) {
        res.writeHead(303, { "Location": "/login" });
        res.write("redirecting to /login");
        res.end();
    }

    if (url.pathname === "/") url.pathname = "/index.ejs";
    const webPath = path.resolve("web/");
    let requestPath = path.join(webPath, url.pathname ?? "/index.ejs");
    if (!requestPath.startsWith(webPath)) return;
    requestPath = await getLink(requestPath);
    if (!/\.[a-zA-Z]+/g.test(requestPath)) requestPath += ".ejs";
    try {
        if (!(await fs.stat(requestPath)).isFile()) {
            throw 0;
        }
    } catch (e) {
        let file = await renderPage("web/404.ejs", { ip, cookies, user, url, options });
        res.writeHead(404, { "Content-Type": "text/html" });
        res.write(file);
        res.end();
        return;
    }

    let file: Buffer | string = requestPath.endsWith(".ejs")
        ? await renderPage(requestPath, { ip, cookies, user, url, options })
        : await fs.readFile(requestPath);
    const mimeType = requestPath.endsWith(".ejs") ? "text/html" : mime.getType(requestPath);
    res.writeHead(200, { "Content-Type": mimeType ?? "text/plain" });
    res.write(file);
    res.end();
});

async function getLink(requestPath: string): Promise<string> {
    const originalPath = requestPath;
    if (!requestPath.endsWith(".link")) requestPath += ".link";
    let exists = false;
    try {
        exists = fsSync.statSync(requestPath).isFile();
    } catch (e) {}
    if (exists) {
        const contents = (await fs.readFile(requestPath)).toString();
        const linkPath = path.resolve(contents.trim());
        return linkPath;
    }
    return originalPath;
}

async function handleAuthorizedRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ip: string,
    cookies: { [key: string]: string | undefined },
    user: DB.User
): Promise<boolean> {
    const url = URL.parse(req.url ?? "/");
    if (url.pathname === "/") url.pathname = "/index.ejs";
    const authorizedWebPath = path.resolve("authorized_web/");
    let requestPath = path.join(authorizedWebPath, url.pathname ?? "/index.ejs");
    if (!/\.[a-zA-Z]+/g.test(requestPath)) requestPath += ".ejs";
    if (!requestPath.startsWith(authorizedWebPath)) {
        return false;
    }
    try {
        if (!(await fs.stat(requestPath)).isFile()) {
            return false;
        }
    } catch (e) { return false; }

    let file: Buffer | string = requestPath.endsWith(".ejs")
        ? await renderPage(requestPath, { ip, cookies, user, url, options })
        : await fs.readFile(requestPath);
    const mimeType = requestPath.endsWith(".ejs") ? "text/html" : mime.getType(requestPath);
    res.writeHead(200, { "Content-Type": mimeType ?? "text/plain" });
    res.write(file);
    res.end();
    return true;
}

async function handleAdminRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ip: string,
    cookies: { [key: string]: string | undefined },
    user: DB.User
): Promise<boolean> {
    if (user.permissionLevel < 5) return false;
    const url = URL.parse(req.url ?? "/");
    if (url.pathname === "/") url.pathname = "/index.ejs";
    const adminWebPath = path.resolve("admin_web/");
    let requestPath = path.join(adminWebPath, url.pathname ?? "/index.ejs");
    if (!/\.[a-zA-Z]+/g.test(requestPath)) requestPath += ".ejs";
    if (!requestPath.startsWith(adminWebPath)) {
        return false;
    }
    try {
        if (!(await fs.stat(requestPath)).isFile()) {
            return false;
        }
    } catch (e) { return false; }

    let file: Buffer | string = requestPath.endsWith(".ejs")
        ? await renderPage(requestPath, { ip, cookies, user, url, options, DB })
        : await fs.readFile(requestPath);
    const mimeType = requestPath.endsWith(".ejs") ? "text/html" : mime.getType(requestPath);
    res.writeHead(200, { "Content-Type": mimeType ?? "text/plain" });
    res.write(file);
    res.end();
    return true;
}

async function handleUserFileRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL.UrlWithStringQuery,
    ip: string,
    cookies: { [key: string]: string | undefined },
    user: DB.User | undefined
): Promise<boolean> {
    // url must be /file/*

    let pathNameArr = (url.pathname ?? "/").split("/");
    const isShortUrl = pathNameArr[1] === "f";
    if (!["file", "f"].includes(pathNameArr.splice(0, 2)[1])) return false;

    let fileUserId: string;
    let fileId: string;
    let userFile: DB.UserFile | undefined;
    if (isShortUrl) {
        userFile = await DB.UserFile.fromShortUrl(pathNameArr[0]);
        if (userFile === undefined) return false;
        fileUserId = userFile.userId;
        fileId = userFile.fileId;
    } else {
        if (pathNameArr.length !== 2) return false;
        fileUserId = pathNameArr[0];
        fileId = pathNameArr[1];
        if (fileId.endsWith(".gif")) fileId = fileId.substring(0, fileId.length - 4);
        userFile = await DB.UserFile.fromFileId(fileId);
        if (userFile === undefined) return false;
    }
    const shortUrl = userFile.shortUrl;

    // console.log(fileUserId, fileId);

    const userFilesPath = path.resolve(process.env["STORAGE_DIRECTORY"] ?? "user_files/");
    // const requestDataPath = path.join(userFilesPath, fileUserId + "/", "data/", fileId);
    const requestRawPath = path.join(userFilesPath, fileUserId + "/", "raw/", fileId);

    if (userFile.userId !== fileUserId) return false;

    if (userFile.visibility < 1 && user?.userId !== fileUserId) return false;

    let mimeType = userFile.mimeType ?? "text/plain";
    if (!allowedMimeTypes.includes(mimeType)) {
        mimeType = "text/plain";
    }
    const fileName = userFile.fileName;

    if (url.query !== "direct" && url.query !== "direct.gif") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.write(
            await renderPage("web/viewer.ejs", {
                fileUserId, fileId, fileName, mimeType, userFile, isShortUrl, shortUrl,
                ip, cookies, user, url, options
            })
        );
        res.end();
        return true;
    }

    // const stat = fsSync.statSync(requestRawPath);

    // const range = req.headers.range;
    // if (range) {
    //     const parts = range.replace(/bytes=/, "").split("-");
    //     const start = parseInt(parts[0], 10);
    //     const end = Math.min(start + (64 * 1024) - 1, stat.size - 1); // parts[1] ? parseInt(parts[1], 10) : Math.min(stat.size - 1, start + (1024 * 1024))/* (stat.size - 1) */;
    //     const chunkSize = (end - start) + 1;

    //     // console.log("range", range, "start", start, "end", end, "chunkSize", chunkSize);

    //     res.writeHead(206, {
    //         "Content-Type": mimeType,
    //         "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    //         "Accept-Ranges": "bytes",
    //         "Content-Length": chunkSize,
    //         "Content-Disposition": `filename="${encodeURIComponent(fileName)}"`
    //     });
    //     const fileStream = fsSync.createReadStream(requestRawPath, { start, end });
    //     fileStream.once("open", () => {
    //         fileStream.pipe(res);
    //     });
    //     // fileStream.once("close", () => console.log("Closed 2"));
    //     // fileStream.on("end", () => res.end());

    //     // res.write(await fs.readFile(requestRawPath));
    //     // res.end();
    // } else {
    //     res.writeHead(200, {
    //         "Content-Type": mimeType,
    //         "Content-Length": stat.size,
    //         "Content-Disposition": `filename="${encodeURIComponent(fileName)}"`
    //     });
    //     fsSync.createReadStream(requestRawPath).pipe(res).once("close", () => console.log("Closed"));
    // }

    res.writeHead(200, {
        "Content-Type": mimeType ?? "text/plain",
        "Content-Disposition": `filename="${encodeURIComponent(fileName)}"`
    });

    res.write(await fs.readFile(requestRawPath));
    res.end();

    return true;
}

const wss = new WebSocket.Server({ server });

wss.on("connection", async (socket, req) => {
    const cookies = parseCookies(req.headers["cookie"]);
    const url = URL.parse(req.url ?? "/");
    // console.log("new connection", cookies);
    const [authorized, user] = await DB.Session.checkAuthorization(cookies["Authorization"]);

    socket.on("message", (data, isBinary) => {
        // console.log("new message", isBinary ? data : data.toString());
        handleWebsocketMessage(socket, url, cookies, authorized, user, data, isBinary);
    });
});

function parseCookies(str: string | undefined) {
    return (str ?? "").split(";").map(item => item.trim().split("=")).reduce((acc, val) => {
        acc[val[0]] = decodeURIComponent(val.splice(1).join("=")) || undefined;
        return acc;
    }, {} as { [key: string]: string | undefined });
}

export async function reloadOptions() {
    options = JSON.parse((await fs.readFile("options.json")).toString());
}

async function main() {
    if (!fsSync.existsSync("options.json")) {
        console.log("Options not found, copying example config");
        await fs.copyFile("options.json.example", "options.json");
    }

    await reloadOptions();

    if (options.siteName === undefined) throw new Error("siteName must be set in options");
    if (options.domain === undefined) throw new Error("domain must be set in options");

    if (!fsSync.existsSync(process.env["STORAGE_DIRECTORY"] ?? "user_files/")) await fs.mkdir(process.env["STORAGE_DIRECTORY"] ?? "user_files/");
    await DB.User.updateUsers();
    const port = process.env["PORT"] ?? 61559;
    server.listen(port);

    return `Webserver started on http://127.0.0.1:${port}/`;
}

const renderFunctions = {
    sanitizeParams: (contents: string) => {
        return contents.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
    }
};

const shouldMinify = true;
async function renderPage(path: PathLike, ejsData?: ejs.Data, endOnError: boolean = false): Promise<string> {
    const data = {...(ejsData ?? {}), ...renderFunctions} as ejs.Data;
    const stack = "Call Stack:" + (new Error().stack)?.substring(5);
    try {
        const contents = await fs.readFile(path);
        const result = await ejs.render(contents.toString(), data, { async: true });
        const minified = minify(result, {
            collapseWhitespace: shouldMinify,
            minifyJS: shouldMinify,
            minifyCSS: shouldMinify,
        });
        return minified;
    } catch (err) {
        if (endOnError) {
            console.error(err);
            return "A fatal error has occurred, check console.";
        } else {
            return await renderErrorPage(path, data, err, stack);
        }
    }
}

async function renderErrorPage(path: PathLike, data: ejs.Data | undefined, err: unknown, stack: string): Promise<string> {
    if (typeof data === "object") {
        data["ip"] = "[REDACTED]";
        data["cookies"] = "[REDACTED]";
        if (data["DB"] !== undefined) data["DB"] = "[REDACTED]";
        if (data["user"] !== undefined) {
            data["user"]["password"] = "[REDACTED]";
        }
    }
    return await renderPage("web/render_error.ejs", { error: err, stack, path, data, url: data?.url ?? URL.parse(""), options }, true);
}

main().then(console.log).catch(console.error);
