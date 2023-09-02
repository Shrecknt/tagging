import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import URL from "node:url";
import WebSocket from "ws";
import mime from "mime";
import formidable from "formidable";
import { handleWebsocketMessage, writeUserFile, websocketEvents } from "./websocket";
import * as DB from "./database";
import * as Auth from "./auth";
import { allowedMimeTypes } from "./database/file";

const server = http.createServer(async (req, res) => {
    const url = URL.parse(req.url ?? "/");

    const ip = req.headers["cf-connecting-ip"]?.toString() ?? req.headers["x-forwarded-for"]?.toString() ?? "unknown";

    const cookies = parseCookies(req.headers["cookie"]);
    const [authorized, user] = await Auth.checkAuthorization(cookies["Authorization"]);

    if (authorized) {
        if (!user.ips.has(ip)) {
            user.ips.add(ip);
            await user.writeChanges();
        }
    }

    const highContentEndpoints = ["/upload"];
    const isHighContentEndpoint = highContentEndpoints.includes(url.pathname ?? "/");

    if (isHighContentEndpoint && !authorized) {
        res.writeHead(403, { "Content-Type": "text/plain" });
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
            const { username: _username, password: _password } = fields;
            const username = _username[0], password = _password[0];
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
            const hashedPassword = await Auth.generatePasswordHash(password);
            let user = await new DB.User(username, hashedPassword).writeChanges();
            const sessionToken = Auth.createSession(user, 3600000);
            res.writeHead(303, { "Location": "/profile", "Set-Cookie": `Authorization=${encodeURIComponent(sessionToken)}; SameSite=Strict; Secure; HttpOnly; Expires=${new Date(Date.now() + 3600000).toUTCString()}` });
            res.write("Account successfully created");
            res.end();
            return;
        }

        if (url.pathname === "/login" && !authorized) {
            const { username: _username, password: _password } = fields;
            const username = _username[0], password = _password[0];
            if (username === undefined || password === undefined) {
                res.writeHead(303, { "Location": "/login?error=0&username=" + encodeURIComponent(username ?? "") });
                res.write("Invalid username or password");
                res.end();
                return;
            }
            const user = await DB.User.fromUsername(username);
            if (user === undefined) {
                res.writeHead(303, { "Location": "/login?error=1&username=" + encodeURIComponent(username ?? "") });
                res.write("No account was found with the given username");
                res.end();
                return;
            }
            const passwordHash = user.password;
            const correctPassword = await Auth.checkPasswordHash(password, passwordHash);
            if (!correctPassword) {
                res.writeHead(303, { "Location": "/login?error=2&username=" + encodeURIComponent(username ?? "") });
                res.write("Incorrect password");
                res.end();
                return;
            }

            const sessionToken = Auth.createSession(user, 3600000);

            res.writeHead(303, { "Location": "/profile", "Set-Cookie": `Authorization=${encodeURIComponent(sessionToken)}; SameSite=Strict; Secure; HttpOnly; Expires=${new Date(Date.now() + 3600000).toUTCString()}` });
            res.write("Sign in successful!");
            res.end();
            return;
        }

        if (url.pathname === "/upload" && authorized) {
            const uploadedFile = files["uploadFile"];
            if (uploadedFile.length !== 1) {
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

            const fileId = await DB.UserFile.generateFileId();
            res.writeHead(303, { "Location": /*`/file/${user.userid}/${fileId}`*/ `/postupload?userid=${encodeURIComponent(user.userId)}&fileid=${encodeURIComponent(fileId)}` });
            res.write("Uploading...");
            res.end();
            /* Write file to disk, this will be changed later */
            await writeUserFile(
                fileId,
                user.userId,
                file.filepath,
                fields["public"][0] === "on"
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
                fields["public"][0] === "on",
                file.size);
            await userFile.writeChanges();
            return;
        }


        res.writeHead(404, { "Content-Type": "text/plain" });
        res.write("Unknown endpoint for POST request and current state");
        res.end();
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

    if (url.pathname === "/") url.pathname = "/index.html";
    const webPath = path.resolve("web/");
    let requestPath = path.join(webPath, url.pathname ?? "/index.html");
    if (!/\.[a-zA-Z]+/g.test(requestPath)) requestPath += ".html";
    if (!requestPath.startsWith(webPath)) {
        return;
    }
    try {
        if (!(await fs.stat(requestPath)).isFile()) {
            throw 0;
        }
    } catch (e) {
        let file = await fs.readFile("web/404.html");
        res.writeHead(404, { "Content-Type": "text/html" });
        res.write(file);
        res.end();
        return;
    }

    let file: Buffer | string = await fs.readFile(requestPath);
    const mimeType = mime.getType(requestPath);
    if (mimeType === "text/html") {
        file = file.toString();
    }
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
    if (url.pathname === "/") url.pathname = "/index.html";
    const authorizedWebPath = path.resolve("authorized_web/");
    let requestPath = path.join(authorizedWebPath, url.pathname ?? "/index.html");
    if (!/\.[a-zA-Z]+/g.test(requestPath)) requestPath += ".html";
    if (!requestPath.startsWith(authorizedWebPath)) {
        return false;
    }
    try {
        if (!(await fs.stat(requestPath)).isFile()) {
            return false;
        }
    } catch (e) { return false; }

    let file: Buffer | string = await fs.readFile(requestPath);
    const mimeType = mime.getType(requestPath);
    if (mimeType === "text/html") {
        file = file.toString();
    }
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
    if (pathNameArr.splice(0, 2)[1] !== "file") return false;
    if (pathNameArr.length !== 2) return false;
    const fileUserId = pathNameArr[0];
    const fileId = pathNameArr[1];

    // console.log(fileUserId, fileId);

    const userFilesPath = path.resolve("user_files/");
    // const requestDataPath = path.join(userFilesPath, fileUserId + "/", "data/", fileId);
    const requestRawPath = path.join(userFilesPath, fileUserId + "/", "raw/", fileId);

    const userFile = await DB.UserFile.fromFileId(fileId);
    if (userFile === undefined) return false;
    if (userFile.userId !== fileUserId) return false;

    if (!userFile._public && user?.userId !== fileUserId) return false;

    let mimeType = userFile.mimeType ?? "text/plain";
    if (!allowedMimeTypes.includes(mimeType)) {
        mimeType = "text/plain";
    }
    const fileName = userFile.fileName;

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
    const [authorized, user] = await Auth.checkAuthorization(cookies["Authorization"]);

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
    if (!fsSync.existsSync("user_files/")) await fs.mkdir("user_files");
    await DB.User.updateUsers();
    server.listen(61559);

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

main().then(console.log).catch(console.error);
