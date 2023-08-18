import http from "http";
import fs from "fs/promises";
import WebSocket from "ws";
import path from "path";
import bcrypt from "bcrypt";
import mime from "mime";
import URL from "url";

const server = http.createServer(async (req, res) => {
    const url = URL.parse(req.url ?? "/");

    const ip = req.headers["cf-connecting-ip"]?.toString() ?? "not-cloudflare";

    const cookies = parseCookies(req.headers["cookie"]);
    const [authorized, user] = await checkAuthorization(cookies["Authorization"]);

    const highContentEndpoints = ["/upload"];
    const isHighContentEndpoint = highContentEndpoints.includes(url.pathname ?? "/");

    if (isHighContentEndpoint && !authorized) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.write("Authorization is required for this endpoint");
        res.end();
        return;
    }

    if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (isHighContentEndpoint) {
                if (body.length > 1e8) {
                    console.log("Connection destroyed");
                    req.socket.destroy();
                }
            } else if (body.length > 1e6) {
                console.log("Connection destroyed");
                req.socket.destroy();
            }
        });
        req.on("end", async () => {
            const data = parseFormData(body);
            if (url.pathname === "/signup" && !authorized) {
                const { username, password } = data;
                if (username === undefined || password === undefined) {
                    res.writeHead(303, { "Location": "/signup?error=0&username=" + encodeURIComponent(username ?? "") });
                    res.write("Invalid username or password");
                    res.end();
                    return;
                }
                if (await getUserByName(username) !== undefined) {
                    res.writeHead(303, { "Location": "/signup?error=1&username=" + encodeURIComponent(username ?? "") });
                    res.write("User with same name already exists");
                    res.end();
                    return;
                }
                const hashedPassword = await generatePasswordHash(password);
                let user = await writeUser(username, hashedPassword, new Set([ip]));
                const sessionToken = createSession(user.userid, 3600000);
                res.writeHead(303, { "Location": "/profile", "Set-Cookie": `Authorization=${encodeURIComponent(sessionToken)}; SameSite=Strict; Secure; HttpOnly; Expires=${new Date(Date.now() + 3600000).toUTCString()}` });
                res.write("Account successfully created");
                res.end();
                return;
            }

            if (url.pathname === "/login" && !authorized) {
                const { username, password } = data;
                if (username === undefined || password === undefined) {
                    res.writeHead(303, { "Location": "/login?error=0&username=" + encodeURIComponent(username ?? "") });
                    res.write("Invalid username or password");
                    res.end();
                    return;
                }
                const user = await getUserByName(username);
                if (user === undefined) {
                    res.writeHead(303, { "Location": "/login?error=1&username=" + encodeURIComponent(username ?? "") });
                    res.write("No account was found with the given username");
                    res.end();
                    return;
                }
                const passwordHash = user.password;
                const correctPassword = await checkPasswordHash(password, passwordHash);
                if (!correctPassword) {
                    res.writeHead(303, { "Location": "/login?error=2&username=" + encodeURIComponent(username ?? "") });
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


            res.writeHead(404, { "Content-Type": "text/plain" });
            res.write("Unknown endpoint for POST request and current state");
            res.end();
        });

        return;
    }

    if (authorized) {
        if (user === undefined) {
            return;
        }
        const success = await handleAuthorizedRequest(req, res, ip, cookies, user);
        if (success) return;
    }

    if (url.pathname === "/amiauthorized") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write(`authorized: ${authorized ? "yes" : "no"}\nsigned in as: ${authorized ? user?.username : "none"}`);
        res.end();
        return;
    }

    if (authorized && (url.pathname === "/login" || url.pathname === "/signup")) {
        res.writeHead(303, { "Location": "/profile" });
        res.write("redirecting to /profile");
        res.end();
    }

    if (!authorized && url.pathname === "/profile") {
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

function parseFormData(str: string | undefined) {
    return (str ?? "").split("&").map(item => item.trim().split("=")).reduce((acc, val) => {
        acc[val[0]] = decodeURIComponent(val.splice(1).join("=")) || undefined;
        return acc;
    }, {} as { [key: string]: string | undefined });
}

const wss = new WebSocket.Server({ server });

wss.on("connection", async (socket, req) => {
    const cookies = parseCookies(req.headers["cookie"]);
    console.log("new connection", cookies);
    const [authorized, user] = await checkAuthorization(cookies["Authorization"]);

    socket.on("message", (data, isBinary) => {
        console.log("new message", isBinary ? data : data.toString());
        socket.send(data);
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

async function checkAuthorization(token: string | undefined): Promise<[boolean, User | undefined]> {
    if (token === undefined) return [false, undefined];
    if (token.includes("\n")) return [false, undefined];
    if (!/[a-zA-Z0-9]{128}/m.test(token)) return [false, undefined];
    const accessToken = accessTokens[token];
    if (accessToken === undefined) return [false, undefined];
    if (accessToken.expires < Date.now()) {
        delete accessTokens[token];
        return [false, await getUser(accessToken.user.userid)];
    }
    return [true, await getUser(accessToken.user.userid)];
}

const accessTokenChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function createSession(userId: string, expiresIn: number) {
    const user = users[userId];
    if (user == undefined) throw new Error("Unknown user");
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
        if (accessTokens[session]?.expires ?? 0 < Date.now()) {
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
        if (user.username === username) return user;
    }
    return undefined;
}

async function main() {
    await loadUsers();
    server.listen(61559);

    return "Main function complete";
}

main().then(console.log).catch(console.error);
