import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import URL from "node:url";
import WebSocket from "ws";
import bcrypt from "bcrypt";
import mime from "mime";
import formidable from "formidable";
import { generateUserFileId, handleWebsocketMessage, writeUserFile, websocketEvents } from "./websocket";

const server = http.createServer(async (req, res) => {
    const url = URL.parse(req.url ?? "/");

    const ip = req.headers["cf-connecting-ip"]?.toString() ?? "not-cloudflare";
    // console.log("ip", ip);

    const cookies = parseCookies(req.headers["cookie"]);
    const [authorized, user] = await checkAuthorization(cookies["Authorization"]);

    if (authorized) {
        if (!user.ips.has(ip)) {
            user.ips.add(ip);
            await updateUser(user);
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

        // console.log("fields", fields /*, "files", files*/ );

        if (url.pathname === "/signup" && !authorized) {
            const { username, password } = fields;
            if (username[0] === undefined
                || password[0] === undefined
                || username[0].includes("\n")
                || password[0].includes("\n")
                || !/^[!-~]{3,16}$/m.test(username[0])
                || !/^[!-~]{5,32}$/m.test(password[0])
            ) {
                res.writeHead(303, { "Location": "/signup?error=0&username=" + encodeURIComponent(username[0] ?? "") });
                res.write("Invalid username or password");
                res.end();
                return;
            }
            if (await getUserByName(username[0]) !== undefined) {
                res.writeHead(303, { "Location": "/signup?error=1&username=" + encodeURIComponent(username[0] ?? "") });
                res.write("User with same name already exists");
                res.end();
                return;
            }
            const hashedPassword = await generatePasswordHash(password[0]);
            let user = await writeUser(username[0], hashedPassword, new Set([ip]));
            const sessionToken = createSession(user.userid, 3600000);
            res.writeHead(303, { "Location": "/profile", "Set-Cookie": `Authorization=${encodeURIComponent(sessionToken)}; SameSite=Strict; Secure; HttpOnly; Expires=${new Date(Date.now() + 3600000).toUTCString()}` });
            res.write("Account successfully created");
            res.end();
            return;
        }

        if (url.pathname === "/login" && !authorized) {
            const { username, password } = fields;
            if (username[0] === undefined || password[0] === undefined) {
                res.writeHead(303, { "Location": "/login?error=0&username=" + encodeURIComponent(username[0] ?? "") });
                res.write("Invalid username or password");
                res.end();
                return;
            }
            const user = await getUserByName(username[0]);
            if (user === undefined) {
                res.writeHead(303, { "Location": "/login?error=1&username=" + encodeURIComponent(username[0] ?? "") });
                res.write("No account was found with the given username");
                res.end();
                return;
            }
            const passwordHash = user.password;
            const correctPassword = await checkPasswordHash(password[0], passwordHash);
            if (!correctPassword) {
                res.writeHead(303, { "Location": "/login?error=2&username=" + encodeURIComponent(username[0] ?? "") });
                res.write("Incorrect password");
                res.end();
                return;
            }

            const sessionToken = createSession(user.userid, 3600000);

            res.writeHead(303, { "Location": "/profile", "Set-Cookie": `Authorization=${encodeURIComponent(sessionToken)}; SameSite=Strict; Secure; HttpOnly; Expires=${new Date(Date.now() + 3600000).toUTCString()}` });
            res.write("Sign in successful!");
            res.end();
            return;
        }

        if (url.pathname === "/upload" && authorized) {
            // console.log("files[\"uploadFile\"]", files["uploadFile"]);
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

            const fileId = await generateUserFileId(user.userid);
            res.writeHead(303, { "Location": /*`/file/${user.userid}/${fileId}`*/ `/postupload?userid=${encodeURIComponent(user.userid)}&fileid=${encodeURIComponent(fileId)}` });
            res.write("Uploading...");
            res.end();
            // console.log(file.filepath);
            await writeUserFile(fileId, user.userid, file.originalFilename ?? "unknown", [], file.filepath, fields["public"][0] === "on");
            // console.log("Uploaded to " + url);
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
    user: User
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
    user: User | undefined
): Promise<boolean> {
    // url must be /file/*
    // console.log("getting file");

    let pathNameArr = (url.pathname ?? "/").split("/");
    if (pathNameArr.splice(0, 2)[1] !== "file") return false;
    if (pathNameArr.length !== 2) return false;
    const fileUserId = pathNameArr[0];
    const fileId = pathNameArr[1];

    // console.log(fileUserId, fileId);

    const userFilesPath = path.resolve("user_files/");
    const requestDataPath = path.join(userFilesPath, fileUserId + "/", "data/", fileId);
    const requestRawPath = path.join(userFilesPath, fileUserId + "/", "raw/", fileId);
    if (!requestDataPath.startsWith(path.join(userFilesPath, fileUserId))) return false;
    try {
        if (!(await fs.stat(requestDataPath)).isFile()) {
            throw 0;
        }
    } catch (e) { return false; }

    const metaData = JSON.parse((await fs.readFile(requestDataPath)).toString());
    if (!metaData.public && user?.userid !== fileUserId) return false;
    const mimeType = metaData.mimeType;
    const fileName = metaData.fileName;

    res.writeHead(200, { "Content-Type": mimeType, "Content-Disposition": `filename="${encodeURIComponent(fileName)}"` });
    res.write(await fs.readFile(requestRawPath));
    res.end();

    return true;
}

function parseFormData(str: string | undefined) {
    return (str ?? "").split("&").map(item => item.trim().split("=")).reduce((acc, val) => {
        acc[val[0]] = decodeURIComponent(val.splice(1).join("=")) || undefined;
        return acc;
    }, {} as { [key: string]: string | undefined });
}

const wss = new WebSocket.Server({ server });

wss.on("connection", async (socket, req) => {
    const cookies = parseCookies(req.headers["cookie"]);
    const url = URL.parse(req.url ?? "/");
    // console.log("new connection", cookies);
    const [authorized, user] = await checkAuthorization(cookies["Authorization"]);

    socket.on("message", (data, isBinary) => {
        // console.log("new message", isBinary ? data : data.toString());
        handleWebsocketMessage(socket, url, cookies, authorized, user, data, isBinary);
    });
});

const saltRounds = 10;
async function generatePasswordHash(password: string) {
    return await bcrypt.hash(password, saltRounds);
}
async function checkPasswordHash(password: string, passwordHash: string) {
    return await bcrypt.compare(password, passwordHash);
}

function parseCookies(str: string | undefined) {
    return (str ?? "").split(";").map(item => item.trim().split("=")).reduce((acc, val) => {
        acc[val[0]] = decodeURIComponent(val.splice(1).join("=")) || undefined;
        return acc;
    }, {} as { [key: string]: string | undefined });
}

type User = { username: string, userid: string, password: string, ips: Set<string> };
type AccessToken = { expires: number, user: User };
const accessTokens: { [key: string]: AccessToken | undefined } = {};
const users: { [key: string]: User | undefined } = {};

async function checkAuthorization(token: string | undefined): Promise<[false, undefined | User] | [true, User]> {
    if (token === undefined) return [false, undefined];
    if (token.includes("\n")) return [false, undefined];
    if (!/[a-zA-Z0-9]{128}/m.test(token)) return [false, undefined];
    const accessToken = accessTokens[token];
    if (accessToken === undefined) return [false, undefined];
    const user = await getUser(accessToken.user.userid);
    if (user === undefined) throw new Error("Access token found but not user (what?)");
    if (accessToken.expires < Date.now()) {
        delete accessTokens[token];
        return [false, user];
    }
    return [true, user];
}

const accessTokenChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function createSession(userId: string, expiresIn: number) {
    const user = users[userId];
    if (user === undefined) throw new Error("Unknown user");
    let sessionToken = "";
    do {
        sessionToken = Array.from(Array(128), () => accessTokenChars[Math.floor(Math.random() * accessTokenChars.length)]).join("");
    } while (Object.keys(accessTokens).includes(sessionToken));
    const newSession = {
        expires: Date.now() + expiresIn,
        user: user
    } as AccessToken;
    accessTokens[sessionToken] = newSession;
    return sessionToken;
}

setInterval(() => {
    for (let session in accessTokens) {
        if ((accessTokens[session]?.expires ?? 0) < Date.now()) {
            delete accessTokens[session];
        }
    }
}, 60000);

async function loadUsers() {
    const userFiles = await fs.readdir("users");
    for (let userFile of userFiles) {
        await loadUser(userFile);
    }
    return "Done loading users";
}

async function loadUser(userId: string) {
    if (userId.endsWith(".json")) userId = userId.substring(0, userId.length - 5);
    const user = JSON.parse((await fs.readFile(path.join("users/", userId + ".json"))).toString());
    users[userId] = {
        username: user.username,
        userid: user.userid,
        password: user.password,
        ips: new Set(user.ips)
    } as User;
}

const userIdChars = "0123456789";
async function writeUser(username: string, hashedPassword: string, ips: Set<string>) {
    let userId = "";
    do {
        userId = Array.from(Array(32), () => userIdChars[Math.floor(Math.random() * userIdChars.length)]).join("");
    } while (Object.keys(users).includes(userId));
    const user = {
        username: username,
        userid: userId,
        password: hashedPassword,
        ips: [...ips] as unknown as Set<string>
    } as User;
    await fs.writeFile(path.join("users/", userId + ".json"), JSON.stringify(user, null, 4));
    users[userId] = user;
    return user;
}

async function updateUser(user: User) {
    const writeUser = {
        username: user.username,
        userid: user.userid,
        password: user.password,
        ips: [...user.ips] as unknown as Set<string>
    } as User;
    await fs.writeFile(path.join("users/", user.userid + ".json"), JSON.stringify(writeUser, null, 4));
    users[user.userid] = user;
    return user;
}

async function getUser(userId: string) {
    if (users[userId] === undefined) {
        await loadUser(userId);
    }
    return users[userId];
}

async function getUserByName(username: string) {
    for (let userId in users) {
        let user = users[userId];
        if (user === undefined) continue;
        if (user.username.toLowerCase() === username.toLowerCase()) return user;
    }
    return undefined;
}

async function main() {
    if (!fsSync.existsSync("users/")) await fs.mkdir("users");
    if (!fsSync.existsSync("user_files/")) await fs.mkdir("user_files");
    await loadUsers();
    server.listen(61559);

    return "Main function complete";
}

main().then(console.log).catch(console.error);
