import http from "http";
import fs from "fs/promises";
import WebSocket from "ws";
import path from "path";
import bcrypt from "bcrypt";
import { write } from "fs";

const server = http.createServer(async (req, res) => {
    const ip = req.headers["cf-connecting-ip"]?.toString() ?? "not-cloudflare";

    const cookies = parseCookies(req.headers["cookie"]);
    const [authorized, user] = await checkAuthorization(cookies["Authorization"]);

    if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1e8) {
                console.log("Connection destroyed");
                req.socket.destroy();
            }
        });
        req.on("end", async () => {
            const data = parseFormData(body);
            // console.log("data", data);
            if (req.url === "/signup" && !authorized) {
                const { username, password } = data;
                if (username === undefined || password === undefined) {
                    res.write("Invalid username or password");
                    res.end();
                    return;
                }
                if (await getUserByName(username) !== undefined) {
                    res.write("User with same name already exists");
                    res.end();
                    return;
                }
                const hashedPassword = await generatePasswordHash(password);
                let user = await writeUser(username, hashedPassword, new Set([ip]));
                const sessionToken = createSession(user.userid, 3600000);
                res.writeHead(303, { "Location": "/profile", "Set-Cookie": `Authorization=${encodeURIComponent(sessionToken)}; SameSite=Strict; Secure; HttpOnly` });
                res.write("Account successfully created");
                res.end();
            }

            if (req.url === "/login" && !authorized) {
                const { username, password } = data;
                if (username === undefined || password === undefined) {
                    res.write("Invalid username or password");
                    res.end();
                    return;
                }
                const user = await getUserByName(username);
                if (user === undefined) {
                    res.write("No account was found with the given username");
                    res.end();
                    return;
                }
                const passwordHash = user.password;
                const correctPassword = await checkPasswordHash(password, passwordHash);
                if (!correctPassword) {
                    res.write("Incorrect password");
                    res.end();
                    return;
                }

                const sessionToken = createSession(user.userid, 3600000);

                res.writeHead(303, { "Location": "/profile", "Set-Cookie": `Authorization=${encodeURIComponent(sessionToken)}; SameSite=Strict; Secure; HttpOnly` });
                // res.write("Sign in successful!");
                res.end();
            }
        });

        return;
    }

    switch (req.url) {
        case "/test":
            res.writeHead(200, { "Content-Type": "text/html" });
            res.write(await fs.readFile("web/test.html"));
            res.end();
            break;
        case "/login":
            res.writeHead(200, { "Content-Type": "text/html" });
            res.write(await fs.readFile("web/login.html"));
            res.end();
            break;
        case "/signup":
            res.writeHead(200, { "Content-Type": "text/html" });
            res.write(await fs.readFile("web/signup.html"));
            res.end();
            break;
        case "/amiauthorized":
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.write(`authorized: ${authorized ? "yes" : "no"}\nsigned in as: ${authorized ? user?.username : "none"}`);
            res.end();
            break;
        default:
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.write("404 error");
            res.end();
    };
});

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

server.listen(61559);

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

loadUsers().then(console.log).catch(console.error);
