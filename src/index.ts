import http from "node:http";
import fs from "node:fs/promises";
import fsSync, { PathLike } from "node:fs";
import path from "node:path";
import URL from "node:url";
import WebSocket from "ws";
import mime from "mime";
import formidable from "formidable";
import ejs, { render } from "ejs";
import { minify } from "html-minifier";
import { handleWebsocketMessage, websocketEvents } from "./websocket";
import * as DB from "./database";
import { allowedMimeTypes } from "./database/file";
import { handleApiRequest } from "./api";

require("dotenv").config();

const server = http.createServer(async (req, res) => {
    const url = URL.parse(req.url ?? "/");

    const ip = req.headers["cf-connecting-ip"]?.toString() ?? req.headers["x-forwarded-for"]?.toString() ?? "unknown";

    const cookies = parseCookies(req.headers["cookie"]);
    const [authorized, user] = await DB.Session.checkAuthorization(cookies["Authorization"]);

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

    if (req.method === "POST") {
        const form = formidable({});
        let fields: formidable.Fields;
        let files: formidable.Files;
        try {
            [fields, files] = await form.parse(req);
        } catch (err) {
            console.error(err);
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end();
            return;
        }

        if (url.pathname === "/signup" && !authorized) {
            const [ username, password ] = [ fields.username[0], fields.password[0] ];
            if (username === undefined
                || password === undefined
                || username.includes("\n")
                || password.includes("\n")
                || !/^[!-~]{3,16}$/m.test(username)
                || !/^[!-~]{5,32}$/m.test(password)
            ) {
                res.writeHead(303, { "Location": "/signup?error=0&username=" + encodeURIComponent(username ?? "") });
                res.write("Invalid username or password");
                res.end();
                return;
            }
            if (await DB.User.fromUsername(username) !== undefined) {
                res.writeHead(303, { "Location": "/signup?error=1&username=" + encodeURIComponent(username ?? "") });
                res.write("User with same name already exists");
                res.end();
                return;
            }
            const hashedPassword = await DB.generatePasswordHash(password);
            let user = await new DB.User(username, hashedPassword).writeChanges();
            const sessionToken = (await DB.Session.createSession(user, 3600000)).sessionId;
            res.writeHead(303, { "Location": "/profile", "Set-Cookie": `Authorization=${encodeURIComponent(sessionToken)}; SameSite=Strict; Secure; HttpOnly; Expires=${new Date(Date.now() + 3600000).toUTCString()}` });
            res.write("Account successfully created");
            res.end();
            return;
        }

        if (url.pathname === "/login" && !authorized) {
            const [ username, password ] = [ fields.username[0], fields.password[0] ];
            if (username === undefined || password === undefined) {
                res.writeHead(303, { "Location": "/login?error=0&username=" + encodeURIComponent(username ?? "") });
                res.end();
                return;
            }
            const user = await DB.User.fromUsername(username);
            if (user === undefined) {
                res.writeHead(303, { "Location": "/login?error=0&username=" + encodeURIComponent(username ?? "") });
                res.end();
                return;
            }
            const passwordHash = user.password;
            const correctPassword = await DB.checkPasswordHash(password, passwordHash);
            if (!correctPassword) {
                res.writeHead(303, { "Location": "/login?error=0&username=" + encodeURIComponent(username ?? "") });
                res.end();
                return;
            }

            const sessionToken = (await DB.Session.createSession(user, 3600000)).sessionId;

            res.writeHead(303, { "Location": "/profile", "Set-Cookie": `Authorization=${encodeURIComponent(sessionToken)}; SameSite=Strict; Secure; HttpOnly; Expires=${new Date(Date.now() + 3600000).toUTCString()}` });
            res.write("Sign in successful!");
            res.end();
            return;
        }

        if (url.pathname === "/upload" && authorized) {
            if (user.permissionLevel < 1 && await user.getFileCount() >= 255) {
                res.writeHead(303, { "Location": "/upload" });
                res.write("Exceeded file limit");
                res.end();
                return;
            }
            const uploadedFile = files["uploadFile"];
            if (uploadedFile === undefined || uploadedFile.length !== 1) {
                res.writeHead(303, { "Location": "/upload" });
                res.write("Must provide 1 file");
                res.end();
                return;
            }
            const file = uploadedFile[0];

            if (file.size > 1000000000) {
                req.socket.destroy();
                return;
            }

            const suffix = (mime.getType(file.originalFilename ?? "") === "image/gif") ? ".gif" : "";
            const fileId = await DB.UserFile.generateFileId();
            res.writeHead(303, { "Location": /*`/file/${user.userid}/${fileId}`*/ `/postupload?userid=${encodeURIComponent(user.userId)}&fileid=${encodeURIComponent(fileId)}${suffix}` });
            res.write("Uploading...");
            res.end();
            /* Write file to disk, this will be changed later */
            await DB.writeUserFile(
                fileId,
                user.userId,
                file.filepath
            );
            /* Save file meta to database */
            const userFile = new DB.UserFile(
                fileId,
                user.userId,
                file.originalFilename
                    ?? "unknown",
                file.mimetype
                    || mime.getType(
                        file.originalFilename
                            ?? ""
                ),
                [],
                file.size,
                file.originalFilename ?? "no title",
                "",
                (fields["public"][0] === "on" ? 1 : 0),
                null
            );
            await userFile.writeChanges();
            return;
        }


        res.writeHead(404, { "Content-Type": "text/plain" });
        res.write("Unknown endpoint for POST request and current state");
        res.end();
    }

    if (url.pathname?.startsWith("/api/")) {
        try {
            let success = await handleApiRequest(req, res, ip, cookies, user, authorized, url);
            if (success) return;
        } catch (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.write(JSON.stringify({ "error": String(err) }));
            res.end();
            return;
        }
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
    if (!/\.[a-zA-Z]+/g.test(requestPath)) requestPath += ".ejs";
    if (!requestPath.startsWith(webPath)) {
        return;
    }
    try {
        if (!(await fs.stat(requestPath)).isFile()) {
            throw 0;
        }
    } catch (e) {
        let file = await renderPage("web/404.ejs", { ip, cookies, user });
        res.writeHead(404, { "Content-Type": "text/html" });
        res.write(file);
        res.end();
        return;
    }

    let file: Buffer | string = requestPath.endsWith(".ejs")
        ? await renderPage(requestPath, { ip, cookies, user })
        : await fs.readFile(requestPath);
    const mimeType = requestPath.endsWith(".ejs") ? "text/html" : mime.getType(requestPath);
    res.writeHead(200, { "Content-Type": mimeType ?? "text/plain" });
    res.write(file);
    res.end();
});

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
        ? await renderPage(requestPath, { ip, cookies, user })
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
                ip, cookies, user
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

async function main() {
    if (!fsSync.existsSync(process.env["STORAGE_DIRECTORY"] ?? "user_files/")) await fs.mkdir(process.env["STORAGE_DIRECTORY"] ?? "user_files/");
    await DB.User.updateUsers();
    server.listen(process.env["PORT"] ?? 61559);

    // Change this to `true` if you want
    // to move legacy user json files to
    // a database.
    const convertOldUsers = false;
    if (convertOldUsers) {
        const oldUsersDir = await fs.readdir("users");
        for (let file of oldUsersDir) {
            const contents = JSON.parse((await fs.readFile(path.join("users/", file))).toString());
            const user = DB.User.fromObject(contents);
            console.log(user);
            await user.writeChanges();
        }
    }

    return "Main function complete";
}

async function renderPage(path: PathLike, data?: ejs.Data, endOnError: boolean = false): Promise<string> {
    const stack = "Call Stack:" + (new Error().stack)?.substring(5);
    try {
        const contents = await fs.readFile(path);
        const result = await ejs.render(contents.toString(), data, { async: true });
        const minified = minify(result, {
            collapseWhitespace: true,
            minifyJS: true,
            minifyCSS: true,
        });
        return minified;
    } catch (err) {
        if (endOnError) {
            console.error(err);
            return "A fatal error has occurred, check console.";
        } else {
            if (typeof data === "object") {
                data["ip"] = "[REDACTED]";
                data["cookies"] = "[REDACTED]";
                if (data["user"] !== undefined) {
                    data["user"]["password"] = "[REDACTED]";
                }
            }
            return await renderPage("web/render_error.ejs", { error: err, stack, path, data }, true);
        }
    }
}

main().then(console.log).catch(console.error);
